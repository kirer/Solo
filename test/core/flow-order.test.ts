/**
 * 顺序：闸门包住「读 → 落盘 → 扇出」，钩子在闸门之外。
 *
 * 这一条是有意的：钩子是插件听消息，慢了或抛错都不能占着频道写入的串行闸；
 * 而读—算—提交必须在闸里，否则两个 `say` 会互相踩（ADR-073）。
 */
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { createFlow } from "../../src/core/flow/index.ts";
import type { FlowPorts, MessageStore } from "../../src/core/flow/ports.ts";
import { defaultRouter } from "../../src/core/flow/defaults/router.ts";
import type { Channel, ChannelState, Message } from "../../src/core/channel/types.ts";

const channel: Channel = {
	id: "group:demo",
	title: "演示群",
	members: ["owner", "a", "b"],
	wakeOnAll: ["a"],
	createdAt: 1,
};
const existing: Message = {
	seq: 7,
	from: "owner",
	at: 5,
	text: "@a 看一下",
	mentions: ["a"],
	kind: "chat",
};
const state: ChannelState = {
	channels: { [channel.id]: channel },
	messages: { [channel.id]: [existing] },
	nextSeq: { [channel.id]: 8 },
	readMarks: {},
};

function makePorts(events: string[]): FlowPorts {
	const store: MessageStore = {
		async read() {
			events.push("read");
			return { state, channel };
		},
		async append(input) {
			events.push("append");
			return {
				channel,
				message: { seq: 8, from: input.from, at: input.at, text: input.text, mentions: [], kind: input.kind ?? "chat" },
			};
		},
		async note() {
			events.push("note");
		},
	};
	return {
		store,
		routers: [defaultRouter()],
		gate: async (fn) => {
			events.push("gate:start");
			const result = await fn();
			events.push("gate:end");
			return result;
		},
		runner: {
			async fanOut(args) {
				events.push(`fanOut:${args.plan.targets.join(",")}`);
				return { delivered: [...args.plan.targets], failed: [], skipped: [] };
			},
		},
		hooks: {
			async afterPublish(_message, channelId) {
				events.push(`hook:${channelId}`);
			},
		},
	};
}

describe("flow 的顺序", () => {
	it("publish：闸内读—落盘—扇出，闸外钩子", async () => {
		const events: string[] = [];
		await createFlow(makePorts(events)).publish(
			{ channelId: channel.id, from: "owner", text: "开会了", at: 11 },
			BACKGROUND_CONTEXT,
		);

		expect(events).toEqual(["gate:start", "read", "append", "fanOut:a", "gate:end", "hook:group:demo"]);
	});

	it("forward：只读与扇出，不写消息、不调公开钩子", async () => {
		const events: string[] = [];
		const delivery = await createFlow(makePorts(events)).forward(
			{ channelId: channel.id, seq: 7, targets: ["a", "b"], routedBy: "assistant" },
			BACKGROUND_CONTEXT,
		);

		// 已经在正文里 @ 过的人不重复叫。
		expect(events).toEqual(["read", "fanOut:b"]);
		expect(delivery.delivered).toEqual(["b"]);
	});
});
