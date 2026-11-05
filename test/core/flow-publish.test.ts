/**
 * `publish` 的分支：谁被叫、谁不被叫、哪一步失败。
 *
 * 用假端口（store / runner），不碰真库与真模型 —— 这正是把 flow 抽出来的理由：
 * 「一条消息该去哪」可以脱离投递实现单独断言。
 */
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { createFlow } from "../../src/core/flow/index.ts";
import type { FlowPorts, MessageStore, Router } from "../../src/core/flow/ports.ts";
import { defaultRouter } from "../../src/core/flow/defaults/router.ts";
import { defaultSettler } from "../../src/core/flow/defaults/settle.ts";
import type { Channel, ChannelState, Message } from "../../src/core/channel/types.ts";

function makeWorld() {
	const channel: Channel = {
		id: "group:demo",
		title: "演示群",
		members: ["owner", "a", "b"],
		wakeOnAll: ["a"],
		createdAt: 1,
	};
	const state: ChannelState = {
		channels: { [channel.id]: channel },
		messages: {},
		nextSeq: { [channel.id]: 1 },
		readMarks: {},
	};
	const calls = {
		append: 0,
		fanOut: 0,
		hook: 0,
		fanOutTargets: undefined as readonly string[] | undefined,
		fanOutReason: undefined as string | undefined,
	};
	const store: MessageStore = {
		async snapshot() {
			return state;
		},
		async read() {
			return { state, channel };
		},
		async append(input) {
			calls.append += 1;
			const message: Message = {
				seq: 1,
				from: input.from,
				at: input.at,
				text: input.text,
				mentions: input.mention === undefined ? [] : [...input.mention],
				kind: input.kind ?? "chat",
			};
			return { channel, message };
		},
		async note() {},
	};
	const ports = (routers: readonly Router[] = [defaultRouter()]): FlowPorts => ({
		store,
		routers,
		settler: defaultSettler(),
		gate: { publish: (fn) => fn(), repost: (fn) => fn() },
		runner: {
			async fanOut(args) {
				calls.fanOut += 1;
				calls.fanOutTargets = args.plan.targets;
				calls.fanOutReason = args.plan.reason;
				return { delivered: [...args.plan.targets], failed: [], skipped: [] };
			},
		},
		hooks: {
			async afterPublish() {
				calls.hook += 1;
			},
		},
	});
	return { channel, state, calls, ports };
}

const input = {
	channelId: "group:demo",
	from: "owner",
	text: "开会了",
	at: 10,
};

describe("publish", () => {
	it("按内置规则叫人：我不 @ 人时接上一个说话的（这里是唯一成员 a）", async () => {
		const world = makeWorld();
		const flow = createFlow(world.ports());
		const result = await flow.publish(input, BACKGROUND_CONTEXT);

		expect(world.calls.append).toBe(1);
		expect(world.calls.fanOutTargets).toEqual(["a"]);
		expect(world.calls.fanOutReason).toBe("default");
		expect(world.calls.hook).toBe(1);
		expect(result.message.seq).toBe(1);
		expect(result.delivery.delivered).toEqual(["a"]);
	});

	it("note 默认谁也不叫，但仍算一次公开落盘（钩子照常）", async () => {
		const world = makeWorld();
		const flow = createFlow(world.ports());
		await flow.publish({ ...input, kind: "note", text: "系统留痕" }, BACKGROUND_CONTEXT);

		expect(world.calls.append).toBe(1);
		expect(world.calls.fanOut).toBe(0);
		expect(world.calls.hook).toBe(1);
	});

	it("wake: false 明确不叫", async () => {
		const world = makeWorld();
		const flow = createFlow(world.ports());
		await flow.publish({ ...input, wake: false }, BACKGROUND_CONTEXT);

		expect(world.calls.fanOut).toBe(0);
		expect(world.calls.hook).toBe(1);
	});

	it("wakeTo 跳过策略，原样交给投递", async () => {
		const world = makeWorld();
		let asked = false;
		const never: Router = {
			async decide() {
				asked = true;
				return { kind: "targets", targets: ["a"], reason: "不该到这里" };
			},
		};
		const flow = createFlow(world.ports([never, defaultRouter()]));
		await flow.publish({ ...input, kind: "note", text: "跑完了", wakeTo: ["b"] }, BACKGROUND_CONTEXT);

		expect(asked).toBe(false);
		expect(world.calls.fanOutTargets).toEqual(["b"]);
		expect(world.calls.fanOutReason).toBe("wakeTo");
	});

	it("策略提了房间外的人：校验后不投，但消息已经落盘", async () => {
		const world = makeWorld();
		const outsider: Router = {
			async decide() {
				return { kind: "targets", targets: ["outsider"], reason: "策略越界" };
			},
		};
		const flow = createFlow(world.ports([outsider]));
		const result = await flow.publish(input, BACKGROUND_CONTEXT);

		expect(world.calls.append).toBe(1);
		expect(world.calls.fanOut).toBe(0);
		expect(result.delivery.delivered).toEqual([]);
		expect(world.calls.hook).toBe(1);
	});

	it("钩子抛错不影响这次发布（消息已经落盘）", async () => {
		const world = makeWorld();
		const ports = world.ports();
		const flow = createFlow({
			...ports,
			hooks: {
				async afterPublish() {
					throw new Error("插件坏了");
				},
			},
		});
		await expect(flow.publish(input, BACKGROUND_CONTEXT)).resolves.toMatchObject({ message: { seq: 1 } });
	});

	it("频道不存在：不落盘、不扇出", async () => {
		const world = makeWorld();
		const flow = createFlow({
			...world.ports(),
			store: {
				...world.ports().store,
				async read() {
					return undefined;
				},
			},
		});
		await expect(flow.publish(input, BACKGROUND_CONTEXT)).rejects.toThrow("频道不存在");
		expect(world.calls.append).toBe(0);
		expect(world.calls.fanOut).toBe(0);
	});

	it("落盘时频道被删：抛错，不扇出", async () => {
		const world = makeWorld();
		const flow = createFlow({
			...world.ports(),
			store: {
				...world.ports().store,
				async append() {
					return undefined;
				},
			},
		});
		await expect(flow.publish(input, BACKGROUND_CONTEXT)).rejects.toThrow("频道不存在");
		expect(world.calls.fanOut).toBe(0);
	});
});
