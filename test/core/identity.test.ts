/**
 * 新核心的第一组测试：文件夹就是身份。
 *
 * 这里只验证三件事，它们是整套设计的承重墙：
 * 1. `identity.md` 的 YAML 头 + 正文被正确拆开；
 * 2. 组织架构完全由 `manager` 字段推导（没有枚举、没有数据库）；
 * 3. 渲染出的提示词**确定**（同样输入逐字节相同）且**不含任何身份文案常量**。
 */
import { describe, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	OWNER_SLUG,
	chainUp,
	parseIdentity,
	readAllIdentities,
	reportsOf,
} from "../../src/core/agent/identity.ts";
import { renderAgentSection } from "../../src/core/agent/runtime.ts";
import { createRegistry, defineExtension, defineTool, Type } from "../../src/core/runtime/index.ts";
import { seedPromptTemplates } from "../../src/core/shell/seed.ts";

const SAMPLE = `---
name: 沈知远
title: 人力
manager: owner
---

我负责招人。用人需求从团队管理员那里来。
`;

describe("identity.md 解析", () => {
	test("拆出 YAML 头与正文", () => {
		const identity = parseIdentity("shen", "/tmp/x/shen", SAMPLE);
		expect(identity.name).toBe("沈知远");
		expect(identity.title).toBe("人力");
		expect(identity.manager).toBe(OWNER_SLUG);
		expect(identity.team).toBeUndefined();
		expect(identity.body).toBe("我负责招人。用人需求从团队管理员那里来。");
	});

	test("没有 YAML 头时整份文件都是正文", () => {
		const identity = parseIdentity("bare", "/tmp/x/bare", "只有正文。");
		expect(identity.name).toBeUndefined();
		expect(identity.body).toBe("只有正文。");
	});

	test("引号被剥掉、空值当作没写", () => {
		const identity = parseIdentity("q", "/tmp/x/q", '---\nname: "林越"\ntitle: ""\n---\n正文');
		expect(identity.name).toBe("林越");
		expect(identity.title).toBeUndefined();
	});
});

/** 造一个 agents 目录。 */
async function workspace(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "core-agents-"));
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(root, path.split("/").slice(0, -1).join("/")), { recursive: true });
		await writeFile(join(root, path), content, "utf8");
	}
	return root;
}

describe("组织架构 = manager 字段", () => {
	test("扫描目录得到全部身份，按 slug 排序", async () => {
		const root = await workspace({
			"ceo/identity.md": "---\nname: 陆沉\nmanager: owner\n---\n管全局。",
			"cto/identity.md": "---\nname: 周牧\nmanager: ceo\n---\n管技术。",
			"dev/identity.md": "---\nname: 林越\nmanager: cto\nproject: alpha\n---\n写代码。",
		});
		try {
			const all = await readAllIdentities(root);
			expect(all.map((item) => item.slug)).toEqual(["ceo", "cto", "dev"]);
			expect(reportsOf(all, "ceo").map((item) => item.slug)).toEqual(["cto"]);
			expect(chainUp(all, "dev")).toEqual(["cto", "ceo", OWNER_SLUG]);
			expect(chainUp(all, "ceo")).toEqual([OWNER_SLUG]);
			expect(chainUp(all, "nobody")).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("断链就地停止，不抛错", async () => {
		const root = await workspace({
			"a/identity.md": "---\nmanager: ghost\n---\n甲",
			"b/identity.md": "---\nmanager: a\n---\n乙",
		});
		try {
			const all = await readAllIdentities(root);
			expect(chainUp(all, "b")).toEqual(["a", "ghost"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("同名循环不死循环", async () => {
		const root = await workspace({
			"a/identity.md": "---\nmanager: b\n---\n甲",
			"b/identity.md": "---\nmanager: a\n---\n乙",
		});
		try {
			const all = await readAllIdentities(root);
			expect(chainUp(all, "a")).toEqual(["b"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("渲染提示词（V3：模板 + 事实）", () => {
	/** 搭一个临时工作区（agents/ + teams/ + 播种好的 prompt/），渲染某个人的提示词。 */
	async function renderIn(
		files: Record<string, string>,
		slug: string,
		registry = createRegistry(),
	): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "core-identity-"));
		try {
			for (const [rel, body] of Object.entries(files)) {
				await mkdir(dirname(join(root, rel)), { recursive: true });
				await writeFile(join(root, rel), body, "utf8");
			}
			await mkdir(join(root, "teams"), { recursive: true });
			await seedPromptTemplates(root);
			return await renderAgentSection(
				registry,
				{ workspace: root, agents: join(root, "agents"), teams: join(root, "teams"), chats: async () => [] },
				slug,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	const ORG: Record<string, string> = {
		"agents/ceo/identity.md": "---\nname: 陆沉\nmanager: owner\n---\n管全局。",
		"agents/cto/identity.md": "---\nname: 周牧\nmanager: ceo\n---\n管技术。",
		"agents/dev/identity.md": "---\nname: 林越\nmanager: cto\nteam: alpha\n---\n写代码。",
		"teams/alpha/README.md": "---\nname: alpha\nlead: dev\n---\n做一个坦克游戏。",
	};

	test("全部素材来自文件：名字、正文、汇报线、团队", async () => {
		const text = await renderIn(ORG, "dev");
		expect(text).toContain("# 你叫林越");
		expect(text).toContain("写代码。");
		expect(text).toContain("周牧"); // 直属上级
		expect(text).toContain("陆沉"); // 上报链的更上面一层
		expect(text).toContain("做一个坦克游戏。"); // 团队 README
		expect(text).toContain("agents/dev"); // 目录段
	});

	test("目录说明不谎报文件：说到的文件必须真的会读", async () => {
		const text = await renderIn(ORG, "dev");
		// 曾经这里写的是 `capabilities` 与 `memory/` —— 两个都不存在的路径，
		// 等于在提示词里告诉 agent「去改一个不存在的文件」，它改完毫无效果。
		expect(text).not.toContain("`capabilities`");
		expect(text).toContain("`identity.md`");
		expect(text).toContain("`memory.md`");
		expect(text).toContain("skills/<名字>/SKILL.md");
	});

	test("确定性：同样输入逐字节相同", async () => {
		expect(await renderIn(ORG, "dev")).toBe(await renderIn(ORG, "dev"));
	});

	test("工具清单从注册表实拍，不写死的清单", async () => {
		const registry = createRegistry();
		registry.install(
			defineExtension({
				name: "test-tools",
				tools: [
					defineTool({ name: "say", description: "在频道说话。", parameters: Type.Object({}) }),
					defineTool({ name: "hire", description: "新建一个 agent。", parameters: Type.Object({}) }),
				],
			}),
		);
		const text = await renderIn(ORG, "dev", registry);
		expect(text).toContain("`say`");
		expect(text).toContain("`hire`");

		// 注册表空的时候不能凭空列假工具：直接报装配故障，让故障浮出来。
		expect(await renderIn(ORG, "dev")).toContain("装配故障");
	});

	test("断链时写「未设置」而不是猜一个上级", async () => {
		const text = await renderIn({ "agents/x/identity.md": "---\nname: 孤儿\n---\n没人管我。" }, "x");
		expect(text).toContain("未设置");
		expect(text).not.toContain("你的上级：owner");
	});
});

test("规矩里的「@我」进了提示词（那是拍板唯一被认的写法）", async () => {
	const root = await mkdtemp(join(tmpdir(), "core-identity-"));
	try {
		await mkdir(join(root, "agents", "林越"), { recursive: true });
		await writeFile(join(root, "agents", "林越", "identity.md"), "---\nname: 林越\nmanager: owner\n---\n\n写代码。\n");
		await mkdir(join(root, "teams"), { recursive: true });
		await writeFile(join(root, "rules.md"), "- 要让我拍板的事就用 `@我`，别写 `@owner`。\n");
		await seedPromptTemplates(root);
		const text = await renderAgentSection(
			createRegistry(),
			{ workspace: root, agents: join(root, "agents"), teams: join(root, "teams"), chats: async () => [] },
			"林越",
		);
		expect(text).toContain("`@我`");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
