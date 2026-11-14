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
