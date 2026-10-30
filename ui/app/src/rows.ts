/**
 * 行级规则。
 *
 * 这里只剩一条：**这一条要不要我处理**（顶栏「N 件找你」与左侧 2px 竖线的唯一来源）。
 *
 * 判据在后端（`project.ts` 的 `needsYou`：显式 @ 我，或问句点名我），界面只读
 * `needsYou` 这个字段。以前这里自己猜「kind === question 且 mentions 里有 0」，
 * 猜漏了 `needsYou` 已经判出来的那一半 —— 两份判据迟早不一致。
 */

import type { Message } from "./api/types.ts";

/** 判定「需要你」真正用到的字段。 */
export type MsgLike = {
	needsYou?: true | undefined;
	fromSlug?: string | undefined;
};

export type AnyMsg = MsgLike | Message | undefined;

/** 一条消息是不是「需要你」。我自己说的话永不算。 */
export function isNeed(message: AnyMsg): boolean {
	if (!message) return false;
	if (message.fromSlug === "owner") return false;
	return message.needsYou === true;
}
