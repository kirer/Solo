/**
 * 新核心的第一组测试：文件夹就是身份。
 *
 * 这里只验证三件事，它们是整套设计的承重墙：
 * 1. `identity.md` 的 YAML 头 + 正文被正确拆开；
 * 2. 组织架构完全由 `manager` 字段推导（没有枚举、没有数据库）；
 * 3. 渲染出的提示词**确定**（同样输入逐字节相同）且**不含任何身份文案常量**。
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	OWNER_SLUG,
	chainUp,
	createAgent,
	parseIdentity,
	listAgentSlugs,
	readAllIdentities,
	readIdentity,
	renderIdentityFile,
	reportsOf,
	uniqueSlug,
	writeIdentity,
} from "../../src/core/agent/identity.ts";
import { renderAgentSection } from "../../src/core/agent/sections.ts";
import { createRegistry, defineExtension, defineTool, Type } from "../../src/core/runtime/index.ts";
import { seedPromptTemplates } from "../../src/core/shell/seed.ts";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 临时目录，afterEach 统一删。 */
async function tempDir(prefix = "core-identity-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

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

describe("身份文件读写只有一处（ADR-096）", () => {
	test("writeIdentity 写下的字节就是 renderIdentityFile，且读得回", async () => {
		const root = await tempDir();
		const header = { name: "沈知远", title: "人力", manager: OWNER_SLUG, team: "alpha" };
		const body = "我负责招人。\n\n用人需求从团队管理员那里来。";
		const written = await writeIdentity(root, "shen", header, body);

		expect(await readFile(join(root, "shen", "identity.md"), "utf8")).toBe(renderIdentityFile(header, body));
		// 写出去的东西一定读得回来：写入口与读入口共用同一套解析。
		expect(await readIdentity(root, "shen")).toEqual(written);
		expect(written.body).toBe(body);
	});

	test("缺省字段不写成空行；返回的身份直接可用", async () => {
		const root = await tempDir();
		const written = await writeIdentity(root, "lin", { name: "林越" }, "写代码。");
		const source = await readFile(join(root, "lin", "identity.md"), "utf8");
		expect(source).not.toContain("team:");
		expect(source).not.toContain("manager:");
		expect(written).toMatchObject({ slug: "lin", name: "林越", body: "写代码。" });
	});

	test("写入口自己过名字闸：owner / .. / a/b 都写不出去", async () => {
		const root = await tempDir();
		for (const slug of ["owner", "..", "a/b", ""]) {
			await expect(writeIdentity(root, slug, { name: "X" }, "正文"), slug).rejects.toThrow();
		}
	});
});

/** 造一个 agents 目录。 */
async function workspace(files: Record<string, string>): Promise<string> {
	const root = await tempDir("core-agents-");
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
		const all = await readAllIdentities(root);
		expect(all.map((item) => item.slug)).toEqual(["ceo", "cto", "dev"]);
		expect(reportsOf(all, "ceo").map((item) => item.slug)).toEqual(["cto"]);
		expect(chainUp(all, "dev")).toEqual(["cto", "ceo", OWNER_SLUG]);
		expect(chainUp(all, "ceo")).toEqual([OWNER_SLUG]);
		expect(chainUp(all, "nobody")).toEqual([]);
	});

	test("断链就地停止，不抛错", async () => {
		const root = await workspace({
			"a/identity.md": "---\nmanager: ghost\n---\n甲",
			"b/identity.md": "---\nmanager: a\n---\n乙",
		});
		const all = await readAllIdentities(root);
		expect(chainUp(all, "b")).toEqual(["a", "ghost"]);
	});

	test("同名循环不死循环", async () => {
		const root = await workspace({
			"a/identity.md": "---\nmanager: b\n---\n甲",
			"b/identity.md": "---\nmanager: a\n---\n乙",
		});
		const all = await readAllIdentities(root);
		expect(chainUp(all, "a")).toEqual(["b"]);
	});
});

describe("渲染提示词（V3：模板 + 事实）", () => {
	/** 搭一个临时工作区（agents/ + teams/ + 播种好的 prompt/），渲染某个人的提示词。 */
	async function renderIn(
		files: Record<string, string>,
		slug: string,
		registry = createRegistry(),
	): Promise<string> {
		const root = await tempDir();
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

	test("没写身份正文：整段消失，代码不补一句「我是谁」", async () => {
		const text = await renderIn({ "agents/x/identity.md": "---\nname: 无名\n---\n" }, "x");
		expect(text).toContain("# 你叫无名");
		// 00-who 只留事实（正文在哪个文件），正文段由 `05-body.md` 的 skip-empty 整段吞掉。
		expect(text).toContain("identity.md");
		// 没有任何合成出来的身份文案。
		expect(text).not.toContain("我可以随时改这里");
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
	const root = await tempDir();
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
});

describe("建人（createAgent）", () => {
	test("显式 slug 也过闸：`.`、`..`、`owner`、带 / 的一律拒绝", async () => {
		const agents = await tempDir("core-org-");
		for (const slug of ["..", ".", "owner", "a/b"]) {
			await expect(createAgent({ root: agents, name: "林子", slug }), slug).rejects.toThrow();
		}
	});

	test("重名自动加后缀", async () => {
		const agents = await tempDir("core-org-");
		expect(await uniqueSlug(agents, "林越")).toBe("林越");
		await createAgent({ root: agents, name: "林越" });
		expect(await uniqueSlug(agents, "林越")).toBe("林越-2");
	});

	test("建完就能读回来，字段无损", async () => {
		const agents = await tempDir("core-org-");
		await createAgent({
			root: agents,
			name: "林越",
			title: "技术负责人",
			manager: "owner",
			team: "alpha",
			body: "我管技术。",
		});
		const identity = await readIdentity(agents, "林越");
		expect(identity?.name).toBe("林越");
		expect(identity?.title).toBe("技术负责人");
		expect(identity?.manager).toBe("owner");
		expect(identity?.team).toBe("alpha");
		expect(identity?.body).toBe("我管技术。");
	});

	test("不写正文就是空正文：代码不编一段「我是谁」", async () => {
		const agents = await tempDir("core-org-");
		await createAgent({ root: agents, name: "无名" });
		const identity = await readIdentity(agents, "无名");
		expect(identity?.body).toBe("");
	});

	test("全员人数 = 目录数", async () => {
		const agents = await tempDir("core-org-");
		await createAgent({ root: agents, name: "CEO" });
		await createAgent({ root: agents, name: "CTO", manager: "CEO" });
		expect((await listAgentSlugs(agents)).length).toBe(2);
		expect((await readAllIdentities(agents)).map((item) => item.slug)).toEqual(["CEO", "CTO"]);
	});
});
