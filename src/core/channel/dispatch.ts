// ── 投递编排 ───────────────────────────────────────────────────────────────
// 「写一条消息」与「把它交给该看的人」是一次写入的两半：收件人由消息本身算出来
// （`recipientsOf`），投递正文又由这条消息拼出来。落盘在 `write.ts`，这里只负责叫醒。
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import { watchSettled } from "./unanswered.ts";
import type { Conversation, InputEntry, UserInput } from "../runtime/index.ts";
import { mergedNotice, renderDelivery, type DeliveryPrompt } from "./delivery.ts";
import { planAttachments } from "./attachments.ts";
import type { Channel, Message } from "./types.ts";
import type { WakeRecord, WakeTarget } from "./turn/record.ts";
import type { FinishTurn } from "./turn/index.ts";
import type { TextCatalog } from "../md/catalog.ts";

export type { WakeRecord } from "./turn/record.ts";

export type DeliverResult = {
	/** 真的进了队列的 slug。不代表已读。 */
	readonly delivered: string[];
	/** 连队列都没进的 slug（消息仍在频道里）。 */
	readonly failed: string[];
	/** 没有会话、或就是我本人，跳过的 slug。 */
	readonly skipped: string[];
	/**
	 * 这次合并唤醒的账：谁本来已经有一条「还没开始」的排队项，被这一条取代了。
	 *
	 * 消息一条都没删（都在频道里），少掉的只是**重复的唤醒**。
	 */
	readonly merged?: readonly { readonly slug: string; readonly count: number }[];
};

/** 一个「叫了但没人会答」的收件人。拼成频道里的 `note` 用，我才能看见系统做了什么。 */
export type DeliverIssue = {
	readonly slug: string;
	/** 「还没有会话」还是「投递抛错」。两者文案不同，不能糊成一句。 */
	readonly reason: "no-conversation" | "failed";
	/** 抛错时的简短原因。 */
	readonly detail?: string;
};

type DeliverOptions = {
	/**
	 * 每个人各自的未读摘要，**在调用方提交之前**就算好。
	 *
	 * 不在这里算，是因为这些摘要要读整个频道文档，而投递发生在写入提交之后 ——
	 * 那时候读快照可能已经被释放（chord 报 `Cannot use a settled overlay`），
	 * 而且这个错抛在**写入之后**：消息已经进频道，工具却对外报失败，模型重发一次，
	 * 频道里出现两条一模一样的回复。摘要本来就该是「这条消息之前」的样子，
	 * 提前算既对又安全。
	 */
	readonly digests: ReadonlyMap<string, string>;
	/** 已经读好的 delivery 模板（`postMessage` 每轮现读一份，所有收件人共用）。 */
	readonly prompt: DeliveryPrompt;
	readonly channel: Channel;
	readonly message: Message;
	/** 要唤醒谁（`recipientsOf` 的结果）。 */
	readonly targets: readonly string[];
	/** slug → 会话。返回 undefined 表示这个人没有会话（比如我）。 */
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
	/** 显示名字。缺省用 slug。 */
	readonly labelOf?: (slug: string) => string;
	/** 记住「被谁叫醒」。缺省不记。 */
	readonly rememberWake?: (slug: string, wake: WakeRecord) => Promise<void>;
	/** 读上一次的唤醒记录：忙的时候从它里面继承 `task`。缺省当没有（`task = reply`）。 */
	readonly wakeOf?: (slug: string) => Promise<WakeRecord | undefined>;
	/** 一轮正常答完时的收尾。缺省不补发。 */
	readonly finishTurn?: FinishTurn;
	/** 频道 id → 标题。插话文案里用标题说「回去哪个频道」。缺省直接用 id。 */
	readonly titleOf?: (channelId: string) => string | undefined;
	/**
	 * 此刻手上还有活（有非后台任务在跑）的会话 id。
	 *
	 * 这类投递会**打断**对方正在干的事（`whenBusy: "steer"`），所以正文要多一句
	 * 「这是插话，不是新任务」—— 否则它答完这句就把活丢了。实测：我在沈舟加音效
	 * 的中途私聊问「你是谁啊」，它答完就收工，再没回团队频道汇报。
	 */
	readonly busy?: ReadonlySet<number>;
	/**
	 * 有人没被叫醒时通报一声。不传就只听 stderr。
	 *
	 * 为什么需要这个：投递失败只写 stderr 的话，频道里空白一片，我看到的
	 * 「我说了没人回」和「系统真挂了」长得一模一样 —— 那个「@CEO 不理我」的现象
	 * 就是这么排查了很多轮才定位到投递层的。
	 */
	readonly notify?: (issues: readonly DeliverIssue[]) => Promise<void> | void;
	/**
	 * 附件根目录（`<workspace>/uploads`）。
	 *
	 * 给了就把消息里的图片读成内容块直接交给模型（它真的看得见图），其它文件给出
	 * `file` 的路径。不给就退化成正文里一行「[图片] x.png」—— 那是旧行为。
	 */
	readonly uploadsRoot?: string;
	/** 机械文案目录（`text/channel.md`）。投递头与附件说明从这里取。 */
	readonly text?: TextCatalog;
	/**
	 * 每个人正文后面再补一句（slug → 那一句）。目前只有一种：这一轮记在哪张工单上。
	 *
	 * 挂在这里而不是拼进 `renderDelivery`：那一层只认识「这条消息」，不认识工单。
	 */
	readonly bodyNotes?: ReadonlyMap<string, string>;
	/**
	 * 合并唤醒：撤掉这个会话里「还没开始」的排队项，让新的一条取代它们。
	 * 返回合并了几条（0 = 没合并）。不传就不合并。
	 *
	 * 所有发言都走这一条：我插队（撤掉排在他前面的待办）与「同一个人连发只排一个
	 * 唤醒」是同一件事 —— 都是「这个会话最多留一个未开始的排队项」。
	 */
	readonly coalesceQueue?: (conversationId: number, keepRequestId: string) => Promise<number>;
	/**
	 * 这一轮什么都没产出时留一句话。
	 *
	 * 不传就什么都不写（投递仍然不等回复）。传了就在后台等这次提交结算，
	 * 结算为 `unanswered` 时回调 —— 频道里至少有人能看出「他回答了没」。
	 */
	readonly noteUnanswered?: (info: {
		readonly slug: string;
		readonly label: string;
		readonly seq: number;
		readonly reason: string | undefined;
	}) => Promise<void>;
};

/**
 * 逐条投递。
 *
 * `requestId` 由「频道 + seq + slug」拼成：同一条消息重复投递会被底层去重，
 * 这是崩溃恢复下的至少一次语义想要的。
 */
export async function deliver(
	options: DeliverOptions,
	context: Context = BACKGROUND_CONTEXT,
): Promise<DeliverResult> {
	const delivered: string[] = [];
	const failed: string[] = [];
	const skipped: string[] = [];
	const mergedList: { slug: string; count: number }[] = [];
	const issues: DeliverIssue[] = [];
	const label = options.labelOf ?? ((slug: string) => slug);
	// 回话规矩由调用方每轮现读一份，所有收件人共用（缓存一进投递层，改模板就要重启）。
	const prompt = options.prompt;
	// 附件只读一次：所有收件人拿到的是同一份图片内容块。
	const plan = await planAttachments(options.uploadsRoot, options.message.attachments, options.text);
	const bodyOf = (viewer: string, interrupted: boolean, taskChannelTitle?: string): string =>
		renderDelivery({
			channel: options.channel,
			message: options.message,
			viewer,
			woken: options.targets,
			labelOf: label,
			interrupted,
			...(taskChannelTitle === undefined ? {} : { taskChannelTitle }),
			attachmentLines: plan.lines,
			prompt,
			...(options.text === undefined ? {} : { catalog: options.text }),
		});

	for (const slug of options.targets) {
		const conversation = await options.conversationOf(slug).catch(() => undefined);
		if (conversation === undefined) {
			skipped.push(slug);
			issues.push({ slug, reason: "no-conversation" });
			continue;
		}
		const digest = options.digests.get(slug) ?? "";
		const requestId = requestIdOf(options.channel.id, options.message, slug);
		const interrupted = options.busy?.has(Number(conversation.id)) === true;
		// 两层唤醒记录：这一句回哪儿（`reply`）与手上那件活属于哪儿（`task`）。
		// 打断他正在跑的一轮时，`task` 继承上一次的记录 —— 私聊插话不覆盖任务频道，
		// 否则插话结束，团队频道就再也等不到结论（ADR-099）。
		const reply: WakeTarget = {
			channelId: options.channel.id,
			seq: options.message.seq,
			from: options.message.from,
			at: options.message.at,
		};
		const previous = options.wakeOf === undefined ? undefined : await options.wakeOf(slug).catch(() => undefined);
		const task = interrupted && previous !== undefined ? previous.task : reply;
		const taskChannelTitle =
			task.channelId === options.channel.id
				? undefined
				: (options.titleOf?.(task.channelId) ?? task.channelId);
		const baseText = bodyOf(slug, interrupted, taskChannelTitle);
		const note = options.bodyNotes?.get(slug);
		const base = note === undefined ? baseText : `${baseText}\n${note}`;
		const result = await wake(
			{
				conversationOf: async (target) => (target === slug ? conversation : options.conversationOf(target)),
				coalesceQueue: options.coalesceQueue,
				noteUnanswered: options.noteUnanswered,
				rememberWake: options.rememberWake,
				finishTurn: options.finishTurn,
			},
			{
				slug,
				requestId,
				bodyOf: (merged) => {
					// 合并唤醒：告诉它「更早的几条还在频道里，先看一遍」。文案在 87-merged.md。
					const note = merged === 0 ? "" : mergedNotice(prompt.merged, merged);
					const body = note === "" ? base : `${base}\n\n${note}`;
					const text = digest === "" ? body : `${body}\n\n${digest}`;
					// 有图就发内容块：文字在前，图片在后（多数模型要求首块是文本）。
					return plan.images.length === 0 ? text : [{ type: "text", text }, ...plan.images];
				},
				entry: {
					kind: "core.channel",
					data: {
						channelId: options.channel.id,
						channelTitle: options.channel.title,
						seq: options.message.seq,
						from: options.message.from,
						text: options.message.text.slice(0, 400),
						mentions: [...options.message.mentions],
					},
				},
				wakeRecord: { reply, task },
				note: { channelId: options.channel.id, seq: options.message.seq, label: label(slug) },
			},
			context,
		);

		if (result.status === "delivered") {
			if (result.merged > 0) mergedList.push({ slug, count: result.merged });
			delivered.push(slug);
		} else if (result.status === "failed") {
			process.stderr.write(
				`[投递失败] ${options.channel.id}#${options.message.seq} → ${slug}: ${result.detail}\n`,
			);
			failed.push(slug);
			issues.push({ slug, reason: "failed", detail: result.detail });
		} else {
			skipped.push(slug);
			issues.push({ slug, reason: "no-conversation" });
		}
	}

	// 通报放在最后、一次说完：逐条写 note 会让频道多出一串系统消息。
	// 我被 `recipientsOf` 选中是正常现象（他没有会话），所以那一条由调用方先滤掉。
	if (issues.length > 0 && options.notify !== undefined) {
		try {
			await options.notify(issues);
		} catch (error) {
			process.stderr.write(
				`[投递通报失败] ${options.channel.id}#${options.message.seq}: ${
					error instanceof Error ? error.message : String(error)
				}\n`,
			);
		}
	}

	return { delivered, failed, skipped, ...(mergedList.length === 0 ? {} : { merged: mergedList }) };
}

/** 幂等键：频道 + seq + slug。同一条消息重复投递只醒一次（至少一次语义）。 */
function requestIdOf(channelId: string, message: Message, slug: string): string {
	return `ch:${message.from === "owner" ? "owner:" : ""}${channelId}:${message.seq}:${slug}`;
}

// ── 唤醒 ───────────────────────────────────────────────────────────────────

/**
 * 叫醒一个人：**只有这一条路**。
 *
 * V2 有两条路：`post()` 那条有全套兜底（合并唤醒、记 wake、没产出留痕、delivery 两段），
 * 而旧代码另一处直接 `conversation.submit()` —— 裸提示词，没留痕、没回话规矩、
 * 没合并。于是同一个「叫醒」在两处行为不同，那一处出问题时频道里一片空白，
 * 跟「模型不肯干」长得一模一样（实测排查了很久）。
 *
 * V3 把机制收进这一个函数，调用点只负责两件事：**叫醒谁**、**他看到什么**。
 * 其余（合并排队项、记 wake、没产出留痕、一轮一句的重置）都在这里，只写一遍。
 *
 * 分两步的理由：正文里要写「把 N 条并成了这一条」，所以**必须先合并、再拼正文**。
 * 调用点给的是 `bodyOf(merged)` 而不是拼好的字符串。
 */

/** 这一轮一个字都没产出时，往哪儿留痕。 */
export type WakeNote = {
	readonly slug: string;
	readonly label: string;
	readonly seq: number;
	readonly reason: string;
};

export type WakeDeps = {
	/** slug → 会话。`undefined` = 这个人没有会话（比如我）。 */
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
	/** 撤掉这个会话里还没开始的排队项，让新的一条取代它们。返回合并了几条。 */
	readonly coalesceQueue?: ((conversationId: number, keepRequestId: string) => Promise<number>) | undefined;
	/** 这一轮没产出时留痕。不传就只写 stderr。 */
	readonly noteUnanswered?: ((note: WakeNote) => Promise<void> | void) | undefined;
	/** 记「被谁叫醒」。不传就不记（工具会退到「我最早的那个频道」）。 */
	readonly rememberWake?: ((slug: string, wake: WakeRecord) => Promise<void>) | undefined;
	/**
	 * 这一轮正常结算（`done`）时收尾：模型经常把结论写在最后一段正文里、一次 `say`
	 * 都不调。这里按唤醒记录把它替他说进频道（ADR-099）。
	 */
	readonly finishTurn?:
		| ((info: {
				readonly slug: string;
				readonly conversation: Conversation;
				readonly conversationId: number;
				readonly answer: unknown;
				readonly wake: WakeRecord;
		  }) => Promise<void>)
		| undefined;
};

export type WakeInput = {
	readonly slug: string;
	/** 幂等键：同一条消息重复投递只醒一次（崩溃恢复下的至少一次语义）。 */
	readonly requestId: string;
	/**
	 * 他看到的那段正文。`merged` = 这次合并掉了几条没开始的唤醒。
	 *
	 * 正文必须由调用点拼：投递要知道「这条还 @ 了谁」、「他手上那件活属于哪个频道」。
	 * 入口只保证**拼完之后的那些事**一处不落。
	 */
	readonly bodyOf: (merged: number) => string | UserInput;
	/** 这一轮没产出时留痕的位置。`seq` 是「这条消息」的序号。 */
	readonly note?: { readonly channelId: string; readonly seq: number; readonly label: string } | undefined;
	/** 投递前记一笔「被谁在哪叫醒」。 */
	readonly wakeRecord?: WakeRecord | undefined;
	/** 这条输入的账本条目（`kind` + 数据），诊断用。 */
	readonly entry?: InputEntry | undefined;
};

export type WakeResult =
	| { readonly status: "delivered"; readonly merged: number }
	| { readonly status: "skipped" }
	| { readonly status: "failed"; readonly detail: string };

/**
 * 叫醒一个人。**不等待回复** —— 消息已经在频道里了，这里只负责「让他看见」。
 *
 * 失败不抛：消息不会丢，对方下次醒来会看到未读摘要。但**没产出会留痕**（`note`），
 * 否则频道里一片空白，我看到的「我说了没人回」和「系统挂了」长得一模一样。
 */
export async function wake(
	deps: WakeDeps,
	input: WakeInput,
	context: Context = BACKGROUND_CONTEXT,
): Promise<WakeResult> {
	try {
		const conversation = await deps.conversationOf(input.slug);
		if (conversation === undefined) {
			// 不叫醒也要留痕：频道里 @ 了人、对方却一个字都没有，得能分清是「叫了没跑」还是
			// 「压根没叫」（会话没开）。实测 2026-11-02 上报链中间一跳四分钟无提交。
			console.warn(`[wake] ${input.slug} 没有会话，这条唤醒没提交（${input.requestId}）`);
			return { status: "skipped" };
		}
		const conversationId = Number(conversation.id);

		// 先合并、再拼正文：正文里要写「把 N 条并成了这一条」。
		// 合并唤醒：同一会话最多留一个「还没开始」的排队项。给了撤排队项的那条路才合并。
		const merged =
			deps.coalesceQueue === undefined
				? 0
				: await deps.coalesceQueue(conversationId, input.requestId).catch(() => 0);

		const content = input.bodyOf(merged);

		// 先记 wake、再提交：反过来的话有竞态 —— `submit` 一入队对方就可能跑起来，
		// 那时它查不到 wake，只能退到「我最早的那个频道」（往往是私聊），于是答在私聊里、
		// 问的人在原频道什么都看不到。
		if (deps.rememberWake !== undefined && input.wakeRecord !== undefined) {
			await deps.rememberWake(input.slug, input.wakeRecord);
		}

		const submission = await conversation.submit(
			{
				type: "input",
				content,
				requestId: input.requestId,
				...(input.entry === undefined ? {} : { entry: input.entry }),
				// 投递只有一种插法：打断他正在跑的那一轮（群里的一句问题不该等整轮答完）。
				whenBusy: "steer",
			},
			context,
		);

		// 这一轮结算时一次收尾，两条路：
		// - 一个字都没产出 → 留一行痕，频道里至少能看出「他回答了没」；
		// - 正常答完 → 把最终正文按唤醒记录替他说出去（模型漏调 `say` 的兜底）。
		const report = deps.noteUnanswered;
		const note = input.note;
		const finish = deps.finishTurn;
		const record = input.wakeRecord;
		if ((report !== undefined && note !== undefined) || (finish !== undefined && record !== undefined)) {
			watchSettled(submission, async (settled) => {
				if (settled.status === "unanswered") {
					// `aborted` = 被后来的一条消息合并唤醒撤掉了（`coalesceQueue` 只撤「还没开始」的
					// 排队项）。消息还在频道里，新的那一轮会把它们一起答 —— 这不是「没答上来」，
					// 写一条 note 只会让人以为他掉了链子（实测：一条频道里连着好几条这种假消息）。
					if (settled.reason === "aborted") return;
					if (report === undefined || note === undefined) return;
					await report({ slug: input.slug, label: note.label, seq: note.seq, reason: settled.reason ?? "unanswered" });
					return;
				}
				if (finish === undefined || record === undefined) return;
				await finish({
					slug: input.slug,
					conversation,
					conversationId,
					answer: settled.answer,
					wake: record,
				});
			});
		}
		return { status: "delivered", merged };
	} catch (error) {
		console.warn(
			`[wake] ${input.slug} 提交失败：${error instanceof Error ? error.message : String(error)}（${input.requestId}）`,
		);
		return { status: "failed", detail: error instanceof Error ? error.message : String(error) };
	}
}
