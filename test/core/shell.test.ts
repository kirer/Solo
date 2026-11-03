import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ChannelDoc, type ChannelState } from "../../src/core/channel/types.ts";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { sectionKeyOf } from "../../src/core/agent/sections.ts";
import { parseDoc } from "../../src/core/md/doc.ts";
import { seedOwnerAssistant, seedPersonalSkills, syncAllSkills } from "../../src/shell/seed.ts";
import { listSkills, readSkill, writeAllSkill } from "../../src/core/agent/skills.ts";
import { sandboxPool, type Sandbox } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

async function workspace(): Promise<Sandbox> {
	const box = await pool.make("core-shell-");
	// 提示词模板也要播种：生产里 `main.ts` 启动时先跑 `seedPromptTemplates` 再装配。
	// 不播种的话 `agentSections` 读到空目录 → 一个身份段都没有，测试就在验一个不存在的状态。
	await box.seedTemplates();
	return box;
}

/**
 * 这一组是**回归测试**：每一个都对应一次实测踩坑。
 * 它们不依赖网络、不依赖模型 —— 只验证「装配出来的东西是对的」。
 */
describe("装配", () => {
	test("每个人都有自己的身份段落，且 key 是 ASCII", async () => {
		const box = await workspace();
		const layout = box.layout;
		const opened = await box.open();
		try {
			const slug = await seedOwnerAssistant(layout, { name: "林越" });
			const shell = await box.assemble(opened);
			const conversation = shell.conversations.get(slug);
			expect(conversation).toBeDefined();
			if (conversation === undefined) return;
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			// 坑 1：扩展按名字解析，忘了 install 身份扩展 → 会话里一个 section 都没有。
			// 分段后每人 10 段（一段一个 md）：底座按段做最小 patch，缓存才留得住。
			expect(agent.sections.map((section) => section.key)).toEqual(
				["who", "body", "rules", "position", "team", "tools", "memory", "skills", "directory", "work"].map(
					(segment) => `${sectionKeyOf(slug)}-${segment}`,
				),
			);
			// 坑 2：section key 必须匹配 /^[a-z][a-z0-9_-]*$/，中文 slug 必须转义。
			expect(sectionKeyOf("林越")).toMatch(/^[a-z][a-z0-9_-]*$/);
			// 坑 3：会话没选 core-tools → 一个工具都没有。
			expect(agent.tools.length).toBeGreaterThan(0);
		} finally {
			await opened.close();
		}
	});

	test("身份段落读到的是盘上的最新内容", async () => {
		const box = await workspace();
		const layout = box.layout;
		const opened = await box.open();
		try {
			const slug = await seedOwnerAssistant(layout, { name: "林越" });
			const shell = await box.assemble(opened);
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
				join(layout.assistantRoot, slug, "identity.md"),
				"---\nname: 林越\ntitle: 负责人\n---\n\n你现在只关心一件事：钱。\n",
				"utf8",
			);

			const after = await conversation.agent(BACKGROUND_CONTEXT);
			// 正文现在单独一段（`05-body.md`）：渲染整组，才能看到盘上那几句。
			const renderedAfter = (
				await Promise.all(
					after.sections.map((section) =>
						section.render({ conversationId: conversation.id, agent: after, shown: {}, read: opened.harness }, BACKGROUND_CONTEXT),
					),
				)
			).join("\n");
			expect(renderedAfter).toContain("你现在只关心一件事：钱。");
			expect(renderedAfter).not.toContain("我唯一直接对话的人");
		} finally {
			await opened.close();
		}
	});

	test("我说话会真的投递到收件人的会话里", async () => {
		const box = await workspace();
		const layout = box.layout;
		const opened = await box.open();
		try {
			const slug = await seedOwnerAssistant(layout, { name: "林越" });
			const shell = await box.assemble(opened);
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
			// 频道里只有我说的那一句：ADR-081 之后不再为被叫醒的人写任何占位。
			const texts = state.messages.all?.map((message) => message.text) ?? [];
			expect(texts).toContain(`@${slug} 在吗`);
			expect(state.messages.all).toHaveLength(1);
		} finally {
			await opened.close();
		}
	});
});

describe("助理身份：组织是文件，不是代码里的字符串", () => {
	test("播种出来的 identity.md 正文就是 seed 文件里的正文", async () => {
		const layout = (await workspace()).layout;
		const slug = await seedOwnerAssistant(layout, { name: "示例" });

		const created = parseDoc("identity.md", await readFile(join(layout.assistantRoot, slug, "identity.md"), "utf8"));
		const seed = parseDoc("identity.md", await readFile(new URL("../../seed/assistant/identity.md", import.meta.url), "utf8"));

		// 逐字节相同才说明它是「读文件」，不是代码里又抄了一份。
		expect(created.body).toBe(seed.body);
		expect(created.body.length).toBeGreaterThan(80);
		// 名字可以从参数覆盖，但默认取自文件。
		expect(created.front["name"]).toBe("示例");
		// 组织是平的：助理身份里没有上级（ADR-058）。
		expect(created.front["manager"]).toBeUndefined();
	});

	test("改 seed 文件就换一个人的说法：代码里没有第二份正文", async () => {
		const layout = (await workspace()).layout;
		const slug = await seedOwnerAssistant(layout);
		const created = parseDoc("identity.md", await readFile(join(layout.assistantRoot, slug, "identity.md"), "utf8"));
		// 代码里那份旧字面量（V2 的 `me(action=update)` / `read_history(scope=memory)`）不许再出现。
		expect(created.body).not.toContain("me(action=update)");
		expect(created.body).not.toContain("read_history(scope=memory)");
	});
});

describe("播种技能", () => {
	test("全员层技能来自文件，不是代码里的字符串", async () => {
		const layout = (await workspace()).layout;
		const report = await syncAllSkills(layout);
		// `写技能` / `找现成技能` 是所有人都该会的手艺，落在全员层。
		expect(report.copied).toEqual(expect.arrayContaining(["写技能", "找现成技能"]));
		const roots = { workspace: layout.userRoot, agents: layout.agentRoots, teams: layout.teamsRoot };
		const skills = await listSkills(roots, "owner");
		expect(skills.map((skill) => skill.name)).toEqual(expect.arrayContaining(["写技能", "找现成技能"]));
		const body = await readSkill(roots, "owner", "写技能");
		expect(body?.body).toContain("## 什么时候该写");
	});

	test("建立团队与招人是助理的个人技能，不进全员层", async () => {
		const box = await workspace();
		const layout = box.layout;
		// 助理的个人技能种子跟着助理目录走（`seed/assistant/skills/`）。
		const assistantDir = join(layout.assistantRoot, "助理");
		await mkdir(assistantDir, { recursive: true });
		await writeFile(join(assistantDir, "identity.md"), "---\nname: 助理\n---\n\n统筹。\n", "utf8");
		const copied = await seedPersonalSkills(assistantDir, "assistant/skills");
		expect(copied).toEqual(expect.arrayContaining(["建立团队", "招人"]));

		// 全员层不该有它们：招人、建团队是助理的职权，别人本来就不该招人。
		const synced = await syncAllSkills(layout);
		const syncedNames = [...synced.copied, ...synced.updated];
		expect(syncedNames).not.toContain("建立团队");
		expect(syncedNames).not.toContain("招人");

		const body = await readSkill({ workspace: layout.userRoot, agents: layout.agentRoots, teams: layout.teamsRoot }, "助理", "建立团队");
		expect(body?.body).toContain("## 什么时候建");
		expect(body?.scope).toBe("personal");
	});

	test("第二次播种不覆盖用户改过的内容", async () => {
		const layout = (await workspace()).layout;
		await syncAllSkills(layout);
		// 用户改了自己的技能。
		await writeAllSkill(layout.userRoot, { name: "写技能", description: "改过", body: "# 我自己的版本" });
		await syncAllSkills(layout);
		const body = await readSkill({ workspace: layout.userRoot, agents: layout.agentRoots, teams: layout.teamsRoot }, "owner", "写技能");
		expect(body?.body).toContain("我自己的版本");
	});
});
