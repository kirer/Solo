/**
 * 频道的共享指令与接话规则：建群时能带、建完能改、私聊没有这两样。
 *
 * 接话规则怎么算人由 `channel-responder.test.ts` 守；这里只守**落盘与校验**：
 * 写进去的东西投影读得回来，不合法的不进库，私聊不出现这两个键。
 */
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import type { CoreRuntime } from "../../src/core/runtime/open.ts";
import { createChat } from "../../src/app/chat.ts";
import { createAgent } from "../../src/core/documents/member/identity.ts";
import { ChannelDoc, type ChannelState } from "../../src/core/channel/types.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

const ME = "林越";
const OTHER = "知言";

async function setup(): Promise<{ chat: ReturnType<typeof createChat>; runtime: CoreRuntime }> {
	const box = await pool.make("core-channel-settings-");
	await createAgent({ root: box.agentsRoot, name: ME, title: "负责人", manager: "owner" });
	await createAgent({ root: box.agentsRoot, name: OTHER, title: "开发", manager: "owner" });
	const runtime = await box.open();
	const shell = await box.assemble(runtime);
	return { chat: createChat(shell, {} as never), runtime };
}

async function channels(runtime: CoreRuntime): Promise<ChannelState> {
	return ((await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) ?? {
		channels: {},
		messages: {},
		nextSeq: {},
		readMarks: {},
	}) as ChannelState;
}

describe("建群时带上共享指令与接话规则", () => {
	it("落盘、读得回来", async () => {
		const { chat, runtime } = await setup();
		const { id } = await chat.createGroup({
			title: "上线群",
			members: [ME],
			bulletin: "  这个群只讨论上线。  ",
			responder: { kind: "lead", slug: ME },
		});

		const channel = (await channels(runtime)).channels[id];
		expect(channel?.bulletin).toBe("这个群只讨论上线。");
		expect(channel?.responder).toEqual({ kind: "lead", slug: ME });
	});

	it("接话的人是群外的人：建不出来", async () => {
		const { chat, runtime } = await setup();
		await expect(
			chat.createGroup({ title: "上线群", members: [ME], responder: { kind: "lead", slug: OTHER } }),
		).rejects.toMatchObject({ reason: "bad-request" });
		expect(Object.keys((await channels(runtime)).channels).filter((id) => id.startsWith("group:"))).toEqual([]);
	});

	it("共享指令超长：建不出来", async () => {
		const { chat } = await setup();
		await expect(
			chat.createGroup({ title: "上线群", members: [ME], bulletin: "字".repeat(12_001) }),
		).rejects.toMatchObject({ reason: "bad-request" });
	});
});

describe("建完再改", () => {
	it("改与清：传 null 回到默认，缺省不动", async () => {
		const { chat, runtime } = await setup();
		const { id } = await chat.createGroup({ title: "上线群", members: [ME], bulletin: "先写文档" });

		await chat.updateChannel(id, { responder: { kind: "everyone" } });
		let channel = (await channels(runtime)).channels[id];
		expect(channel?.bulletin).toBe("先写文档");
		expect(channel?.responder).toEqual({ kind: "everyone" });

		await chat.updateChannel(id, { bulletin: null, responder: null });
		channel = (await channels(runtime)).channels[id];
		expect(channel?.bulletin).toBeUndefined();
		expect(channel?.responder).toBeUndefined();
	});

	it("lead 不是这个频道的人：拒绝，且库里一个字都不动", async () => {
		const { chat, runtime } = await setup();
		const { id } = await chat.createGroup({ title: "上线群", members: [ME] });

		await expect(
			chat.updateChannel(id, { responder: { kind: "lead", slug: OTHER }, bulletin: "顺手改的" }),
		).rejects.toMatchObject({ reason: "bad-request" });
		expect((await channels(runtime)).channels[id]?.bulletin).toBeUndefined();
	});

	it("私聊没有共享指令：拒绝", async () => {
		const { chat } = await setup();
		const { id } = await chat.openDirectMessage(ME);
		await expect(chat.updateChannel(id, { bulletin: "悄悄话" })).rejects.toMatchObject({
			reason: "bad-request",
		});
	});

	it("频道不存在：404", async () => {
		const { chat } = await setup();
		await expect(chat.updateChannel("group:不存在", { bulletin: "x" })).rejects.toMatchObject({
			reason: "not-found",
		});
	});
});
