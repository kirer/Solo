import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ChannelDoc, type ChannelState } from "../../src/core/channel/state.ts";
import { BACKGROUND_CONTEXT, createRegistry, openCore, setupModels } from "../../src/core/runtime/index.ts";
import { sectionKeyOf } from "../../src/core/agent/runtime.ts";
import { assembleCore } from "../../src/core/shell/assemble.ts";
import { seedCompanySkills, seedOwnerAssistant, seedPersonalSkills } from "../../src/core/shell/seed.ts";
import { listCompanySkills, readSkill, writeCompanySkill } from "../../src/core/agent/skills.ts";

const dirs: string[] = [];

async function workspace(): Promise<{ readonly root: string; readonly agents: string; readonly projects: string }> {
	const root = await mkdtemp(join(tmpdir(), "core-shell-"));
	dirs.push(root);
	const agents = join(root, "agents");
	const projects = join(root, "projects");
	await mkdir(projects, { recursive: true });
	return { root, agents, projects };
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * 这一组是**回归测试**：每一个都对应一次实测踩坑。
 * 它们不依赖网络、不依赖模型 —— 只验证「装配出来的东西是对的」。
 */
describe("装配", () => {
	test("每个人都有自己的身份段落，且 key 是 ASCII", async () => {
		const { root, agents, projects } = await workspace();
		const { models } = setupModels(process.env, { workspace: root });
		const opened = await openCore({ databasePath: join(root, "c.sqlite"), models, registry: createRegistry() });
		try {
			const slug = await seedOwnerAssistant(agents, { name: "林越" });
			const shell = await assembleCore(opened.harness, opened.registry, { agentsRoot: agents, projectsRoot: projects });
			const conversation = shell.conversations.get(slug);
			expect(conversation).toBeDefined();
			if (conversation === undefined) return;
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			// 坑 1：扩展按名字解析，忘了 install 身份扩展 → 会话里一个 section 都没有。
			expect(agent.sections.map((section) => section.key)).toEqual([sectionKeyOf(slug)]);
			// 坑 2：section key 必须匹配 /^[a-z][a-z0-9_-]*$/，中文 slug 必须转义。
			expect(sectionKeyOf("林越")).toMatch(/^[a-z][a-z0-9_-]*$/);
			// 坑 3：会话没选 core-tools → 一个工具都没有。
			expect(agent.tools.length).toBeGreaterThan(0);
		} finally {
			await opened.close();
		}
	});

	test("身份段落读到的是盘上的最新内容", async () => {
		const { root, agents, projects } = await workspace();
		const { models } = setupModels(process.env, { workspace: root });
		const opened = await openCore({ databasePath: join(root, "c.sqlite"), models, registry: createRegistry() });
		try {
			const slug = await seedOwnerAssistant(agents, { name: "林越" });
			const shell = await assembleCore(opened.harness, opened.registry, { agentsRoot: agents, projectsRoot: projects });
			const conversation = shell.conversations.get(slug);
			if (conversation === undefined) throw new Error("没有会话");
			const before = await conversation.agent(BACKGROUND_CONTEXT);
			const renderedBefore = await before.sections[0]?.render(
				{ conversationId: conversation.id, agent: before, shown: {}, read: opened.harness },
				BACKGROUND_CONTEXT,
			);
			expect(renderedBefore).toContain("林越");

			// 热更新：只改盘上的文件，不重开会话、不重启。
			await writeFile(
				join(agents, slug, "identity.md"),
				"---\nname: 林越\ntitle: 负责人\n---\n\n你现在只关心一件事：钱。\n",
				"utf8",
			);

			const after = await conversation.agent(BACKGROUND_CONTEXT);
			const renderedAfter = await after.sections[0]?.render(
				{ conversationId: conversation.id, agent: after, shown: {}, read: opened.harness },
				BACKGROUND_CONTEXT,
			);
			expect(renderedAfter).toContain("你现在只关心一件事：钱。");
			expect(renderedAfter).not.toContain("老大唯一直接对话的人");
		} finally {
			await opened.close();
		}
	});

	test("老板说话会真的投递到收件人的会话里", async () => {
		const { root, agents, projects } = await workspace();
		const { models } = setupModels(process.env, { workspace: root });
		const opened = await openCore({ databasePath: join(root, "c.sqlite"), models, registry: createRegistry() });
		try {
			const slug = await seedOwnerAssistant(agents, { name: "林越" });
			const shell = await assembleCore(opened.harness, opened.registry, { agentsRoot: agents, projectsRoot: projects });
			const { delivery } = await shell.ownerSay({ channelId: "all", text: `@${slug} 在吗` });
			expect(delivery.failed).toEqual([]);
			expect(delivery.delivered).toEqual([slug]);

			const conversation = shell.conversations.get(slug);
			if (conversation === undefined) throw new Error("没有会话");
			const context = await conversation.context(BACKGROUND_CONTEXT);
			// 坑 4：消息用 list.push() 写进文档 → 不产生 op → 提交后静默消失。
			const entry = context.entries.find((item) => item.kind === "core.channel");
			expect(entry).toBeDefined();
			expect(JSON.stringify(entry?.data)).toContain("在吗");

			const state = await shell.channels();
			// B（处理中指示）：@A 会在同频道为其创建一条 processing 占位（text="开始处理…"），真实消息在前、占位在后。
			const texts = state.messages.all?.map((message) => message.text) ?? [];
			expect(texts).toContain(`@${slug} 在吗`);
			const pending = (state.messages.all ?? []).find((m) => m.processing === true && m.pendingFor === slug);
			expect(pending).toBeDefined();
			expect(pending?.text).toContain("开始处理");
			expect(pending?.processing).toBe(true);
		} finally {
			await opened.close();
		}
	});
});

describe("T-016 流式占位气泡（v1 基线：占位 + 轮结束一次性 done）", () => {
	test("@A 且 A 被唤醒 → 创建 pending 占位；A 未唤醒 → 不创建", async () => {
		const { root, agents, projects } = await workspace();
		const { models } = setupModels(process.env, { workspace: root });
		const opened = await openCore({ databasePath: join(root, "c.sqlite"), models, registry: createRegistry() });
		try {
			const slug = await seedOwnerAssistant(agents, { name: "林越" });
			const shell = await assembleCore(opened.harness, opened.registry, { agentsRoot: agents, projectsRoot: projects });
			const hit = await shell.ownerSay({ channelId: "all", text: `@${slug} 在吗` });
			expect(hit.delivery.delivered).toEqual([slug]);
			let state = await shell.channels();
			const pending = (state.messages.all ?? []).find((m) => m.processing === true && m.pendingFor === slug);
			expect(pending).toBeDefined();
			expect(pending?.from).toBe(slug);
			expect(pending?.text).toContain("开始处理");
			expect(pending?.processing).toBe(true);
			const miss = await shell.ownerSay({ channelId: "all", text: "@nobody 你好" });
			expect(miss.delivery.delivered).toEqual([]);
			state = await shell.channels();
			const pendingAfter = (state.messages.all ?? []).filter((m) => m.status === "pending" && m.pendingFor === "nobody");
			expect(pendingAfter).toHaveLength(0);
		} finally {
			await opened.close();
		}
	});

	test("A 真实回复原地填充占位（占位即最终消息，不重复气泡）", async () => {
		const { root, agents, projects } = await workspace();
		const { models } = setupModels(process.env, { workspace: root });
		const opened = await openCore({ databasePath: join(root, "c.sqlite"), models, registry: createRegistry() });
		try {
			const slug = await seedOwnerAssistant(agents, { name: "林越" });
			const shell = await assembleCore(opened.harness, opened.registry, { agentsRoot: agents, projectsRoot: projects });
			await shell.ownerSay({ channelId: "all", text: `@${slug} 在吗` });
			let state = await shell.channels();
			const pendingSeq = (state.messages.all ?? []).find((m) => m.processing === true && m.pendingFor === slug)?.seq;
			expect(pendingSeq).toBeDefined();
			const before = (await shell.channels()).messages.all ?? [];
			// 模拟 A 醒来回频道：用 harness.snapshot(ChannelDoc) 作为 state（与 channel-write.test 一致），
			// 直接 postMessage 触发占位吸收（不在 commit 内、不复用已 settled 的 shell.channels 投影快照）。
			const { postMessage } = await import("../../src/core/channel/post.ts");
			const rawState = (await opened.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as never;
			await postMessage(
				{ harness: opened.harness, state: rawState, conversationOf: async () => undefined },
				{ channelId: "all", from: slug, text: "我在的，怎么了", at: Date.now(), wake: false },
				BACKGROUND_CONTEXT,
			);
			state = await shell.channels();
			const after = state.messages.all ?? [];
			expect(after.length).toBe(before.length);
			const filled = after.find((m) => m.seq === pendingSeq);
			expect(filled?.status).toBe("done");
			expect(filled?.text).toBe("我在的，怎么了");
			expect(filled?.from).toBe(slug);
		} finally {
			await opened.close();
		}
	});

	test("占位被填充时，钩子只拿到一次完整全文（serve 不再切片推 token，审计 P1-3）", async () => {
		const { root, agents, projects } = await workspace();
		const { models } = setupModels(process.env, { workspace: root });
		const opened = await openCore({ databasePath: join(root, "c.sqlite"), models, registry: createRegistry() });
		try {
			const slug = await seedOwnerAssistant(agents, { name: "林越" });
			const shell = await assembleCore(opened.harness, opened.registry, { agentsRoot: agents, projectsRoot: projects });
			await shell.ownerSay({ channelId: "all", text: `@${slug} 在吗` });
			let state = await shell.channels();
			const pendingSeq = (state.messages.all ?? []).find((m) => m.processing === true && m.pendingFor === slug)?.seq;
			expect(pendingSeq).toBeDefined();
			const { postMessage } = await import("../../src/core/channel/post.ts");
			const { setChannelStreamHook, setChannelClientsHas } = await import("../../src/core/channel/post.ts");
			// 钩子的契约：一次调用、给的是完整全文（serveCore 只据此推一条 done）。
			const calls: { channelId: string; seq: number; fullText: string }[] = [];
			setChannelClientsHas(() => true);
			setChannelStreamHook((channelId, seq, fullText) => {
				calls.push({ channelId, seq, fullText });
			});
			await postMessage(
				{ harness: opened.harness, state: (await opened.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as never, conversationOf: async () => undefined },
				{ channelId: "all", from: slug, text: "我在的，怎么了", at: Date.now(), wake: false },
				BACKGROUND_CONTEXT,
			);
			setChannelStreamHook(undefined);
			setChannelClientsHas(() => false);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.channelId).toBe("all");
			expect(calls[0]?.seq).toBe(pendingSeq);
			expect(calls[0]?.fullText).toBe("我在的，怎么了");
			state = await shell.channels();
			const filled = (state.messages.all ?? []).find((m) => m.seq === pendingSeq);
			expect(filled?.status).toBe("done");
		} finally {
			await opened.close();
		}
	});

	test("回归：013/014 口径 A 不倒退 —— 群@A 不影响老板个人频道", async () => {
		const { root, agents, projects } = await workspace();
		const { models } = setupModels(process.env, { workspace: root });
		const opened = await openCore({ databasePath: join(root, "c.sqlite"), models, registry: createRegistry() });
		try {
			const slug = await seedOwnerAssistant(agents, { name: "林越" });
			const shell = await assembleCore(opened.harness, opened.registry, { agentsRoot: agents, projectsRoot: projects });
			await shell.ownerSay({ channelId: "all", text: `@${slug} 在吗` });
			const state = await shell.channels();
			const ownerDm = Object.values(state.channels).find((c) => c.id.startsWith("dm:owner-"));
			if (ownerDm !== undefined) {
				expect(state.messages[ownerDm.id] ?? []).toHaveLength(0);
			}
			expect((state.messages.all ?? []).some((m) => m.status === "pending")).toBe(true);
		} finally {
			await opened.close();
		}
	});
	test("B 私聊助理：老板私聊知言视图层透传 processing（老板能看到动画，#86）", async () => {
		const { root, agents, projects } = await workspace();
		const { models } = setupModels(process.env, { workspace: root });
		const opened = await openCore({ databasePath: join(root, "c.sqlite"), models, registry: createRegistry() });
		try {
			const slug = await seedOwnerAssistant(agents, { name: "林越" });
			const shell = await assembleCore(opened.harness, opened.registry, { agentsRoot: agents, projectsRoot: projects });
			const dmId = `dm:owner-${slug}`;
			await shell.ownerSay({ channelId: dmId, text: "在吗，帮我看下这个" });
			const state = (await opened.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
			const channel = state.channels[dmId];
			const placeholder = (state.messages[dmId] ?? []).find((m) => m.processing === true);
			expect(placeholder).toBeDefined();
			// 视图层（SSE / GET 历史都走 messageView）必须透传 processing 字段，前端才渲染动画。
			const { messageView } = await import("../../src/core/shell/view.ts");
			const view = messageView(state, channel, placeholder, shell.directory, "owner");
			expect(view.processing).toBe(true);
			expect(view.pendingFor).toBe(slug);
		} finally {
			await opened.close();
		}
	});
	test("B 闭环硬约束：A@B 后 B 回 A@A，A 不再二次进 processing（#54/#55 本质口径）", async () => {
		const { root, agents, projects } = await workspace();
		const { models } = setupModels(process.env, { workspace: root });
		const opened = await openCore({ databasePath: join(root, "c.sqlite"), models, registry: createRegistry() });
		try {
			const slug = await seedOwnerAssistant(agents, { name: "林越" });
			const shell = await assembleCore(opened.harness, opened.registry, { agentsRoot: agents, projectsRoot: projects });
			// A（老板）@ B（助理），应创建 B 的 processing 占位。
			await shell.ownerSay({ channelId: "all", text: "@" + slug + " 你处理一下这个" });
			let state = await shell.channels();
			const procAfterA = (state.messages.all ?? []).filter((m) => m.processing === true);
			expect(procAfterA).toHaveLength(1);
			expect(procAfterA[0]?.pendingFor).toBe(slug);
			// B 闭环回复、@ 回 A（老板）：应原地填充 B 自己的占位，且**不**为 A 创建新 processing。
			const { postMessage } = await import("../../src/core/channel/post.ts");
			await postMessage(
				{ harness: opened.harness, state: (await opened.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as never, conversationOf: async () => undefined },
				{ channelId: "all", from: slug, text: "收到，@owner 已处理完成", at: Date.now(), wake: false },
				BACKGROUND_CONTEXT,
			);
			state = await shell.channels();
			const procAfterB = (state.messages.all ?? []).filter((m) => m.processing === true);
			// 占位被 B 的回复原地覆盖消失：没有任何 processing 残留（尤其 owner 不应二次出现）。
			expect(procAfterB).toHaveLength(0);
			expect(procAfterB.find((m) => m.pendingFor === "owner")).toBeUndefined();
		} finally {
			await opened.close();
		}
	});
});

describe("播种技能", () => {
	test("公司层技能来自文件，不是代码里的字符串", async () => {
		const { agents } = await workspace();
		const copied = await seedCompanySkills(agents);
		// `写技能` / `找现成技能` 是所有人都该会的手艺，落在公司层。
		expect(copied).toEqual(expect.arrayContaining(["写技能", "找现成技能"]));
		const skills = await listCompanySkills(join(agents, ".."));
		expect(skills.map((skill) => skill.name)).toEqual(expect.arrayContaining(["写技能", "找现成技能"]));
		const body = await readSkill({ workspace: join(agents, ".."), agents }, "owner", "写技能");
		expect(body?.body).toContain("## 什么时候该写");
	});

	test("立项与招人是助理的个人技能，不进公司层", async () => {
		const { agents } = await workspace();
		const copied = await seedPersonalSkills(agents, "助理", "assistant");
		expect(copied).toEqual(expect.arrayContaining(["立项", "招人"]));

		// 公司层不该有它们：招人、立项是助理的职权，别人本来就不该招人。
		const company = await seedCompanySkills(agents);
		expect(company).not.toContain("立项");
		expect(company).not.toContain("招人");

		const body = await readSkill({ workspace: join(agents, ".."), agents }, "助理", "立项");
		expect(body?.body).toContain("## 什么时候立");
		expect(body?.scope).toBe("personal");
	});

	test("第二次播种不覆盖用户改过的内容", async () => {
		const { agents } = await workspace();
		await seedCompanySkills(agents);
		// 用户改了自己的技能。
		await writeCompanySkill(join(agents, ".."), { name: "写技能", description: "改过", body: "# 我自己的版本" });
		await seedCompanySkills(agents);
		const body = await readSkill({ workspace: join(agents, ".."), agents }, "owner", "写技能");
		expect(body?.body).toContain("我自己的版本");
	});
});
