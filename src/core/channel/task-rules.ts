/**
 * 任务的两套规矩：**状态机能怎么走**、**谁能按**。
 *
 * 单独一个文件、**纯函数、不碰盘也不碰文案**，因为这两件事最容易被后来的改动弄松：
 * 松掉一格（比如顺手允许 `done → doing`）不会让任何测试红，只会让「历史断了」这件事
 * 悄悄发生。文案与拒绝话术在工具层（`tools/task.ts`），这里只回答「行不行、为什么」。
 *
 * 规矩的出处：设计第七节（权限矩阵）、第九节（状态机）。两边改一处必须同改另一处。
 */
import type { Task, TaskStatus } from "./types.ts";

/**
 * 状态转移表（设计第九节逐字抄过来）。
 *
 * 带 `*` 的两处必须带原因，由 `checkMove` 的 `note` 参数守。
 * **`done` / `dropped` 是终态**：要复活就新建一条，老的留着 —— 允许回退等于让
 * 「这件事做到哪」变成可以倒着走的时间线。
 */
const MOVES: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
	open: ["doing", "dropped"],
	doing: ["open", "blocked", "done", "dropped"],
	blocked: ["open", "doing", "done", "dropped"],
	done: [],
	dropped: [],
};

/** 必须带原因才能进去的状态。原因不是可选项：说不清卡在哪就该留在 `doing`。 */
const NEEDS_NOTE: readonly TaskStatus[] = ["blocked", "dropped"];

export type MoveRefusal = "same" | "terminal" | "invalid" | "note";

export type MoveCheck = { readonly ok: true } | { readonly ok: false; readonly why: MoveRefusal };

/**
 * 能不能从 `from` 走到 `to`。
 *
 * 四种拒法分开给，因为说得出口的话不一样：`same` 是「它已经这样了」，
 * `terminal` 是「划掉/做完的不能倒回来」，`invalid` 是「这一步不存在」，
 * `note` 是「写清原因再改」。
 */
export function checkMove(from: TaskStatus, to: TaskStatus, note: string | undefined): MoveCheck {
	if (from === to) return { ok: false, why: "same" };
	if (MOVES[from].length === 0) return { ok: false, why: "terminal" };
	if (!MOVES[from].includes(to)) return { ok: false, why: "invalid" };
	const said = note?.trim() ?? "";
	if (said === "" && NEEDS_NOTE.includes(to)) return { ok: false, why: "note" };
	return { ok: true };
}

/** 一个成员能对自己名下的任务做什么（设计第七节）。 */
export type TaskChange =
	| { readonly kind: "status"; readonly to: TaskStatus }
	| { readonly kind: "owner"; readonly owner: string }
	| { readonly kind: "accept"; readonly accept: string };

export type PermissionRefusal =
	/** 不是他名下的。 */
	| "not-owner"
	/** 成员不能自己划掉。 */
	| "dropped"
	/** 换负责人只有助理能改。 */
	| "assign"
	/** 新建只有助理能做。 */
	| "add";

export type PermissionCheck = { readonly ok: true } | { readonly ok: false; readonly why: PermissionRefusal };

/**
 * 谁能改这一条。
 *
 * **助理全能**（它替老板落），成员只在自己名下能动，而 `dropped` 连自己名下也不行 ——
 * 做不完就报卡住，划不划是派活的人的事。这一条最容易在「顺手让人自己清理」的改动里
 * 破掉，所以拿测试钉住（见 `test/core/task-rules.test.ts`）。
 */
export function checkPermission(
	actor: { readonly slug: string; readonly assistant: boolean },
	task: Pick<Task, "owner">,
	change: TaskChange,
): PermissionCheck {
	if (actor.assistant) return { ok: true };
	if (change.kind === "owner") return { ok: false, why: "assign" };
	if (task.owner !== actor.slug) return { ok: false, why: "not-owner" };
	if (change.kind === "accept") return { ok: true };
	if (change.to === "dropped") return { ok: false, why: "dropped" };
	return { ok: true };
}

/** 能不能建一条：只有助理。 */
export function canCreate(actor: { readonly assistant: boolean }): PermissionCheck {
	return actor.assistant ? { ok: true } : { ok: false, why: "add" };
}
