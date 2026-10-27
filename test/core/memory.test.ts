import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DIGEST_LIMIT,
	appendMemory,
	memoryDigest,
	readMemory,
	sectionsOf,
	writeMemory,
} from "../../src/core/agent/memory.ts";

let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "core-memory-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("记忆：一份可以随手改的 Markdown", () => {
	it("没记过就是没记过，不自动建文件", async () => {
		expect(await readMemory(root)).toBeUndefined();
	});

	it("追加一条后能读回，带日期小节", async () => {
		await appendMemory(root, "招人时先问「要判断还是要执行」", new Date("2026-10-27T00:00:00Z"));
		const source = await readMemory(root);
		expect(source).toContain("## 2026-10-27");
		expect(source).toContain("招人时先问");
	});

	it("多次追加按时间顺序累加，不覆盖", async () => {
		await appendMemory(root, "第一条", new Date("2026-10-01T00:00:00Z"));
		await appendMemory(root, "第二条", new Date("2026-10-02T00:00:00Z"));
		const source = (await readMemory(root)) ?? "";
		expect(source.indexOf("第一条")).toBeLessThan(source.indexOf("第二条"));
	});

	it("可以整篇重写（记忆要被改得动，不是只增不减）", async () => {
		await appendMemory(root, "旧结论");
		await writeMemory(root, "# 记忆\n\n## 新\n只有这一条\n");
		const source = (await readMemory(root)) ?? "";
		expect(source).not.toContain("旧结论");
		expect(source).toContain("只有这一条");
	});

	it("按 ## 切段，文件开头的导语不算一条", () => {
		const sections = sectionsOf("# 记忆\n\n导语\n\n## 一\n内容一\n\n## 二\n内容二\n");
		expect(sections.map((section) => section.heading)).toEqual(["一", "二"]);
		expect(sections[0]?.body).toBe("内容一");
	});

	it("空内容没有目录（提示词里不出现「你还没有记忆」这种噪音）", () => {
		expect(memoryDigest("# 记忆\n")).toBeUndefined();
	});

	it("目录带摘要首行，超长截断到 60 字", () => {
		const long = "这是一句很长很长的结论".repeat(10);
		const digest = memoryDigest(`# 记忆\n\n## 2026-10-27\n${long}\n`);
		expect(digest).toContain("2026-10-27");
		expect(digest?.length).toBeLessThan(120);
	});

	it("条目超过上限时只列最近几条，并提示还有更早的", async () => {
		const lines = ["# 记忆"];
		for (let index = 0; index < DIGEST_LIMIT + 3; index += 1) lines.push(`## 条${index}`, `内容${index}`);
		const digest = memoryDigest(lines.join("\n")) ?? "";
		expect(digest).toContain("还有 3 条更早的没列出");
		expect(digest).toContain(`条${DIGEST_LIMIT + 2}`);
		expect(digest).not.toContain("条0 —");
	});
});
