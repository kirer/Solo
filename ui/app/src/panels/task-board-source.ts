/**
 * 任务看板的数据源：把频道里存的 `Task` 翻成看板要的 `BoardTask`（2.9.20）。
 *
 * 为什么不直接 `import type { Task } from "../../../../src/core/channel/types.ts"`：
 * 界面只吃 `src/view/dto.ts` 的投影（分层规矩，`npm run check` 的边界检查会拦）。
 * `ViewChannelDetail.tasks`（`ViewTask`）是 2.9.20 接上的，这里仍按**字段结构**收：
 * 投影再加字段时，这个文件跟着补一格就够，不用去认核心那层的类型。
 *
 * 空表就是空板 —— 不塞假数据（Solo 2026-11-15：接口没落地不许挂假任务，老板看到
 * 「季衡 弹窗验收卡住 3 天」比没做更坏）。
 */

import type { BoardTask } from "./task-board-model.ts";

/** `Task` 里界面用得到的那些字段。缺 `goal`（不上板）、`history` 只读最后一格。 */
export type BoardTaskIn = {
	id: string;
	title: string;
	owner: string;
	status: BoardTask["status"];
	channelId: string;
	originSeq: number;
	accept?: string | undefined;
	history: readonly { seq: number; what: string }[];
	/**
	 * 全局那份（`ViewOrg.tasks`）多带的两个：最后一次变更的时间、那句正文压成一行。
	 * 频道自己那份不带（它从 `messages` 里现查）。缺 = 这份数据里没有。
	 */
	changedAt?: number | undefined;
	note?: string | undefined;
};

/**
 * 界面这一侧对「频道详情」的最小要求。
 *
 * 除了 `tasks`，其余几格 `ViewChannelDetail` 上都已经有了（`channel.title`、
 * `members`、`messages`），所以传真的 detail 进来是这个类型的子集，现在就能编过。
 */
export type BoardSource = {
	channel?: { title?: string | undefined } | undefined;
	/** 成员的显示名在 `label` 上（`ViewMember.label`）—— 读 `name` 会一路退成 slug。 */
	members?: readonly { slug?: string | undefined; label?: string | undefined }[] | undefined;
	messages?: readonly { seq: number; at: number; text?: string | undefined }[] | undefined;
	tasks?: Record<string, BoardTaskIn> | undefined;
};

/**
 * 这个频道的任务。**读侧不补键**：老文档没有 `tasks`、接口还没发回来的时候，
 * 这里给空表，绝不往 detail 上塞一个 `{}` —— 那等于「读一次就改一次数据」。
 */
export function channelTasks(detail: BoardSource | null | undefined): BoardTaskIn[] {
	if (detail?.tasks === undefined) return [];
	return Object.values(detail.tasks);
}

/** 变更那条消息的正文压成一行：`blocked` 的原因、`done` 的凭据都从这里来。 */
function firstLine(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const line = text
		.split("\n")
		.map((one) => one.replace(/^\s*(?:[>#*+-]+\s*)?/, "").trim())
		.find((one) => one !== "");
	if (line === undefined) return undefined;
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * 翻开板要的那几格。
 *
 * 两处拿不到就退：
 * - 名字：成员已经不在这个频道（调走了、开除了）→ 用 slug 顶，头像照画；
 * - 时间：那次变更的消息不在这一页历史里 → 按「刚动过」算。宁可显示「刚动过」，
 *   也别拿 `0` 算成「1970 年到现在」，那会在板上写出「20693 天没动」。
 */
export function boardTasks(detail: BoardSource | null | undefined, now: number): BoardTask[] {
	const tasks = channelTasks(detail);
	if (tasks.length === 0) return [];
	const title = detail?.channel?.title ?? "";
	const labelOf = new Map<string, string>();
	for (const member of detail?.members ?? []) {
		if (member.slug !== undefined && member.label !== undefined) labelOf.set(member.slug, member.label);
	}
	const atOf = new Map<number, number>();
	const textOf = new Map<number, string>();
	for (const message of detail?.messages ?? []) {
		atOf.set(message.seq, message.at);
		if (message.text !== undefined) textOf.set(message.seq, message.text);
	}

	return tasks.map((task) => {
		const last = task.history[task.history.length - 1];
		const seq = last?.seq;
		const at = seq === undefined ? undefined : atOf.get(seq);
		const note = seq === undefined ? undefined : firstLine(textOf.get(seq));
		return {
			id: task.id,
			title: task.title,
			owner: task.owner,
			ownerLabel: labelOf.get(task.owner) ?? task.owner,
			status: task.status,
			channelId: task.channelId,
			channelTitle: title,
			originSeq: task.originSeq,
			accept: task.accept,
			note,
			changedAt: at ?? now,
		};
	});
}

/** 全局板（顶栏那个常驻入口）的输入：跨频道的活 + 频道名与人名怎么查。 */
export type GlobalBoardSource = {
	/** `ViewOrg.tasks`：所有频道、所有状态一次给全。`undefined` = 这一份还没到。 */
	tasks: readonly BoardTaskIn[] | undefined;
	/** 频道 id → 标题。查不到就退回 id（`team:Solo` 这种），比留空强。 */
	channelTitleOf: (channelId: string) => string;
	labelOf: (slug: string) => string;
};

/**
 * 把跨频道那份翻成板上一行。
 *
 * 跟 `boardTasks` 的区别只有一处：**没有 `messages` 可查**，所以「多久没动」「卡住的原因」
 * 只能靠核心在那份数据上直接带（`changedAt` / `note`）。没带就不编：时间写「不知道多久
 * 没动」、原因写「原因在频道里」，别拿 `now` 顶成「刚动过」、也别把「没拿到」说成
 * 「没写」（Solo 2026-11-16：全局板上每一行都得是真话，否则不如不给看）。
 *
 * 顺序不排：核心给的就是「按频道顺序、频道内按编号升序」，那是有意义的稳定序；
 * 组内谁先谁后是 `boardOf` 的显示规则，不在这儿再排一次。
 */
/**
 * 全局那份 `note` 是「动作 + 原因」拼成的一句（`改成卡住：等路远把投影推上来`），
 * 板上那一栏要的是后半句。剥不干净就原样留着 —— 宁可多几个字，也别把原因弄丢。
 */
function stripAction(note: string): string {
	const cut = note.replace(/^(?:建了一条|改成[^：:]*|转给[^：:]*|验收[^：:]*|撤了|打断[^：:]*)[：:]\s*/, "").trim();
	return cut === "" ? note : cut;
}

export function globalBoardTasks(source: GlobalBoardSource): BoardTask[] {
	const tasks = source.tasks;
	if (tasks === undefined || tasks.length === 0) return [];
	return tasks.map((task) => ({
		id: task.id,
		title: task.title,
		owner: task.owner,
		ownerLabel: source.labelOf(task.owner),
		status: task.status,
		channelId: task.channelId,
		channelTitle: source.channelTitleOf(task.channelId),
		originSeq: task.originSeq,
		accept: task.accept,
		note: task.note === undefined ? undefined : stripAction(task.note),
		// 带没带正文：`note` 这个键在不在这份数据里。带了我就不该说「没写」。
		noteKnown: task.note !== undefined,
		changedAt: task.changedAt ?? undefined,
	}));
}

/**
 * 顶栏那颗按钮上的数：板上**活的**条数。
 *
 * 跟 `boardOf` 同一个口径 —— `done` / `dropped` 都不算（划掉的活不该在任何人眼前占一个数，
 * 更不该在顶栏上亮着）。数据没到（`undefined`）就是 0，按钮照样在，只是不出数字。
 */
export function liveCount(tasks: readonly BoardTaskIn[] | undefined): number {
	return (tasks ?? []).filter((task) => task.status !== "done" && task.status !== "dropped").length;
}
