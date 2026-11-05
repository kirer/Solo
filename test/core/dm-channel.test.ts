/**
 * 私聊入口：**唯一**的建频道用例（ADR-097）。
 *
 * 通用建频道接口已删 —— 频道要么由装配投影出来（全员 / 团队），要么由这里开一个
 * `dm:` 两人间。这些用例钉住三件事：id 形态是 `dm:`、重复调用幂等、对方必须真的存在。
 */
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import type { CoreRuntime } from "../../src/core/runtime/open.ts";
import { createChat } from "../../src/app/chat.ts";
import { AppError } from "../../src/app/errors.ts";
import { createAgent } from "../../src/core/documents/member/identity.ts";
import { ChannelDoc, chatKind, dmId, type ChannelState } from "../../src/core/channel/types.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

const ME = "林越";

async function setup(): Promise<{ chat: ReturnType<typeof createChat>; runtime: CoreRuntime }> {
	const box = await pool.make("core-dm-");
	await createAgent({ root: box.agentsRoot, name: ME, title: "负责人", manager: "owner" });
	const runtime = await box.open();
	const shell = await box.assemble(runtime);
	// `snapshots` 只在 markRead / 上传的闭包里用到，这里不碰。
	const chat = createChat(shell, {} as never);
	return { chat, runtime };
}

async function channels(runtime: CoreRuntime): Promise<ChannelState> {
	return ((await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) ?? {
		channels: {},
		messages: {},
		nextSeq: {},
		readMarks: {},
	}) as ChannelState;
}

describe("openDirectMessage", () => {
	it("返回 dm: id，成员是「我 + 对方」，形态是私聊", async () => {
		const { chat, runtime } = await setup();
		const result = await chat.openDirectMessage(ME);

		expect(result).toEqual({ ok: true, id: dmId("owner", ME) });
		const channel = (await channels(runtime)).channels[result.id];
		expect(channel?.members).toEqual(["owner", ME]);
		expect(channel?.title).toBe(ME);
		expect(channel?.wakeOnAll).toEqual([]);
		expect(chatKind(channel!)).toBe("dm");
	});

	it("幂等：再开一次返回同一个 id，不重建、不覆盖标题", async () => {
		const { chat, runtime } = await setup();
		const first = await chat.openDirectMessage(ME);
		const createdAt = (await channels(runtime)).channels[first.id]?.createdAt;

		const again = await chat.openDirectMessage(ME);
		expect(again.id).toBe(first.id);
		expect((await channels(runtime)).channels[first.id]?.createdAt).toBe(createdAt);
	});

	it("拒绝我自己、不存在的 slug、空 slug，且不留下任何频道", async () => {
		const { chat, runtime } = await setup();
		const before = Object.keys((await channels(runtime)).channels).length;

		await expect(chat.openDirectMessage("owner")).rejects.toMatchObject({ reason: "bad-request" });
		await expect(chat.openDirectMessage("查无此人")).rejects.toMatchObject({ reason: "not-found" });
		await expect(chat.openDirectMessage("   ")).rejects.toMatchObject({ reason: "bad-request" });
		await expect(chat.openDirectMessage("..")).rejects.toMatchObject({ reason: "not-found" });

		const state = await channels(runtime);
		expect(Object.keys(state.channels).length).toBe(before);
		expect(state.channels[dmId("owner", "查无此人")]).toBeUndefined();
	});

	it("错误是人话（AppError），不是照抄底层异常", async () => {
		const { chat } = await setup();
		await expect(chat.openDirectMessage("查无此人")).rejects.toBeInstanceOf(AppError);
	});
});
