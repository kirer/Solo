/**
 * 新核心的第一组测试：文件夹就是身份。
 *
 * 这里只验证三件事，它们是整套设计的承重墙：
 * 1. `identity.md` 的 YAML 头 + 正文被正确拆开；
 * 2. 组织架构完全由 `manager` 字段推导（没有枚举、没有数据库）；
 * 3. 渲染出的提示词**确定**（同样输入逐字节相同）且**不含任何岗位文案常量**。
 */
import { describe, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
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
import { renderAgentPrompt } from "../../src/core/agent/prompt.ts";
import { readCapabilities } from "../../src/core/agent/runtime.ts";

const SAMPLE = `---
name: 沈知远
title: 人力
manager: owner
---

我负责招人。用人需求从项目负责人那里来。
`;

describe("identity.md 解析", () => {
	test("拆出 YAML 头与正文", () => {
		const identity = parseIdentity("shen", "/tmp/x/shen", SAMPLE);
		expect(identity.name).toBe("沈知远");
		expect(identity.title).toBe("人力");
		expect(identity.manager).toBe(OWNER_SLUG);
		expect(identity.project).toBeUndefined();
		expect(identity.body).toBe("我负责招人。用人需求从项目负责人那里来。");
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

describe("渲染提示词", () => {
	const all = [
		parseIdentity("ceo", "/a/ceo", "---\nname: 陆沉\nmanager: owner\n---\n管全局。"),
		parseIdentity("cto", "/a/cto", "---\nname: 周牧\nmanager: ceo\n---\n管技术。"),
		parseIdentity("dev", "/a/dev", "---\nname: 林越\nmanager: cto\nproject: alpha\n---\n写代码。"),
	];

	test("全部素材来自文件：名字、正文、汇报线、项目", () => {
		const dev = all[2]!;
		const text = renderAgentPrompt({ self: dev, all, projectBrief: "做一个坦克游戏。" });
		expect(text).toContain("# 你叫林越");
		expect(text).toContain("写代码。");
		expect(text).toContain("你的上级：周牧（`cto`）");
		expect(text).toContain("周牧 → 陆沉 → 老板");
		expect(text).toContain("做一个坦克游戏。");
		expect(text).toContain("agents/dev/");
	});

	test("确定性：同样输入逐字节相同", () => {
		const input = { self: all[1]!, all, projectBrief: "b" } as const;
		expect(renderAgentPrompt(input)).toBe(renderAgentPrompt(input));
	});

	test("没有额外能力时，基础能力照写、并说清清单是空的", () => {
		const text = renderAgentPrompt({ self: all[1]!, all });
		// 基础能力人人都有，不能被渲染成「什么都不能做」（那是提示词撒谎）。
		expect(text).toContain("`say`");
		expect(text).toContain("`hire`");
		expect(text).toContain("你的 `capabilities` 文件现在是空的");
	});

	test("断链时写「未设置」而不是猜一个上级", () => {
		const orphan = parseIdentity("x", "/a/x", "---\nname: 孤儿\n---\n没人管我。");
		const text = renderAgentPrompt({ self: orphan, all: [orphan] });
		expect(text).toContain("你的上级：（未设置）");
	});
});

describe("capabilities 文件", () => {
	test("一行一项，注释与空行被忽略", async () => {
		const root = await workspace({
			"dev/capabilities": "# 我的能力\nread_file\nrun_shell\n\n",
		});
		try {
			expect(await readCapabilities(root, "dev")).toEqual(["read_file", "run_shell"]);
			expect(await readCapabilities(root, "missing")).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
