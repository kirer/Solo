import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT, createRegistry, openCore, setupModels } from "../../src/core/runtime/index.ts";
import { sectionKeyOf } from "../../src/core/agent/runtime.ts";
import { assembleCore, seedOwnerAssistant } from "../../src/core/shell/assemble.ts";

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
			expect(state.messages.company?.map((message) => message.text)).toEqual([`@${slug} 在吗`]);
		} finally {
			await opened.close();
		}
	});
});
