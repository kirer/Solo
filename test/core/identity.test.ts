/**
 * 新核心的第一组测试：文件夹就是身份。
 *
 * 这里只验证三件事，它们是整套设计的承重墙：
 * 1. `identity.md` 的 YAML 头 + 正文被正确拆开；
 * 2. 谁是助理是**文件夹事实**：身份目录在应用根的 `assistant/` 下（ADR-058）；
 * 3. 渲染出的提示词**确定**（同样输入逐字节相同）且**不含任何身份文案常量**。
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	assistantsOf,
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
import { resolveLayout, type Layout } from "../../src/core/layout.ts";
import { renderAgentSection } from "../../src/core/agent/sections.ts";
import { createRegistry, defineExtension, defineTool, Type } from "../../src/core/runtime/index.ts";
import { seedPromptTemplates } from "../../src/shell/seed.ts";

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
---

我负责招人。用人需求从我说过要来的人那里来。
`;

describe("identity.md 解析", () => {
	test("拆出 YAML 头与正文", () => {
		const identity = parseIdentity("shen", "/tmp/x/shen", SAMPLE);
		expect(identity.name).toBe("沈知远");
		expect(identity.title).toBe("人力");
		expect(identity.team).toBeUndefined();
		expect(identity.body).toBe("我负责招人。用人需求从我说过要来的人那里来。");
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
		const header = { name: "沈知远", title: "人力", team: "alpha" };
		const body = "我负责招人。\n\n用人需求从我说过要来的人那里来。";
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

describe("谁是助理 = 文件夹事实（ADR-058）", () => {
	test("扫两个根：身份都在，助理只在 assistant/ 下", async () => {
		const root = await tempDir("core-agents-");
		await mkdir(join(root, "assistant", "知言"), { recursive: true });
		await writeFile(join(root, "assistant", "知言", "identity.md"), "---\nname: 知言\n---\n统筹。", "utf8");
		await mkdir(join(root, "members", "林越"), { recursive: true });
		await writeFile(join(root, "members", "林越", "identity.md"), "---\nname: 林越\n---\n写代码。", "utf8");
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		const all = await readAllIdentities(layout.agentRoots);
		expect(all.map((item) => item.slug)).toEqual(["知言", "林越"]);
		expect(assistantsOf(layout, all)).toEqual(["知言"]);
	});

	test("没有助理时就是空数组（不是猜一个人）", async () => {
		const root = await tempDir("core-agents-");
		await mkdir(join(root, "members", "林越"), { recursive: true });
		await writeFile(join(root, "members", "林越", "identity.md"), "---\nname: 林越\n---\n写代码。", "utf8");
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		expect(assistantsOf(layout, await readAllIdentities(layout.agentRoots))).toEqual([]);
	});
});

describe("渲染提示词（V3：模板 + 事实）", () => {
	/** 搭一个临时根（members/ + teams/ + 播种好的 prompt/），渲染某个人的提示词。 */
	async function rootOf(files: Record<string, string>): Promise<Layout> {
		const root = await tempDir();
		for (const [rel, body] of Object.entries(files)) {
			await mkdir(dirname(join(root, rel)), { recursive: true });
			await writeFile(join(root, rel), body, "utf8");
		}
		await mkdir(join(root, "teams"), { recursive: true });
		const layout = resolveLayout({ appRoot: root, userRoot: root });
		await seedPromptTemplates(layout);
		return layout;
	}

	async function renderIn(
		files: Record<string, string>,
		slug: string,
		registry = createRegistry(),
	): Promise<string> {
		const layout = await rootOf(files);
		return await renderAgentSection(registry, { layout, chats: async () => [] }, slug);
	}

	const ORG: Record<string, string> = {
		"assistant/知言/identity.md": "---\nname: 知言\n---\n统筹。",
		"members/林越/identity.md": "---\nname: 林越\nteam: alpha\n---\n写代码。",
		"teams/alpha/README.md": "---\nname: alpha\n---\n做一个坦克游戏。",
	};

	test("全部素材来自文件：名字、正文、助理、团队", async () => {
		const text = await renderIn(ORG, "林越");
		expect(text).toContain("# 你叫林越");
		expect(text).toContain("写代码。");
		expect(text).toContain("知言"); // 助理
		expect(text).toContain("做一个坦克游戏。"); // 团队 README
		expect(text).toContain("members/林越"); // 目录段
	});

	test("没写身份正文：整段消失，代码不补一句「我是谁」", async () => {
		const text = await renderIn({ "members/x/identity.md": "---\nname: 无名\n---\n" }, "x");
		expect(text).toContain("# 你叫无名");
		// 00-who 只留事实（正文在哪个文件），正文段由 `05-body.md` 的 skip-empty 整段吞掉。
		expect(text).toContain("identity.md");
		// 没有任何合成出来的身份文案。
		expect(text).not.toContain("我可以随时改这里");
	});

	test("目录说明不谎报文件：说到的文件必须真的会读", async () => {
		const text = await renderIn(ORG, "林越");
		// 曾经这里写的是 `capabilities` 与 `memory/` —— 两个都不存在的路径，
		// 等于在提示词里告诉 agent「去改一个不存在的文件」，它改完毫无效果。
		expect(text).not.toContain("`capabilities`");
		// 身份文件那半句在 `00-who` 里；目录段只讲两个根与 `file` 的分流，不重复别段的事实。
		expect(text).toContain("identity.md");
		expect(text).toContain("members/<slug>/");
		expect(text).toContain("teams/<团队>/");
	});

	test("确定性：同样输入逐字节相同", async () => {
		// 同一个根渲染两遍。不同沙箱算不同的输入 —— 目录段里有绝对路径，本来就该不一样。
		const layout = await rootOf(ORG);
		const once = await renderAgentSection(createRegistry(), { layout, chats: async () => [] }, "林越");
		const twice = await renderAgentSection(createRegistry(), { layout, chats: async () => [] }, "林越");
		expect(once).toBe(twice);
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
		const text = await renderIn(ORG, "林越", registry);
		expect(text).toContain("`say`");
		expect(text).toContain("`hire`");

		// 注册表空的时候不能凭空列假工具：直接报装配故障，让故障浮出来。
		expect(await renderIn(ORG, "林越")).toContain("装配故障");
	});

	test("没有助理时写「还没有助理」，不猜一个人", async () => {
		const text = await renderIn({ "members/x/identity.md": "---\nname: 孤儿\n---\n没人管我。" }, "x");
		expect(text).toContain("还没有助理");
		expect(text).not.toContain("助理：owner");
	});
});

test("规矩里的「@我」进了提示词（那是拍板唯一被认的写法）", async () => {
	const root = await tempDir();
	await mkdir(join(root, "members", "林越"), { recursive: true });
	await writeFile(join(root, "members", "林越", "identity.md"), "---\nname: 林越\n---\n\n写代码。\n");
	await mkdir(join(root, "teams"), { recursive: true });
	await writeFile(join(root, "rules.md"), "- 要让我拍板的事就用 `@我`，别写 `@owner`。\n");
	const layout = resolveLayout({ appRoot: root, userRoot: root });
	await seedPromptTemplates(layout);
	const text = await renderAgentSection(createRegistry(), { layout, chats: async () => [] }, "林越");
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
		await createAgent({ root: agents, name: "CTO" });
		expect((await listAgentSlugs(agents)).length).toBe(2);
		expect((await readAllIdentities(agents)).map((item) => item.slug)).toEqual(["CEO", "CTO"]);
	});
});
