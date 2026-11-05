/**
 * `MessageStore` 的默认实现：接在 `channel/write.ts` 上。
 *
 * 落盘的唯一实现在 `write.ts`（seq 自愈、路径式 push、一次 commit），这里只把
 * 「这次调用用的频道快照」包成端口。快照由调用方给：`say` / `finish` / `ownerSpeak`
 * 都是「先读、再提交」的用法，读到的对象必须在提交之后还能用（见
 * `tools/context.ts` 的 `readState` 注释）。
 */
import type { Context, Harness } from "../runtime/index.ts";
import type { Channel, ChannelState, Message } from "../channel/types.ts";
import { appendNote, appendToChannel } from "../channel/write.ts";
import type { MessageStore } from "./ports.ts";
import type { ChannelSnapshot, NoteInput, PublishInput } from "./types.ts";

export function createMessageStore(deps: {
	readonly harness: Harness;
	/** 本次调用读到的频道快照（提交之后仍可读的纯数据）。 */
	readonly state: ChannelState;
}): MessageStore {
	return {
		async read(channelId: string, _ctx: Context): Promise<ChannelSnapshot | undefined> {
			const channel = deps.state.channels[channelId];
			if (channel === undefined) return undefined;
			return {
				state: deps.state,
				channel: { ...channel, members: [...channel.members], wakeOnAll: [...channel.wakeOnAll] },
			};
		},
		async append(
			input: PublishInput,
			ctx: Context,
		): Promise<{ readonly channel: Channel; readonly message: Message } | undefined> {
			return appendToChannel(deps, input, ctx);
		},
		async note(input: NoteInput, ctx: Context): Promise<void> {
			await appendNote(deps, input.channelId, input.text, input.at, ctx);
		},
	};
}
