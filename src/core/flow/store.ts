/**
 * `MessageStore` 的默认实现：接在 `channel/write.ts` 上。
 *
 * 落盘的唯一实现在 `write.ts`（seq 自愈、路径式 push、一次 commit），这里只把
 * 「这次调用用的频道快照」包成端口。快照由调用方给：`say` / `finish` / `ownerSpeak`
 * 都是「先读、再提交」的用法，读到的对象必须在提交之后还能用（见
 * `tools/context.ts` 的 `readState` 注释）。
 */
import type { Context, Harness } from "../runtime/index.ts";
import { ChannelDoc, emptyChannelState } from "../channel/types.ts";
import type { Channel, ChannelState, Message } from "../channel/types.ts";
import { appendNote, appendToChannel } from "../channel/write.ts";
import type { MessageStore } from "./ports.ts";
import type { ChannelSnapshot, NoteInput, PublishInput } from "./types.ts";

export function createMessageStore(deps: {
	readonly harness: Harness;
	/**
	 * 本次调用读到的频道快照（提交之后仍可读的纯数据）。
	 *
	 * 不给就每次现读：收尾（`settle`）发生在结算之后，没有「本次调用的快照」可用，
	 * 必须读当下的盘。
	 */
	readonly state?: ChannelState;
}): MessageStore {
	const snapshot = async (ctx: Context): Promise<ChannelState> =>
		deps.state ?? ((await deps.harness.snapshot(ChannelDoc, ctx)) ?? emptyChannelState());

	return {
		snapshot,
		async read(channelId: string, ctx: Context): Promise<ChannelSnapshot | undefined> {
			const state = await snapshot(ctx);
			const channel = state.channels[channelId];
			if (channel === undefined) return undefined;
			return {
				state,
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
