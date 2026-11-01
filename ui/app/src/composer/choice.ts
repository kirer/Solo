/**
 * 「等我选」的那一条消息。
 *
 * 判据只看数据：**最后一条带 `options` 的消息**，它之后没有我的回复 —— 那就是还在等我拍板。
 * 回答不另开路由：我发的下一条消息就是回答（带 `replyTo` 指向它，选项文字就是正文）。
 *
 * 为什么「我之后说过话」也算答过：万一我直接打字回了一句「都不对，换个思路」，
 * 那是回答了，只是没用选项卡 —— 再弹一次选框反而是打断。
 */
import type { Message } from "../api/types.ts";

export type PendingChoice = {
	readonly seq: number;
	readonly fromLabel: string;
	readonly text: string;
	readonly options: readonly string[];
};

export function pendingChoice(messages: readonly Message[], me = "owner"): PendingChoice | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === undefined) continue;
		if (message.fromSlug === me) return undefined;
		if (message.options === undefined || message.options.length === 0) continue;
		return {
			seq: message.seq,
			fromLabel: message.fromLabel,
			text: message.text,
			options: message.options,
		};
	}
	return undefined;
}
