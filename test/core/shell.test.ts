import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ChannelDoc, type ChannelState } from "../../src/core/channel/state.ts";
import { BACKGROUND_CONTEXT, createRegistry, openCore, setupModels } from "../../src/core/runtime/index.ts";
import { sectionKeyOf } from "../../src/core/agent/runtime.ts";
import { parseDoc } from "../../src/core/doc.ts";
import { assembleCore } from "../../src/core/shell/assemble.ts";
import { seedOwnerAssistant, seedPersonalSkills, seedPromptTemplates, syncCompanySkills } from "../../src/core/shell/seed.ts";
import { listSkills, readSkill, writeCompanySkill } from "../../src/core/agent/skills.ts";

const dirs: string[] = [];

async function workspace(): Promise<{ readonly root: string; readonly agents: string; readonly teams: string }> {
	const root = await mkdtemp(join(tmpdir(), "core-shell-"));
	dirs.push(root);
	const agents = join(root, "agents");
	const teams = join(root, "teams");
	await mkdir(teams, { recursive: true });
	// 提示词模板也要播种：生产里 `main.ts` 启动时先跑 `seedPromptTemplates` 再装配。
	// 不播种的话 `agentSections` 读到空目录 → 一个身份段都没有，测试就在验一个不存在的状态。
	await seedPromptTemplates(root);
	return { root, agents, teams };
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
		const { root, agents, teams } = await workspace();
		const { models } = setupModels(process.env, { workspace: root });
		const opened = await openCore({ databasePath: join(root, "c.sqlite"), models, registry: createRegistry() });
		try {
			const slug = await seedOwnerAssistant(agents, { name: "林越" });
			const shell = await assembleCore(opened.harness, opened.registry, { agentsRoot: agents, teamsRoot: teams });
			const conversation = shell.conversations.get(slug);
			expect(conversation).toBeDefined();
			if (conversation === undefined) return;
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			// 坑 1：扩展按名字解析，忘了 install 身份扩展 → 会话里一个 section 都没有。
			// 分段后每人 8 段（PROMPT_SEGMENTS）：底座按段做最小 patch，缓存才留得住。
			expect(agent.sections.map((section) => section.key)).toEqual(
				["who", "rules", "position", "team", "tools", "memory", "skills", "directory"].map(
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
		const { root, agents, teams } = await workspace();
		const { models } = setupModels(process.env, { workspace: root });
		const opened = await openCore({ databasePath: join(root, "c.sqlite"), models, registry: createRegistry() });
		try {
			const slug = await seedOwnerAssistant(agents, { name: "林越" });
			const shell = await assembleCore(opened.harness, opened.registry, { agentsRoot: agents, teamsRoot: teams });
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
			expect(renderedAfter).not.toContain("我唯一直接对话的人");
		} finally {
			await opened.close();
		}
	});

	test("我说话会真的投递到收件人的会话里", async () => {
		const { root, agents, teams } = await workspace();
		const { models } = setupModels(process.env, { workspace: root });
		const opened = await openCore({ databasePath: join(root, "c.sqlite"), models, registry: createRegistry() });
		try {
			const slug = await seedOwnerAssistant(agents, { name: "林越" });
			const shell = await assembleCore(opened.harness, opened.registry, { agentsRoot: agents, teamsRoot: teams });
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
		const { agents } = await workspace();
		const slug = await seedOwnerAssistant(agents, { name: "示例" });

		const created = parseDoc("identity.md", await readFile(join(agents, slug, "identity.md"), "utf8"));
		const seed = parseDoc("identity.md", await readFile(new URL("../../seed/agents/assistant/identity.md", import.meta.url), "utf8"));

		// 逐字节相同才说明它是「读文件」，不是代码里又抄了一份。
		expect(created.body).toBe(seed.body);
		expect(created.body.length).toBeGreaterThan(80);
		// 名字可以从参数覆盖，但默认取自文件。
		expect(created.front["name"]).toBe("示例");
		expect(created.front["manager"]).toBe("owner");
	});

	test("改 seed 文件就换一个人的说法：代码里没有第二份正文", async () => {
		const { agents } = await workspace();
		const slug = await seedOwnerAssistant(agents);
		const created = parseDoc("identity.md", await readFile(join(agents, slug, "identity.md"), "utf8"));
		// 代码里那份旧字面量（V2 的 `me(action=update)` / `read_history(scope=memory)`）不许再出现。
		expect(created.body).not.toContain("me(action=update)");
		expect(created.body).not.toContain("read_history(scope=memory)");
	});
});

describe("播种技能", () => {
	test("公司层技能来自文件，不是代码里的字符串", async () => {
		const { agents } = await workspace();
		const report = await syncCompanySkills(agents);
		// `写技能` / `找现成技能` 是所有人都该会的手艺，落在公司层。
		expect(report.copied).toEqual(expect.arrayContaining(["写技能", "找现成技能"]));
		const skills = await listSkills({ workspace: join(agents, ".."), agents }, "owner");
		expect(skills.map((skill) => skill.name)).toEqual(expect.arrayContaining(["写技能", "找现成技能"]));
		const body = await readSkill({ workspace: join(agents, ".."), agents }, "owner", "写技能");
		expect(body?.body).toContain("## 什么时候该写");
	});

	test("立项与招人是助理的个人技能，不进公司层", async () => {
		const { agents } = await workspace();
		// V3 把助理的个人技能挪到 seed/agents/assistant/skills/：一个 agent 的种子内容跟它的目录名走。
		const copied = await seedPersonalSkills(agents, "助理", "agents/assistant/skills");
		expect(copied).toEqual(expect.arrayContaining(["立项", "招人"]));

		// 公司层不该有它们：招人、立项是助理的职权，别人本来就不该招人。
		const synced = await syncCompanySkills(agents);
		const company = [...synced.copied, ...synced.updated];
		expect(company).not.toContain("立项");
		expect(company).not.toContain("招人");

		const body = await readSkill({ workspace: join(agents, ".."), agents }, "助理", "立项");
		expect(body?.body).toContain("## 什么时候立");
		expect(body?.scope).toBe("personal");
	});

	test("第二次播种不覆盖用户改过的内容", async () => {
		const { agents } = await workspace();
		await syncCompanySkills(agents);
		// 用户改了自己的技能。
		await writeCompanySkill(join(agents, ".."), { name: "写技能", description: "改过", body: "# 我自己的版本" });
		await syncCompanySkills(agents);
		const body = await readSkill({ workspace: join(agents, ".."), agents }, "owner", "写技能");
		expect(body?.body).toContain("我自己的版本");
	});
});
