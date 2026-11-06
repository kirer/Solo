// ── 投递编排 ───────────────────────────────────────────────────────────────
// 「写一条消息」与「把它交给该看的人」是一次写入的两半：收件人由消息本身算出来
// （`recipientsOf`），投递正文又由这条消息拼出来。落盘在 `channel/write.ts`，这里
// 只负责叫醒。
//
// 这个文件有两种读法，取决于你在查什么：
// - 只想知道「一次发布怎么变成若干次入队」→ 看文件末尾的 `createTurnRunner`；
// - 想改一次入队的细节（合并、唤醒记录、失败留痕）→ 看 `fanOut` / `enqueue`。
import { BACKGROUND_CONTEXT, type Context, type Harness } from "../runtime/index.ts";
import {
	watchSettled,
	renderUnanswered,
} from "../channel/unanswered.ts";
import type {
	Conversation,
	InputEntry,
	InputSubmissionDraft,
	Submission,
	SubmissionId,
	Tx,
	UserInput,
} from "../runtime/index.ts";
import { deliveryText, digestNotice, digestRows, mergedNotice, renderDelivery, type DeliveryPrompt } from "../channel/delivery.ts";
import { planAttachments } from "../channel/attachments.ts";
import type { Channel, Message } from "../channel/types.ts";
import type { WakeRecord, WakeTarget } from "../channel/turn/record.ts";
import type { TextCatalog } from "../documents/base/catalog.ts";
import { fill } from "../documents/base/catalog.ts";
import { appendNote } from "../channel/write.ts";
import { coalesceQueue, liveConversations } from "../channel/queue.ts";
import type { DeliverIssue, DeliverResult } from "./types.ts";
import type { FanOutArgs, TurnRunner } from "./ports.ts";

export type { WakeRecord } from "../channel/turn/record.ts";

export type DeliverOptions = {
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
	/** 已经读好的 delivery 模板（`publish` 每轮现读一份，所有收件人共用）。 */
	readonly prompt: DeliveryPrompt;
	readonly channel: Channel;
	readonly message: Message;
	/** 要唤醒谁（`recipientsOf` 的结果，或助理指定的人）。 */
	readonly targets: readonly string[];
	/** 助理把这条转给了他（slug）。投递正文里写明，别的什么都不改。 */
	readonly routedBy?: string;
	/** slug → 会话。返回 undefined 表示这个人没有会话（比如我）。 */
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
	/** 显示名字。缺省用 slug。 */
	readonly labelOf?: (slug: string) => string;
	/** 记住「被谁叫醒」。缺省不记。 */
	readonly rememberWake?: (slug: string, wake: WakeRecord) => Promise<void>;
	/**
	 * 原子唤醒：wake 与入队同一个 commit。给了就优先走这条，`rememberWake` 只当退路。
	 * 两个字段是一对 —— commit 后事务形式只还 id，句柄要另外取回来等待。
	 */
	readonly wakeTogether?: {
		readonly rememberWake: (tx: Tx, slug: string, wake: WakeRecord) => Promise<void>;
		readonly submissionOf: (id: SubmissionId) => Promise<Submission | undefined>;
	};
	/** 读上一次的唤醒记录：忙的时候从它里面继承 `task`。缺省当没有（`task = reply`）。 */
	readonly wakeOf?: (slug: string) => Promise<WakeRecord | undefined>;
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
	/** 谁是助理（slug）。助理的结论回我的私聊，不在团队频道里收尾。 */
	readonly assistants?: readonly string[];
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
		readonly detail?: unknown;
	}) => Promise<void>;
};

/**
 * 逐条投递。
 *
 * `requestId` 由「频道 + seq + slug」拼成：同一条消息重复投递会被底层去重，
 * 这是崩溃恢复下的至少一次语义想要的。
 */
export async function fanOut(options: DeliverOptions, context: Context): Promise<DeliverResult> {
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
			...(options.assistants?.includes(viewer) === true ? { assistant: true } : {}),
			woken: options.targets,
			labelOf: label,
			...(options.routedBy === undefined ? {} : { routedBy: options.routedBy }),
			interrupted,
			...(taskChannelTitle === undefined ? {} : { taskChannelTitle }),
			attachmentLines: plan.lines,
			prompt,
			...(options.text === undefined ? {} : { catalog: options.text }),
		});

	for (const slug of options.targets) {
		let conversation: Conversation | undefined;
		try {
			conversation = await options.conversationOf(slug);
		} catch (error) {
			// 开会话失败不是「这个人没有会话」：前者是系统坏了，后者是本来就不该叫醒。
			// 混成 skipped 的话，频道里只会显示「没叫」，排查时看不出是故障。
			const detail = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[投递失败] ${options.channel.id}#${options.message.seq} → ${slug}: ${detail}\n`);
			failed.push(slug);
			issues.push({ slug, reason: "failed", detail });
			continue;
		}
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
		// 只有被打断时才需要上一次的记录（从它继承 `task`），所以只在此时读。
		// 读不出来就**不猜**：猜成 `reply` 会让私聊里的一句插话把团队频道的活顶掉（ADR-099）。
		let task: WakeTarget = reply;
		if (interrupted && options.wakeOf !== undefined) {
			try {
				const previous = await options.wakeOf(slug);
				if (previous !== undefined) task = previous.task;
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				process.stderr.write(`[投递失败] ${options.channel.id}#${options.message.seq} → ${slug}: ${detail}\n`);
				failed.push(slug);
				issues.push({ slug, reason: "failed", detail });
				continue;
			}
		}
		const taskChannelTitle =
			task.channelId === options.channel.id
				? undefined
				: (options.titleOf?.(task.channelId) ?? task.channelId);
		const base = bodyOf(slug, interrupted, taskChannelTitle);
		const result = await enqueue(
			{
				conversationOf: async (target) => (target === slug ? conversation : options.conversationOf(target)),
				coalesceQueue: options.coalesceQueue,
				noteUnanswered: options.noteUnanswered,
				rememberWake: options.rememberWake,
				wakeTogether: options.wakeTogether,
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
						at: options.message.at,
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
	/** 底座给的原因细节（模型错误正文、被什么打断、工具轮数）；压成一行再落频道。 */
	readonly detail?: unknown;
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
	/** 原子唤醒：wake 与入队同一个 commit（ADR-076）。不传就退回「先记 wake、再提交」。 */
	readonly wakeTogether?:
		| {
				readonly rememberWake: (tx: Tx, slug: string, wake: WakeRecord) => Promise<void>;
				readonly submissionOf: (id: SubmissionId) => Promise<Submission | undefined>;
		  }
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
export async function enqueue(deps: WakeDeps, input: WakeInput, context: Context): Promise<WakeResult> {
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
		//
		// 合并失败只意味着「多留一个排队项」：照常投递，正文说「没合并」。这是账务上的
		// 冗余，不是消息丢了 —— 为它放弃这次唤醒反而更糟，所以这里保留兜底。
		const merged =
			deps.coalesceQueue === undefined
				? 0
				: await deps.coalesceQueue(conversationId, input.requestId).catch(() => 0);

		const content = input.bodyOf(merged);

		const draft: InputSubmissionDraft = {
			type: "input",
			content,
			requestId: input.requestId,
			...(input.entry === undefined ? {} : { entry: input.entry }),
			// 投递只有一种插法：打断他正在跑的那一轮（群里的一句问题不该等整轮答完）。
			whenBusy: "steer",
		};

		// 先有 wake、才有排队项：反过来的话有竞态 —— `submit` 一入队对方就可能跑起来，
		// 那时它查不到 wake，只能退到「我最早的那个频道」（往往是私聊），于是答在私聊里、
		// 问的人在原频道什么都看不到。1.5.0 的 `submit(tx)` 让这两件事落在同一个 commit 里
		// （ADR-076）；只有没接上原子路径的调用方才退回「先单独记、再提交」。
		const together = deps.wakeTogether;
		let submission: Submission;
		if (together !== undefined && input.wakeRecord !== undefined) {
			const record = input.wakeRecord;
			const submissionId = await conversation.commit(async (tx) => {
				// 先写文档（只碰 doc），再准入。准入就是这张表的第一次写，之后不能再读表。
				await together.rememberWake(tx, input.slug, record);
				return conversation.submit(tx, draft);
			}, context);
			const resumed = await together.submissionOf(submissionId);
			if (resumed === undefined) {
				// 提交已经在盘上了，只是句柄没取回来。不能报 failed（会让调用方以为没入队）；
				// 只是这一轮没人盯着收尾。
				console.warn(`[wake] ${input.slug} 拿到了提交 id，却取不回句柄（${input.requestId}）`);
				return { status: "delivered", merged };
			}
			submission = resumed;
		} else {
			if (deps.rememberWake !== undefined && input.wakeRecord !== undefined) {
				await deps.rememberWake(input.slug, input.wakeRecord);
			}
			submission = await conversation.submit(draft, context);
		}

		// 这一轮结算时留痕：一个字都没产出 → 频道里留一行，至少能看出「他回答了没」。
		// 正常答完的收尾不在这里：它是 durable task（`turn/report.ts`），进程被杀也能跑完。
		const report = deps.noteUnanswered;
		const note = input.note;
		if (report !== undefined && note !== undefined) {
			watchSettled(submission, async (settled) => {
				if (settled.status !== "unanswered") return;
				// 两种「不是没答上来」：
				// - `aborted`：被后来的一条消息合并唤醒撤掉了（`coalesceQueue` 只撤「还没开始」的
				//   排队项）。消息还在频道里，新的那一轮会把它们一起答。
				// - `nothing_to_answer`：上下文本来就以一条回答结尾，continue 没东西可答。
				// 写一条 note 只会让人以为他掉了链子（实测：一条频道里连着好几条这种假消息）。
				if (settled.reason === "aborted" || settled.reason === "nothing_to_answer") return;
				await report({
					slug: input.slug,
					label: note.label,
					seq: note.seq,
					reason: settled.reason ?? "unanswered",
					...(settled.detail === undefined ? {} : { detail: settled.detail }),
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

// ── 一次发布 → 若干次入队 ─────────────────────────────────────────────────

/** `createTurnRunner` 要的全部接线。字段与 `channel/post.ts` 的 `PostDeps` 同形。 */
export type RunnerDeps = {
	readonly harness: Harness;
	readonly conversationOf: (slug: string) => Promise<Conversation | undefined>;
	readonly labelOf?: (slug: string) => string;
	readonly rememberWake?: (slug: string, wake: WakeRecord) => Promise<void>;
	readonly wakeTogether?: DeliverOptions["wakeTogether"];
	readonly wakeOf?: (slug: string) => Promise<WakeRecord | undefined>;
	readonly uploadsRoot?: string;
	readonly promptDir?: string;
	readonly text?: TextCatalog;
	/** 谁是助理（slug）。每轮现读：改身份目录下一条消息生效。 */
	readonly assistants?: () => Promise<readonly string[]>;
};

/**
 * 把一份名单变成入队：算摘要、读模板、取忙闲，然后逐条 `fanOut`。
 *
 * 摘要用**写之前**的 `state`（publish 传进来的那份快照）：新消息已经在频道里了，
 * 再算进未读数会重复。这一步放在提交之后也没关系 —— 快照是纯数据，不是事务覆盖层。
 */
export function createTurnRunner(deps: RunnerDeps): TurnRunner {
	return {
		async fanOut(args: FanOutArgs): Promise<DeliverResult> {
			const { state, channel, message, plan, routedBy, ctx } = args;
			if (plan.targets.length === 0) return { delivered: [], failed: [], skipped: [] };

			// 模板只读一次：摘要和正文用同一份，改 md 下一条生效。
			const prompt = await deliveryText(deps.promptDir);
			const assistants = deps.assistants === undefined ? undefined : await deps.assistants();
			const digests = new Map<string, string>();
			for (const slug of plan.targets) {
				const part = digestRows(state, slug, 5, deps.text);
				digests.set(slug, digestNotice(prompt.digest, part.total, part.rows));
			}

			// 谁手上还有活：投递会打断他，正文要说明「这是插话，不是新任务」。
			// 读不出来就按「没人忙」继续：消息已经在 `publish` 里落盘了，这里再抛会让
			// 整次发布失败，模型收到错误后重试 —— 频道里就多出第二条一模一样的消息。
			const busy = await liveConversations(deps.harness, ctx).catch((error: unknown) => {
				console.warn(
					`[wake] 读队列失败，按「没人忙」投递：${error instanceof Error ? error.message : String(error)}`,
				);
				return new Set<number>();
			});
			const labelOf = deps.labelOf ?? ((slug: string) => slug);

			return fanOut(
				{
					digests,
					prompt,
					channel,
					message,
					targets: plan.targets,
					busy,
					...(assistants === undefined ? {} : { assistants }),
					...(deps.text === undefined ? {} : { text: deps.text }),
					...(routedBy === undefined ? {} : { routedBy }),
					// 合并唤醒（也负责我插队）：同一个会话最多留一个「还没开始」的排队项。
					// 谁连发几条（我三句、agent 的过程话与追问）都只排一个唤醒，最后一条取代
					// 前面没开始的那些 —— 消息都在频道里，少的只是重复唤醒。
					coalesceQueue: (conversationId, keepRequestId) =>
						coalesceQueue(deps.harness, conversationId, keepRequestId, ctx),
					conversationOf: deps.conversationOf,
					...(deps.labelOf === undefined ? {} : { labelOf: deps.labelOf }),
					...(deps.rememberWake === undefined ? {} : { rememberWake: deps.rememberWake }),
					...(deps.wakeTogether === undefined ? {} : { wakeTogether: deps.wakeTogether }),
					...(deps.wakeOf === undefined ? {} : { wakeOf: deps.wakeOf }),
					titleOf: (channelId) => state.channels[channelId]?.title,
					...(deps.uploadsRoot === undefined ? {} : { uploadsRoot: deps.uploadsRoot }),
					// 这一轮他一个字都没产出（最常见的是模型引用失效）：留一行，别让频道里
					// 只剩一条占位「开始处理…」。等待在后台，不占投递这条线 ——
					// 写盘走 `settle({kind:"unanswered"})`，与 done 分支同一个入口。
					noteUnanswered: async ({ label, seq, reason, detail }) => {
						await args.settle(
							{
								kind: "unanswered",
								channelId: channel.id,
								text: renderUnanswered(seq, label, reason, deps.text, detail),
							},
							BACKGROUND_CONTEXT,
						);
					},
					// 没人被叫醒就说一句：只写 stderr 的话，频道里一片空白，
					// 我看到的「我说了没人理」和「系统挂了」长得一模一样。
					notify: async (issues) => {
						await appendNote(
							{ harness: deps.harness },
							channel.id,
							renderIssues(message.seq, issues, labelOf, deps.text),
							Date.now(),
							ctx,
						);
					},
				},
				ctx,
			);
		},
	};
}

/** 投递没成时给我留一句话。分开列，不糊成一句：两种原因的处置完全不同。 */
function renderIssues(
	seq: number,
	issues: readonly DeliverIssue[],
	labelOf: (slug: string) => string,
	catalog?: TextCatalog,
): string {
	return issues
		.map((issue) =>
			issue.reason === "failed"
				? fill(catalog, "post.issue.failed", {
						seq,
						label: labelOf(issue.slug),
						detail: issue.detail ?? fill(catalog, "post.issue.unknown"),
					})
				: fill(catalog, "post.issue.skipped", { seq, label: labelOf(issue.slug) }),
		)
		.join("\n");
}
