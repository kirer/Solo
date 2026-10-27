import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendProjectMemory,
	projectMemoryDigest,
	projectMemoryPath,
	projectMemorySections,
	readProjectMemory,
	writeProjectMemory,
} from "../../src/core/project/memory.ts";

let projects = "";

beforeEach(async () => {
	projects = await mkdtemp(join(tmpdir(), "core-project-memory-"));
});

afterEach(async () => {
	await rm(projects, { recursive: true, force: true });
});

describe("项目记忆：projects/<slug>/memory.md", () => {
	it("没记过就是 undefined，不自动建空文件", async () => {
		expect(await readProjectMemory(projects, "alpha")).toBeUndefined();
	});

	it("追加一条带日期与记录人", async () => {
		await appendProjectMemory(projects, "alpha", {
			text: "后端超时是因为连接池默认只有 5。",
			by: "林越",
			at: new Date("2026-10-27T03:00:00Z"),
		});
		const source = await readProjectMemory(projects, "alpha");
		expect(source).toContain("## 2026-10-27 林越");
		expect(source).toContain("连接池默认只有 5");
		expect(source?.startsWith("# 项目记忆：alpha")).toBe(true);
	});

	it("第二条追加在末尾，第一条不丢", async () => {
		await appendProjectMemory(projects, "alpha", { text: "第一条", at: new Date("2026-10-26T00:00:00Z") });
		await appendProjectMemory(projects, "alpha", { text: "第二条", at: new Date("2026-10-27T00:00:00Z") });
		const sections = projectMemorySections((await readProjectMemory(projects, "alpha")) ?? "");
		expect(sections).toHaveLength(2);
		expect(sections[0]?.body).toBe("第一条");
		expect(sections[1]?.body).toBe("第二条");
	});

	it("不带 by 时标题只有日期", async () => {
		await appendProjectMemory(projects, "alpha", { text: "x", at: new Date("2026-10-27T00:00:00Z") });
		const source = await readProjectMemory(projects, "alpha");
		expect(source).toContain("## 2026-10-27\n");
	});

	it("不同项目互不干扰", async () => {
		await appendProjectMemory(projects, "alpha", { text: "alpha 的事" });
		await appendProjectMemory(projects, "beta", { text: "beta 的事" });
		expect(await readProjectMemory(projects, "alpha")).toContain("alpha 的事");
		expect(await readProjectMemory(projects, "alpha")).not.toContain("beta 的事");
		expect(await readProjectMemory(projects, "beta")).toContain("beta 的事");
	});

	it("整篇替换：能改掉错的结论，而不是只能追加", async () => {
		await appendProjectMemory(projects, "alpha", { text: "旧结论" });
		await writeProjectMemory(projects, "alpha", "# 项目记忆：alpha\n\n## 2026-10-27\n新结论\n");
		const source = await readProjectMemory(projects, "alpha");
		expect(source).toContain("新结论");
		expect(source).not.toContain("旧结论");
	});

	it("摘要只给标题 + 首行，不给全文", async () => {
		for (let index = 0; index < 3; index += 1) {
			await appendProjectMemory(projects, "alpha", {
				text: `第 ${index} 条的正文，这句话不该整段进提示词。`,
				by: "林越",
				at: new Date(`2026-10-2${index}T00:00:00Z`),
			});
		}
		const digest = projectMemoryDigest((await readProjectMemory(projects, "alpha")) ?? "");
		expect(digest).toBeDefined();
		expect(digest).toContain("2026-10-22 林越");
		expect(digest?.split("\n")).toHaveLength(3);
	});

	it("路径就是 projects/<slug>/memory.md（能被 git 直接看见）", () => {
		expect(projectMemoryPath(projects, "alpha")).toBe(join(projects, "alpha", "memory.md"));
	});

	it("写盘的是 Markdown，不是二进制", async () => {
		await appendProjectMemory(projects, "alpha", { text: "人可读" });
		const raw = await readFile(join(projects, "alpha", "memory.md"), "utf8");
		expect(raw).toContain("人可读");
	});
});
