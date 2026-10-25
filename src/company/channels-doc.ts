/**
 * 频道文档的定义。
 *
 * 单独一个文件：`channels.ts`（IO）与 `deliver.ts`（投递）都需要它，
 * 放在任一方都会形成循环 import。
 */
import { defineDoc } from "../runtime/index.ts";
import { emptyChannelState, type ChannelState } from "../domain/channels.ts";

/** 频道文档。 */
export const ChannelDoc = defineDoc<ChannelState>({
	kind: "app.channels",
	version: 1,
	scope: "session",
	initial: () => emptyChannelState(),
	/**
	 * 频道消息是只增数组，永远不 checkpoint 会让每次读都从头重放全部 delta。
	 * 与底层 codemode 的策略一致（`deltasSinceBase >= 64`）。
	 */
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});
