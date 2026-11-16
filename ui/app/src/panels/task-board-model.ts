/**
 * 任务看板的形状（2.9.20）。数据形状按 `teams/Solo/workspace/2.9.19-任务实体设计.md`
 * 第三节的 `Task`；接口还没实现，所以这里先自己声明一份前端侧的类型 —— 接口上来之后
 * 要么被 `api/types.ts` 的同名类型替掉，要么改 import，别两边各长一个。
 *
 * 界面只认三样（老板 2026-11-14 定的）：
 *   1. 顶上一行「在做 N 条、卡住 M 条」；
 *   2. 抽屉里一条一行（谁、做什么、多久没动，卡住标红带原因）；
 *   3. 做完的折成「今天完成 K 条」一行 —— **板上只剩活的**。
 *
 * 第 3 条不是省地方，是保命：板子被做完的活堆满之后，真正在等的那几条就沉下去了，
 * 那正是这个实体要解决的问题（设计文档第一节）。所以 `done` / `dropped` 一条都不进
 * `live`，`dropped` 连计数都不给 —— 划掉的活不该在任何人眼前占一个数。
 */

export type TaskStatus = "open" | "doing" | "blocked" | "done" | "dropped";

/** 板上的一行。指向起源只靠 `channelId + originSeq` 两个指针，不复制消息正文。 */
export type BoardTask = {
	id: string;
	/** 一句话，≤80 字。超了是写入侧的问题，界面照原样显示，不在这里截。 */
	title: string;
	owner: string;
	/** 头像和名字都要，所以标签也跟着来 —— 界面不去名册里反查（那个人可能已经不在）。 */
	ownerLabel: string;
	status: TaskStatus;
	channelId: string;
	channelTitle: string;
	/** 起源：派活那条消息的 seq。点一行就跳回它。 */
	originSeq: number;
	accept?: string | undefined;
	/** `blocked` 的原因 / `done` 的凭据。一行，不带换行。 */
	note?: string | undefined;
	/**
	 * 这一份数据里**到底带没带正文**。
	 *
	 * 只有全局板会写 `false`：跨频道那一份只给 `history` 的 `seq`，note 的正文在频道里，
	 * 界面上不去查。这时「没写原因」是句假话（人家可能写了），得说「原因在频道里」。
	 * 缺省当 `true` —— 频道自己那份始终能查到。
	 */
	noteKnown?: boolean | undefined;
	/**
	 * 最后一次状态变更的时刻。「多久没动」按它算，不按创建时间。
	 *
	 * `undefined` = 这份数据没带时间（全局板要等核心补上那格）：界面上写「不知道多久
	 * 没动」，不拿 `now` 顶成「刚动过」—— 那会让三天没动的活看着像刚有人碰过。
	 */
	changedAt?: number | undefined;
};

export type Board = {
	/** 活的：`blocked` → `doing` → `open`，组内最久没动的在前。 */
	live: BoardTask[];
	doing: number;
	blocked: number;
	pending: number;
	/** 今天改完的，最近的在前。 */
	doneToday: BoardTask[];
	doneTodayCount: number;
	empty: boolean;
};

const DAY_MS = 86_400_000;

/** 本地时间的今天 0 点。`doneToday` 的边界按它算，不按 UTC —— 用户看的「今天」是本地的。 */
function startOfDay(now: number): number {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

export function idleMs(task: BoardTask, now: number): number | undefined {
	if (task.changedAt === undefined) return undefined;
	const ms = now - task.changedAt;
	// 时钟偏了（或者服务端给的是未来时刻）就按「刚动过」算，不显示「-3 分钟没动」。
	if (!Number.isFinite(ms) || ms < 0) return 0;
	return ms;
}

/** 「多久没动」：刚动过 / 12 分钟没动 / 3 小时没动 / 2 天没动；没带时间就说不知道。 */
export function idleLabel(task: BoardTask, now: number): string {
	const ms = idleMs(task, now);
	if (ms === undefined) return "没说多久没动";
	if (ms < 60_000) return "刚动过";
	if (ms < 3_600_000) return `${String(Math.floor(ms / 60_000))} 分钟没动`;
	if (ms < DAY_MS) return `${String(Math.floor(ms / 3_600_000))} 小时没动`;
	return `${String(Math.floor(ms / DAY_MS))} 天没动`;
}

/** 卡住的原因。空的说明数据坏了 —— 工具层不许 `blocked` 不带原因（设计文档第七节）。 */
export function blockedReason(task: BoardTask): string {
	const note = (task.note ?? "").trim();
	if (note !== "") return note;
	// 全局那份不带正文：不能说「没写原因」，人家可能写了，只是这一份数据里没有。
	return task.noteKnown === false ? "原因在频道里，点开回到原话" : "没写原因";
}

/** 完成项的凭据。`done` 允许留空，界面上就明说没写，不替它编一句。 */
export function doneProof(task: BoardTask): string {
	const note = (task.note ?? "").trim();
	if (note !== "") return note;
	return task.noteKnown === false ? "凭据在频道里，点开回到原话" : "没写凭据";
}

const RANK: Record<"blocked" | "doing" | "open", number> = { blocked: 0, doing: 1, open: 2 };

/**
 * 一次算出板上要的三样。
 *
 * 排序按「卡住的最前」而不是按时间混排：卡住的活是唯一需要人去动的东西，它掉到
 * 第 7 行就等于没被看见。同组里最久没动的在前，因为「三天没动」比「两分钟前刚动」
 * 更值得先看一眼。
 */
export function boardOf(tasks: readonly BoardTask[], now: number): Board {
	const today = startOfDay(now);
	const live: BoardTask[] = [];
	const doneToday: BoardTask[] = [];

	for (const task of tasks) {
		if (task.status === "done") {
			if ((task.changedAt ?? now) >= today) doneToday.push(task);
			continue;
		}
		// `dropped` 是终态、且是「不做了」：不进板、不计数（设计文档第十二节：划掉留痕
		// 在频道里，不在这里占一行）。
		if (task.status === "dropped") continue;
		live.push(task);
	}

	live.sort((left, right) => {
		const diff = RANK[left.status as "blocked" | "doing" | "open"] - RANK[right.status as "blocked" | "doing" | "open"];
		// 没带时间的当「刚动过」排后面：不知道多久没动的，不该插到「卡了三天」前面去。
		return diff !== 0 ? diff : (left.changedAt ?? now) - (right.changedAt ?? now);
	});
	doneToday.sort((left, right) => (right.changedAt ?? now) - (left.changedAt ?? now));

	const count = (status: TaskStatus): number => live.filter((task) => task.status === status).length;
	return {
		live,
		doing: count("doing"),
		blocked: count("blocked"),
		pending: count("open"),
		doneToday,
		doneTodayCount: doneToday.length,
		empty: live.length === 0 && doneToday.length === 0,
	};
}

/**
 * 顶上那一行。不在真有数的时候写那个数 ——「在做 0 条」不是统计，是一句噪音。
 *
 * 形状固定是「在做 N 条 · 卡住 M 条」，`待办` 只在有 `open` 时补在后面：老板没要这个数，
 * 但板上明明有活、顶上写着「在做 0 条」会更让人糊涂。
 */
export function topLine(board: Board): string {
	if (board.empty) return "板上没有活";
	const parts: string[] = [];
	// 0 条不写：只有待办时顶上是「待办 2 条」，不是「在做 0 条 · 待办 2 条」。
	if (board.doing > 0) parts.push(`在做 ${String(board.doing)} 条`);
	if (board.blocked > 0) parts.push(`卡住 ${String(board.blocked)} 条`);
	if (board.pending > 0) parts.push(`待办 ${String(board.pending)} 条`);
	return parts.join(" · ");
}

/** 完成那一行：`今天完成 K 条`。0 条时返回空串（调用方就不画这一行）。 */
export function doneLine(board: Board): string {
	if (board.doneTodayCount === 0) return "";
	return `今天完成 ${String(board.doneTodayCount)} 条`;
}
