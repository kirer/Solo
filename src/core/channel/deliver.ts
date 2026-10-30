/**
 * 投递：把一条频道消息推到被唤醒者的**下一次请求**里。
 *
 * 这是新核心里唯一的跨 agent 原语，只有一条硬约束：
 *
 * **不等待回复。** 消息已经落在频道文档里了，投递只负责「叫醒」。答案从频道
 * 异步回来，发送方不等。不回执、不看门狗、不重投 —— 那些都是「不等待」的代价，
 * 等真出现「投了但没人醒」再补。现在只守两条：
 *
 * 1. 一条投递失败不影响其余（逐条 try/catch）。
 * 2. 投递失败不丢消息 —— 消息在文档里，对方下次醒来会看到未读摘要。
 */
import type { Conversation, Harness, UserInput } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import { planAttachments } from "./attach.ts";
import { clearSpoken } from "./speech.ts";
import { watchSettled } from "./unanswered.ts";
import {
	type Channel,
	type ChannelState,
	type Message,
	OWNER,
	chatKind,
	recipientsOf,
	unreadCount,
	channelsOf,
	tail,
} from "./state.ts";

/** 记忆里「刚被谁在哪个频道叫醒」。工具用它决定「默认在哪儿回话」。 */
export type WakeRecord = {
	readonly channelId: string;
	readonly seq: number;
	readonly from: string;
	readonly at: number;
};

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

/** 这个频道是不是「我和某个人的私聊」。形态按成员推，不看 id 前缀。 */
function isOwnerDm(channel: Channel, viewer: string | undefined): boolean {
	if (chatKind(channel) !== "dm") return false;
	return viewer === undefined || channel.members.includes(viewer);
}

/**
 * 每轮贴在投递正文末尾的「怎么回话」。
 *
 * 为什么不写进系统提示词：静态规矩在长上下文里会被稀释，而这一段贴着生成点，
 * 每轮重申一次。ds-bot 就是这么干的（`groups.js:102` 的 `ROOM_REPLY`），实测比
 * 把规矩放在系统提示里有效一个量级。
 *
 * 两句关键：①**长只允许出现在被点名要的场合** —— 只写「要短」会得到又短又偷工；
 * ②只有一个人在场时不能静音（PASS 会断线）。
 */
export function renderReplyRules(options: {
	readonly woken: readonly string[];
	readonly viewer?: string | undefined;
	readonly labelOf?: ((slug: string) => string) | undefined;
	/** 这个频道里除自己和我之外的成员。有他们才提「成员的事在群里说」。 */
	readonly colleagues?: readonly string[];
}): string {
	const others = options.woken.filter((slug) => slug !== options.viewer);
	const label = options.labelOf ?? ((slug: string) => slug);
	const colleagues = (options.colleagues ?? []).filter((slug) => slug !== options.viewer);
	return [
		"（回话像成员发消息：一两句、说结论。不写小标题、不列清单、不总结你刚做过什么。）",
		"（被要求做事就现在用工具做，说完只说结果 —— 谁、做了什么、卡在哪、下一步。不要许诺「我马上处理」。）",
		"（干活中途想让人知道进展，就发 `say` 带 `step: true`，那种可以连发几句；不带的是结论，**这一轮只认一句**，第二句会被拒。）",
		others.length === 0
			? "（这一轮只有你被叫醒：必须回，回的就是结果。）"
			: `（没有新东西就不说：只把 text 写成 \`[PASS]\`，这条不会发出去 —— 这一轮还有 ${others
					.map((slug) => options.labelOf?.(slug) ?? slug)
					.join("、")} 在。）`,
		// 说完之后模型常把「我做了 X」再写成最终回答。那段正文会被投影成第二条消息
		// （实测原文「已回我：在，随时待命。」紧跟在自己的发言之后）。
		"（别复述：最终回答里不要写「已回我」「已发到频道」这类话 —— 你说过的他已经在频道里看到了。）",
		"（要回这个频道就用 say，channel 省略即可；要看完整历史用 chats(action=read)）",
		// 成员之间的事放在群里说。私聊只有我能用（系统会拦），而「找个人问一句」如果没有
		// 出口，agent 就会绕道群里喊一句「@所有人」或者干脆自己猜 —— 实测员工↔员工只有 1.2%。
		colleagues.length === 0
			? ""
			: `（成员的事就在这个频道说：要问 ${colleagues.map(label).join("、")} 就 @ 他，他会收到、也看得到上下文。不要为了找一个人去私聊 —— 成员之间的私聊系统不允许。）`,
	]
		.filter((item) => item !== "")
		.join("\n");
}

/** 一条消息交给模型时的正文。纯函数，方便单测。 */
export function renderDelivery(options: {
	readonly channel: Channel;
	readonly message: Message;
	/** 收件人。用来从「还 @ 了」里剔掉自己——否则每个人都会看到「还 @ 了你」。 */
	readonly viewer?: string | undefined;
	readonly labelOf?: ((slug: string) => string) | undefined;
	/** 这句是插进一轮正在跑的工作里的。 */
	readonly interrupted?: boolean;
	/** 附件说明（`planAttachments` 的 `lines`）。没有附件时为空。 */
	readonly attachmentLines?: readonly string[];
}): string {
	const label = options.labelOf ?? ((slug: string) => slug);
	const { channel, message } = options;
	const quoted =
		message.replyTo === undefined ? "" : `（回复 #${message.replyTo}）`;
	const others = message.mentions.filter(
		(slug) => slug !== message.from && slug !== options.viewer,
	);
	const also = others.length === 0 ? "" : `\n这条还 @ 了：${others.map(label).join("、")}`;
	// 「这条会叫醒谁、你是第几个」和「别人也在看」必须由代码注入：模型看不到投递名单，
	// 于是两个人被同时叫醒时各写一条重复甚至矛盾的回复，谁也不知道对方也在场。
	const woken = recipientsOf(channel, message).filter((slug) => slug !== OWNER);
	const line = [also];
	if (woken.length > 0) {
		const position =
			options.viewer === undefined ? "" : `（你在第 ${woken.indexOf(options.viewer) + 1 || 1} 位）`;
		line.push(`\n这条会叫醒：${woken.map(label).join("、")}${position}`);
		if (woken.length > 1) {
			line.push("\n别人也在看这条。动手前先说一句你接哪一块，别重复别人已经做的。");
		}
	}
	return [
		// 第一行必须带**频道 id**：模型以前只看到标题，于是它只能用 `say` 的缺省频道回话；
		// 一旦缺省频道猜错（例如猜成私聊），整段对话就跑到别的房间里去了。
		`【${channel.title}】#${message.seq}（频道 ${channel.id}）${quoted}`,
		`${label(message.from)}：${message.text}${line.join("")}`,
		...(isOwnerDm(channel, options.viewer)
			? ["（这是你和我的私聊，只回这里，别去群里说）"]
			: []),
		...(options.attachmentLines === undefined || options.attachmentLines.length === 0
			? []
			: ["", "附件：", ...options.attachmentLines]),
		// 「怎么回话」每轮贴在最后：它比系统提示词里的同一句规矩有效得多。
		renderReplyRules({
			woken,
			viewer: options.viewer,
			labelOf: label,
			// 只在群聊里说「成员的事在群里说」：私聊里没有第三方，提了反而让它去找人。
			colleagues:
				chatKind(channel) === "dm"
					? []
					: channel.members.filter((slug) => slug !== OWNER && slug !== options.viewer),
		}),
		...(options.interrupted === true
			? [
					"（这是插话，不是新任务：答完这一句就回到你手上的活，别停。手上的活干完按规矩汇报，汇报完再管这件事。）",
				]
			: []),
	].join("\n");
}

/** 未读摘要：这个人所有频道里还有多少没看。纯函数。 */
export function renderDigest(state: ChannelState, slug: string, limit = 5): string {
	const rows: string[] = [];
	let total = 0;
	for (const channel of channelsOf(state, slug)) {
		const unread = unreadCount(state, channel.id, slug);
		if (unread === 0) continue;
		total += unread;
		const last = tail(state, channel.id, 1)[0];
		const preview = last === undefined ? "" : ` — ${oneLine(last.text, 60)}`;
		rows.push(`- ${channel.title}：${unread} 条${preview}`);
		if (rows.length >= limit) break;
	}
	if (rows.length === 0) return "";
	// 「未读摘要」写得太像任务，模型会把它当成要回的东西 —— 实测一次积压 39 条时，
	// 它答的是摘要里的旧问题，而不是刚投进来的这一条。所以这里明说它是背景。
	return [
		`【背景：别的频道里还有 ${total} 条没看】`,
		...rows,
		"（这不是要你现在回的。要用 chats(action=read) 看；先答上面那条。）",
	].join("\n");
}

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
	// 附件只读一次：所有收件人拿到的是同一份图片内容块。
	const plan = await planAttachments(options.uploadsRoot, options.message.attachments);
	const bodyOf = (viewer: string, interrupted: boolean): string =>
		renderDelivery({
			channel: options.channel,
			message: options.message,
			viewer,
			labelOf: label,
			interrupted,
			attachmentLines: plan.lines,
		});

	for (const slug of options.targets) {
		try {
			const conversation = await options.conversationOf(slug);
			if (conversation === undefined) {
				skipped.push(slug);
				issues.push({ slug, reason: "no-conversation" });
				continue;
			}
			const digest = options.digests.get(slug) ?? "";
			const requestId = `ch:${options.message.from === "owner" ? "owner:" : ""}${options.channel.id}:${
				options.message.seq
			}:${slug}`;
			// 合并唤醒：先撤掉这个会话里还没开始的排队项，再按「合并了几条」补一句正文。
			// 必须在拼正文之前做 —— 那一句要告诉它「更早的几条还在频道里，先看一遍」。
			const merged =
				options.coalesceQueue === undefined
					? 0
					: await options.coalesceQueue(Number(conversation.id), requestId).catch(() => 0);
			const base = bodyOf(slug, options.busy?.has(Number(conversation.id)) === true);
			const body =
				merged === 0
					? base
					: `${base}\n\n（合并唤醒：把 ${merged} 条还没开始处理的消息并成了这一条 —— 更早的那几条内容都还在频道里，先 chats(action=read) 看一遍再答，别只答最新这条。）`;
			const text = digest === "" ? body : `${body}\n\n${digest}`;
			// 有图就发内容块：文字在前，图片在后（多数模型要求首块是文本）。
			const content: UserInput =
				plan.images.length === 0 ? text : [{ type: "text", text }, ...plan.images];
			// 先记「它在哪个频道被叫醒」，再提交。
			//
			// 反过来的话有竞态：`submit` 一入队对方就可能已经跑起来，而它此刻查不到
			// wake，只能退到「我最早的那个频道」—— 那往往是私聊，于是**答在私聊里、
			// 问的人在原频道什么都看不到**（`core:live` 12 项里 9 项因此超时，实测抓到）。
			// 新一轮开始：它又可以重新说一句结论了。
			clearSpoken(Number(conversation.id));
			if (options.rememberWake !== undefined) {
				await options.rememberWake(slug, {
					channelId: options.channel.id,
					seq: options.message.seq,
					from: options.message.from,
					at: options.message.at,
				});
			}
			const submission = await conversation.submit(
				{
					type: "input",
					content,
					requestId,
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
					// 本轮工具结束后并入：群里的一条问题不该等整轮答完。
					whenBusy: "steer",
				},
				context,
			);
			// 这一轮结算时「一个字都没说」留痕。
			const report = options.noteUnanswered;
			if (report !== undefined) {
				watchSettled(submission, async (reason) => {
					await report({ slug, label: options.labelOf?.(slug) ?? slug, seq: options.message.seq, reason });
				});
			}
			if (merged > 0) mergedList.push({ slug, count: merged });
			delivered.push(slug);
		} catch (error) {
			// 不抛：消息已在频道里，对方下次醒来会看到未读摘要。
			const detail = error instanceof Error ? error.message : String(error);
			process.stderr.write(
				`[投递失败] ${options.channel.id}#${options.message.seq} → ${slug}: ${detail}\n`,
			);
			failed.push(slug);
			issues.push({ slug, reason: "failed", detail });
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

/**
 * 同一个会话里「还没开始」的排队项 —— 可以被这一条合并唤醒的那些。
 *
 * 三条约束（知言 2026-10-30 定）：
 * 1. **同一会话最多保留一个未开始的排队项**：所以每次投递前先把旧的撤掉；
 * 2. **正在跑的那条不算**：只认 `status: "queued"`，`placed` 已经开始了，它不会被撤；
 * 3. **消息一条都不删**：撤的只是唤醒，那几条消息还在频道里，醒来读一遍就看到。
 *
 * 我连发的几条**也合并**（2026-10-30 我定）：他连说三句时，对方醒来读一遍频道就能
 * 把三句一起答；排三个唤醒只会让它跑三趟、还各答一遍。消息一条都不删，所以「三句都看到」
 * 不受影响。这里同时是**唯一**一份「谁该让路」的判据 —— 旧代码里我插队另有一个
 * `choresAheadOf`（跳过我自己的排期），两套口径迟早分叉，已合并到这里。
 */
export function queuedAhead(
	submissions: readonly {
		readonly id: number | bigint | string;
		readonly conversationId: number | bigint | string;
		readonly status: string;
		readonly requestId?: string | undefined;
	}[],
	conversationId: number,
	keepRequestId?: string,
	max = 8,
): (number | bigint | string)[] {
	const out: (number | bigint | string)[] = [];
	for (const submission of submissions) {
		if (Number(submission.conversationId) !== conversationId) continue;
		if (submission.status !== "queued") continue;
		if (keepRequestId !== undefined && submission.requestId === keepRequestId) continue;
		out.push(submission.id);
		if (out.length >= max) break;
	}
	return out;
}

/**
 * 合并唤醒的执行器（也负责我插队）：撤掉这个会话里还没开始的排队项，返回撤了几条。
 *
 * 我发消息时走的也是这里 —— 以前另有一条 `clearQueueAhead`，两个函数会去撤同一批
 * 排队项（第二次白跑一趟），现在只有这一条路。
 *
 * 撤不掉（已经在跑、或者竞态里被别人取走）就跳过 —— 多叫醒一次只是慢，
 * 而「以为撤掉了其实没撤」会让人以为消息丢了。
 */
export async function coalesceQueue(
	harness: Harness,
	conversationId: number,
	keepRequestId: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	const inspection = await harness.inspect(context);
	const pending = queuedAhead(inspection.submissions, conversationId, keepRequestId);
	let merged = 0;
	for (const id of pending) {
		try {
			await harness.abortSubmission(
				id as Parameters<Harness["abortSubmission"]>[0],
				context,
				conversationId as Parameters<Harness["abortSubmission"]>[2],
			);
			merged += 1;
		} catch {
			// 撤不掉就算了：那一条照样会被答，只是多一次唤醒。
		}
	}
	return merged;
}

/**
 * 哪些会话此刻手上有活。
 *
 * 用 `harness.inspect()`（只读、不写、不跑任务）取「活着的任务」，按会话聚合，
 * 排掉后台任务 —— 后台任务是代理自己的账本，不算「打断它正在干的事」。
 */
export async function liveConversations(
	harness: Harness,
	context: Context = BACKGROUND_CONTEXT,
): Promise<Set<number>> {
	const inspection = await harness.inspect(context);
	const busy = new Set<number>();
	for (const task of inspection.tasks) {
		if (task.record.background === true) continue;
		busy.add(Number(task.record.conversationId));
	}
	return busy;
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
