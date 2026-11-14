/**
 * 频道落盘：把一条消息写进 `ChannelDoc`，只此一处。
 *
 * 这里**不叫醒人**：投递是 `post.ts` / `dispatch.ts` 的事。留痕（`appendNote`）与
 * 发言（`postMessage`）共用同一个写入实现，seq 自愈、路径式 push 都只在这里发生。
 */
import type { Context, Harness } from "../runtime/index.ts";
import {
	ChannelDoc,
	OWNER,
	nextTaskIdOf,
	tasksOf,
	type Attachment,
	type Channel,
	type ChannelState,
	type Message,
	type Task,
	type TaskHistoryEntry,
} from "./types.ts";
import { appendMessage } from "./rules.ts";
import type { MentionRoster } from "./mentions.ts";

type AppendInput = {
	readonly channelId: string;
	readonly from: string;
	readonly text: string;
	readonly at: number;
	/** 唯一的非默认 kind：系统留痕。发言不传，落库就是 `chat`。 */
	readonly kind?: "note";
	readonly noteOf?: string;
	readonly replyTo?: number;
	readonly roster?: MentionRoster;
	readonly mention?: readonly string[];
	readonly attachments?: readonly Attachment[];
	readonly options?: readonly string[];
	/** 这条在等老板拍板（`needs: "decision"`）。 */
	readonly needs?: Message["needs"];
	/** 替哪条会话答案补发的（判重用，见 `Message.sourceEntry`）。 */
	readonly sourceEntry?: string;
	/** 这条是人亲手打的，原样带到 `Message.human`。 */
	readonly human?: boolean;
};

/**
 * 把事务/文档代理里读出来的频道抄成纯对象。
 *
 * 事务一关就不能再读代理（`Cannot use a settled overlay`），而投递在 commit **之后**
 * 才拿这个频道算人。`members` / `wakeOnAll` / `responder` 都是嵌套值，必须逐个抄 ——
 * 只写 `{ ...channel }` 会把它们的代理带出去。
 */
export function plainChannel(channel: Channel): Channel {
	return {
		...channel,
		members: [...channel.members],
		wakeOnAll: [...channel.wakeOnAll],
		...(channel.responder === undefined ? {} : { responder: { ...channel.responder } }),
	};
}

/**
 * 消息落盘的**唯一**实现：一次 commit，一次路径式 push。
 *
 * `postMessage`（说话）与 `appendNote`（系统留痕）都走这里。以前各写一份，其中
 * `appendNote` 没有 seq 自愈 —— 频道文档的 `nextSeq` 一旦落后，留痕会拿到一个撞号的
 * seq。同一类错误只该在一处发生，所以也只在修一处能修好。
 *
 * 频道不存在返回 `undefined`（调用方自己决定是报错还是静默）；其余失败照常抛。
 */
export async function appendToChannel(
	deps: { readonly harness: Harness },
	input: AppendInput,
	context: Context,
): Promise<{ readonly channel: Channel; readonly message: Message } | undefined> {
	let appended: { readonly channel: Channel; readonly message: Message } | undefined;
	await deps.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		const channel = doc.channels[input.channelId];
		if (channel === undefined) return;
		// 序号以**消息本身**为准，不以 `nextSeq` 为准（撞号的后果见 `postMessage` 的说明）。
		const highestSeq = (doc.messages[input.channelId] ?? []).reduce((max, item) => (item.seq > max ? item.seq : max), 0);
		if ((doc.nextSeq[input.channelId] ?? 1) <= highestSeq) doc.nextSeq[input.channelId] = highestSeq + 1;
		// `appendMessage` 返回的是新 state；这里只要它算好的 message，写入按路径原地做。
		const next = appendMessage(doc, input.channelId, {
			from: input.from,
			text: input.text,
			at: input.at,
			...(input.kind === undefined ? {} : { kind: input.kind }),
			...(input.noteOf === undefined ? {} : { noteOf: input.noteOf }),
			...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
			...(input.roster === undefined ? {} : { roster: input.roster }),
			...(input.mention === undefined ? {} : { mention: input.mention }),
			...(input.attachments === undefined ? {} : { attachments: input.attachments }),
			...(input.options === undefined ? {} : { options: input.options }),
			...(input.needs === undefined ? {} : { needs: input.needs }),
			...(input.sourceEntry === undefined ? {} : { sourceEntry: input.sourceEntry }),
			...(input.human === undefined ? {} : { human: input.human }),
		});
		// **只有一个元素被追加**，所以必须让文档层看见「数组长了一格」而不是「这个键换了个
		// 新数组」。两者写下去的消息一样，代价差三个数量级（见 `test/core/channel-write.test.ts`）。
		//
		// `push` 必须作用在**文档代理给出的那个数组**上：`doc.messages[id] ??=` 之后再 push
		// 本地变量不算数（那不是代理，提交时不会有任何 op，消息静默消失）。
		doc.messages[input.channelId] ??= [];
		(doc.messages[input.channelId] as Message[]).push(next.message);
		doc.nextSeq[input.channelId] = next.message.seq + 1;
		// 抄成纯对象再交出去：事务一关就不能再读代理（`Cannot use a settled overlay`）。
		appended = {
			channel: plainChannel(channel),
			message: JSON.parse(JSON.stringify(next.message)) as Message,
		};
	}, context);
	return appended;
}

/**
 * 追一条系统留痕到频道。`note` 不唤醒、不计未读（见 `Message.kind`），所以这里不碰
 * 投递层，否则「系统说一下没人被叫醒」会反过来叫醒人。
 *
 * 只要求 `harness`（不需要完整的 `PostDeps`）：系统留痕（异常报告、报到）也走这里。
 * 频道不存在就什么都不写 —— 没有地方给人看，别造一个孤儿消息。
 */
export async function appendNote(
	deps: { readonly harness: Harness },
	channelId: string,
	text: string,
	at: number,
	context: Context,
): Promise<void> {
	await appendToChannel(deps, { channelId, from: OWNER, text, at, kind: "note" }, context);
}

/**
 * 任务变更最多试几次：初读一次 + 最多重读三次（Solo 2026-11-15 定）。
 *
 * **不许往上加**。次数一多，并发问题就藏在「反正会重试成功」里 —— 而静默重试正是
 * 静默覆盖的来源。三次还撞就红，让人手工看一眼。
 */
const TASK_NOTE_ATTEMPTS = 4;

/** 读到之后、落盘之前，这条任务的 `history` 被人加过。 */
export class TaskWriteConflict extends Error {
	/** 调用方以为的长度。 */
	readonly expected: number;
	/** 盘上实际的长度。 */
	readonly onDisk: number;
	constructor(expected: number, onDisk: number) {
		super(`任务在读写之间被改过：读到 ${expected} 条变更，盘上 ${onDisk} 条`);
		this.name = "TaskWriteConflict";
		this.expected = expected;
		this.onDisk = onDisk;
	}
}

/** 一次任务变更要落的东西：改完的任务 + 那条 note 的正文。 */
export type TaskNotePlan =
	| {
			/** 改完的任务，**不带**这次的那格 `history`（由实现拿 note 的真实 seq 补上）。 */
			readonly task: Task;
			/** 这次变更的种类，落进 `history` 的 `what`。 */
			readonly what: TaskHistoryEntry["what"];
			/** 那条 note 的正文：`<任务 id>：<动作>：<原因或凭据>`。 */
			readonly text: string;
	  }
	| { readonly refuse: string };

export type CommitTaskNoteInput = {
	readonly channelId: string;
	/** note 的落盘时间（调用方给，测试才好钉死）。 */
	readonly at: number;
	/** 改已有任务时给 id；新建不给，id 由这里现算（`nextTaskIdOf`）。 */
	readonly id?: string;
	/**
	 * 期望读到的 `history` 长度（乐观并发凭据）。**新建时不给**；改已有任务时给，
	 * 盘上对不上就重读重来（见 `TASK_NOTE_ATTEMPTS`）。
	 *
	 * 它是「调用方拿旧快照做的决定」的护栏：不给就等于赌没人同时在改。
	 */
	readonly expectHistoryLength?: number;
	/**
	 * 按**盘上现在的**任务算出要落的那一份。冲突重读时会再调一次，所以必须是纯的：
	 * 不许在闭包里攒状态、不许相信调用方读到的旧值。返回 `refuse` 就什么都不写。
	 *
	 * `attempt` 从 1 起：`> 1` 表示这次是「盘上已经变了、按新状态重算」——
	 * 想放弃就返回 `refuse`，别硬写。
	 *
	 * `id` 是这一笔的短 id（新建时也**已经算好**）：note 正文是 `<id>：…`，
	 * 要在同一次 commit 里写进去，所以不能在 plan 之后再分配。
	 */
	readonly plan: (current: Task | undefined, attempt: number, id: string) => TaskNotePlan;
};

export type CommitTaskNoteResult =
	| { readonly ok: true; readonly task: Task; readonly seq: number }
	| { readonly ok: false; readonly reason: "refused" | "missing"; readonly message: string };

/**
 * 改一条任务：**任务本体和那条 note 在同一次 commit 里落盘**。
 *
 * 「状态改了、聊天流里没记录」是这个实体最坏的结果 —— 人翻记录会以为没动过，
 * 而 `history` 只有一格 `{seq, what}`，解释全在那条消息里。所以这里只有一次
 * `harness.commit`：note 推不进去，任务状态也进不去（事务整体回滚）。
 *
 * 两条纪律写在代码里，不是口头约定：
 * - **`history` 只追加**，这里只会 `[...current.history, 新的一格]`；
 * - **不碰投递**：note 不唤醒、不计未读（和 `appendNote` 同一条理由）。
 */
export async function commitTaskNote(
	deps: { readonly harness: Harness },
	input: CommitTaskNoteInput,
	context: Context,
): Promise<CommitTaskNoteResult> {
	return settleTaskWrite(
		(attempt, expected) => attemptTaskNote(deps, input, context, attempt, expected),
		input.expectHistoryLength,
	);
}

type TaskAttempt<T> = { readonly kind: "conflict"; readonly onDisk: number } | { readonly kind: "done"; readonly result: T };

/**
 * 冲突重读的循环。单独拎出来是为了「一共试几次」这件事能被测到 ——
 * 藏在 `commitTaskNote` 里就只能靠造并发去撞，撞不准。
 */
export async function settleTaskWrite<T>(
	run: (attempt: number, expected: number | undefined) => Promise<TaskAttempt<T>>,
	expected: number | undefined,
): Promise<T> {
	let base = expected;
	for (let attempt = 1; attempt <= TASK_NOTE_ATTEMPTS; attempt++) {
		const outcome = await run(attempt, base);
		if (outcome.kind === "conflict") {
			if (attempt === TASK_NOTE_ATTEMPTS) throw new TaskWriteConflict(base ?? 0, outcome.onDisk);
			// 盘上变了：**不拿旧值硬写**，改以盘上为准把 `plan` 再算一遍 —— 重算时 `plan`
			// 拿到的是新状态，它可以按新状态改主意，也可以直接拒绝（`attempt > 1`）。
			base = outcome.onDisk;
			continue;
		}
		return outcome.result;
	}
	throw new Error("settleTaskWrite 的重试循环走空了");
}

async function attemptTaskNote(
	deps: { readonly harness: Harness },
	input: CommitTaskNoteInput,
	context: Context,
	attempt: number,
	expected: number | undefined,
): Promise<TaskAttempt<CommitTaskNoteResult>> {
	let settled: TaskAttempt<CommitTaskNoteResult> | undefined;
	await deps.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		if (doc.channels[input.channelId] === undefined) {
			settled = { kind: "done", result: { ok: false, reason: "missing", message: `频道不存在：${input.channelId}` } };
			return;
		}
		// 读侧一律走 `tasksOf`：老文档没有 `tasks`，也不会因为这一次读就被补上键。
		const table = tasksOf(doc, input.channelId);
		const current = input.id === undefined ? undefined : table[input.id];
		if (input.id !== undefined && current === undefined) {
			settled = { kind: "done", result: { ok: false, reason: "missing", message: `任务不存在：${input.id}` } };
			return;
		}
		const onDisk = current?.history.length ?? 0;
		if (expected !== undefined && onDisk !== expected) {
			// 读到的和盘上对不上：什么都不写，出去重读一遍再算（次数有限，见上面）。
			settled = { kind: "conflict", onDisk };
			return;
		}
		const id = input.id ?? nextTaskIdOf(table);
		const planned = input.plan(current === undefined ? undefined : plainTask(current), attempt, id);
		if ("refuse" in planned) {
			settled = { kind: "done", result: { ok: false, reason: "refused", message: planned.refuse } };
			return;
		}
		// seq 以消息本身为准，不以 `nextSeq` 为准（撞号的后果见 `appendToChannel`）。
		const highestSeq = (doc.messages[input.channelId] ?? []).reduce((max, item) => (item.seq > max ? item.seq : max), 0);
		if ((doc.nextSeq[input.channelId] ?? 1) <= highestSeq) doc.nextSeq[input.channelId] = highestSeq + 1;
		const next = appendMessage(doc, input.channelId, {
			from: OWNER,
			text: planned.text,
			at: input.at,
			kind: "note",
			noteOf: "task",
		});
		const written: Task = {
			...planned.task,
			id,
			channelId: input.channelId,
			// 只追加：这一格是这次变更的凭据，正文在那条 note 里。
			history: [...planned.task.history, { seq: next.message.seq, what: planned.what }],
		};
		// 表不存在就整段写进去；存在就按路径写一格。
		// **别用 `??=` 的返回值**：`doc.tasks[ch] ??= {}` 给你的是那个字面量 `{}`，
		// 不是代理，往里写不进盘（和 `doc.messages[ch] ??= []` 同一个坑）。
		doc.tasks ??= {};
		const stored = doc.tasks[input.channelId];
		if (stored === undefined) doc.tasks[input.channelId] = { [id]: written };
		else (stored as Record<string, Task>)[id] = written;
		// 消息同样按路径 push：整段赋值会让「追加一条」退化成「重写整个频道」。
		doc.messages[input.channelId] ??= [];
		(doc.messages[input.channelId] as Message[]).push(next.message);
		doc.nextSeq[input.channelId] = next.message.seq + 1;
		settled = { kind: "done", result: { ok: true, task: { ...written, history: [...written.history] }, seq: next.message.seq } };
	}, context);
	if (settled === undefined) throw new Error("commitTaskNote 的事务没有给出结果");
	return settled;
}

/** 事务里的任务抄成纯对象：`history` 是数组，直接带出去就成代理了。 */
function plainTask(task: Task): Task {
	return { ...task, history: task.history.map((entry) => ({ seq: entry.seq, what: entry.what })) };
}
