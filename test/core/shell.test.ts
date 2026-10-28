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
			expect(renderedAfter).not.toContain("老板唯一直接对话的人");
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
			const { delivery } = await shell.ownerSay({ channelId: "company", text: `@${slug} 在吗` });
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
			// T-016：@A 会创建一条 pending 占位（text=""），真实消息在前、占位在后。
			const texts = state.messages.company?.map((message) => message.text) ?? [];
			expect(texts).toContain(`@${slug} 在吗`);
			const pending = (state.messages.company ?? []).find((m) => m.status === "pending" && m.pendingFor === slug);
			expect(pending).toBeDefined();
			expect(pending?.text).toBe("");
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
			const hit = await shell.ownerSay({ channelId: "company", text: `@${slug} 在吗` });
			expect(hit.delivery.delivered).toEqual([slug]);
			let state = await shell.channels();
			const pending = (state.messages.company ?? []).find((m) => m.status === "pending" && m.pendingFor === slug);
			expect(pending).toBeDefined();
			expect(pending?.from).toBe(slug);
			expect(pending?.text).toBe("");
			const miss = await shell.ownerSay({ channelId: "company", text: "@nobody 你好" });
			expect(miss.delivery.delivered).toEqual([]);
			state = await shell.channels();
			const pendingAfter = (state.messages.company ?? []).filter((m) => m.status === "pending" && m.pendingFor === "nobody");
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
			await shell.ownerSay({ channelId: "company", text: `@${slug} 在吗` });
			let state = await shell.channels();
			const pendingSeq = (state.messages.company ?? []).find((m) => m.status === "pending" && m.pendingFor === slug)?.seq;
			expect(pendingSeq).toBeDefined();
			const before = (await shell.channels()).messages.company ?? [];
			// 模拟 A 醒来回频道：用 harness.snapshot(ChannelDoc) 作为 state（与 channel-write.test 一致），
			// 直接 postMessage 触发占位吸收（不在 commit 内、不复用已 settled 的 shell.channels 投影快照）。
			const { postMessage } = await import("../../src/core/channel/post.ts");
			const rawState = (await opened.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as never;
			await postMessage(
				{ harness: opened.harness, state: rawState, conversationOf: async () => undefined },
				{ channelId: "company", from: slug, text: "我在的，怎么了", at: Date.now(), wake: false },
				BACKGROUND_CONTEXT,
			);
			state = await shell.channels();
			const after = state.messages.company ?? [];
			expect(after.length).toBe(before.length);
			const filled = after.find((m) => m.seq === pendingSeq);
			expect(filled?.status).toBe("done");
			expect(filled?.text).toBe("我在的，怎么了");
			expect(filled?.from).toBe(slug);
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
			await shell.ownerSay({ channelId: "company", text: `@${slug} 在吗` });
			const state = await shell.channels();
			const ownerDm = Object.values(state.channels).find((c) => c.id.startsWith("dm:owner-"));
			if (ownerDm !== undefined) {
				expect(state.messages[ownerDm.id] ?? []).toHaveLength(0);
			}
			expect((state.messages.company ?? []).some((m) => m.status === "pending")).toBe(true);
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
