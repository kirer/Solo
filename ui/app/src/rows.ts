/**
 * 行级规则。
 *
 * ADR-081 之后这里只剩一条：**这一条要不要我处理**（顶栏「N 件找你」与左侧 2px 竖线
 * 的唯一来源）。过程行（think / tool / work）、step 合并、「正在处理」占位、「正在说」
 * 草稿全部删掉了 —— 屏幕上只有真实消息，见 `stream/model.ts`。
 */

import type { Message } from "./api/types.ts";

/** 判定「需要你」真正用到的字段。 */
export type MsgLike = {
	kind?: string | undefined;
	fromSlug?: string | undefined;
	mentions?: { id: number }[] | undefined;
};

export type AnyMsg = MsgLike | Message | undefined;

/** 一条消息是不是「需要你」。owner 的 id 恒为 0。 */
export function isNeed(message: AnyMsg) {
	if (!message) return false;
	if (message.fromSlug === "owner") return false;
	// 提问，且点名了我。
	if (message.kind === "question") {
		return Array.isArray(message.mentions) && message.mentions.some((m) => m.id === 0);
	}
	return false;
}
