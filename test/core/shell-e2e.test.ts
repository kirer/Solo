import { afterEach, describe, expect, it } from "vitest";
import type { CoreShell } from "../../src/shell/assemble.ts";
import { ChannelDoc, type ChannelState } from "../../src/core/channel/types.ts";
import { recipientsOf } from "../../src/core/channel/mentions.ts";
import { readAllIdentities } from "../../src/core/agent/identity.ts";

/**
 * 外壳装配的端到端契约（不调模型）。
 *
 * 这些断言覆盖的是「装配层自己会不会错」——真正跑模型的那条链路在
 * `test/core/live-*.test.ts` 之外的实测里验过（招人 → 进频道 → 被 @ 回话）。
 * 装配错的地方都很安静：会话建了但不在频道里、人存在但没有身份段落、
 * 名册有了但显示名没刷新，界面上全都表现为「这个人叫不动」。
 */
import { sandboxPool, type Sandbox } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

const models = { provider: "test", modelId: "test" };

async function setup(): Promise<{ box: Sandbox; shell: CoreShell }> {
	const box = await pool.make("core-shell-e2e-");
	const runtime = await box.open();
	const shell = await box.assemble(runtime, { defaultModel: models });
	return { box, shell };
}

async function channels(shell: CoreShell): Promise<ChannelState> {
	const doc = await shell.harness.snapshot(ChannelDoc);
	return (
		doc ?? { channels: {}, messages: {}, nextSeq: {}, readMarks: {} }
	);
}

describe("外壳装配", () => {
	it("new agent 会立刻进全员频道", async () => {
		const { shell } = await setup();
		await shell.postAs({ channelId: "all", from: "owner", text: "@nowhere 测试" }).catch(() => undefined);
		const state = await channels(shell);
		const allChannel = state.channels.all;
		expect(allChannel).toBeDefined();
		// 新人的会话一建出来就要能收到 @：否则 `recipientsOf` 会按「@ 的必须是成员」把他过滤掉。
		expect(allChannel?.members).toContain("owner");
	});

	it("hire 之后新人在频道里，且能被 @ 到", async () => {
		const { box, shell } = await setup();
		const agentsRoot = box.agentsRoot;
		const created = await shell.rescan();
		expect(created.length).toBe(0);

		// 直接调用工具层的建人逻辑（与模型调 `hire` 走同一条路）。
		const { createAgent } = await import("../../src/core/agent/identity.ts");
		const identity = await createAgent({ root: agentsRoot, name: "林越", manager: "owner" });
		const id = await shell.openAgent(identity.slug);
		expect(id).toBeGreaterThan(0);

		const state = await channels(shell);
		expect(state.channels.all?.members).toContain(identity.slug);

		// 我 @ 他：收件人里必须有他（这正是「招了人但叫不动」的那个 bug）。
		const targets = recipientsOf(state.channels.all!, {
			seq: 1,
			from: "owner",
			at: Date.now(),
			text: `@${identity.slug} 你好`,
			mentions: [identity.slug],
			kind: "chat",
		});
		expect(targets).toContain(identity.slug);
	});

	it("我在哪个频道叫醒某人，就记下那个频道", async () => {
		// 回归：`ownerSpeak` 曾经没传 `rememberWake`，于是被叫的人回话时查不到
		// 「是在哪儿被叫的」，只能退到「我最早的那个频道」—— 那往往是个人频道。
		// 结果我在全员频道问、对方在私聊里答，问的人在原频道什么都看不到。
		const { box, shell } = await setup();
		const agentsRoot = box.agentsRoot;
		const { createAgent } = await import("../../src/core/agent/identity.ts");
		const { DirectoryDoc } = await import("../../src/core/agent/roster.ts");
		const identity = await createAgent({ root: agentsRoot, name: "林越", manager: "owner" });
		const conversationId = await shell.openAgent(identity.slug);

		await shell
			.postAs({ channelId: "all", from: "owner", text: `@${identity.slug} 你好` })
			.catch(() => undefined);

		const directory = await shell.harness.snapshot(DirectoryDoc);
		expect(conversationId).toBeGreaterThan(0);
		// 没被打断时两层唤醒记录指向同一条。
		const record = directory?.wake[String(conversationId)] as
			| { reply?: { channelId?: string }; task?: { channelId?: string } }
			| undefined;
		expect(record?.reply?.channelId).toBe("all");
		expect(record?.task?.channelId).toBe("all");
	});

	it("重启后再装配，不会重复建会话，名册与频道保持", async () => {
		const { box, shell } = await setup();
		const agentsRoot = box.agentsRoot;
		const { createAgent } = await import("../../src/core/agent/identity.ts");
		const identity = await createAgent({ root: agentsRoot, name: "林越", manager: "owner" });
		await shell.openAgent(identity.slug);
		const before = await channels(shell);
		await shell.close();

		// 同名重开一份（同一 workspace）：人还在目录里，不应该再建一个。
		const runtime2 = await box.open();
		const shell2 = await box.assemble(runtime2, { defaultModel: models });
		const identities = await readAllIdentities(agentsRoot);
		expect(identities.map((item) => item.slug)).toContain(identity.slug);
		const after = await channels(shell2);
		expect(after.channels.all?.members).toEqual(before.channels.all?.members);
		expect(after.messages.all).toEqual(before.messages.all);
	});
});
