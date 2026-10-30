import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryTimeline } from "../../src/core/agent/memory.ts";
import { journalPath } from "../../src/core/agent/journal.ts";

let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "core-timeline-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const line = (at: string, by: string, before: string, after: string): string =>
	`${JSON.stringify({ at, by, op: "append", before, after })}\n`;

describe("memoryTimeline", () => {
	it("没有日志时返回空表（不编时间）", async () => {
		const stamps = await memoryTimeline(root);
		expect(stamps.size).toBe(0);
	});

	it("新出现的小节记成 add，带上时间与作者", async () => {
		const before = "# 记忆\n";
		const after = "# 记忆\n\n## 2026-10-27\n- 老板讨厌废话。\n";
		await writeFile(journalPath(root), line("2026-10-27T03:12:00.000Z", "human", before, after), "utf8");
		const stamps = await memoryTimeline(root);
		expect(stamps.get("2026-10-27")).toEqual({ at: "2026-10-27T03:12:00.000Z", by: "human", op: "add" });
	});

	it("正文变了记成 edit，时间取最后一次", async () => {
		const a = "# 记忆\n\n## 2026-10-27\n- 旧。\n";
		const b = "# 记忆\n\n## 2026-10-27\n- 新。\n";
		await writeFile(
			journalPath(root),
			line("2026-10-27T03:12:00.000Z", "human", "# 记忆\n", a) + line("2026-10-28T09:00:00.000Z", "agent", a, b),
			"utf8",
		);
		const stamps = await memoryTimeline(root);
		expect(stamps.get("2026-10-27")).toEqual({ at: "2026-10-28T09:00:00.000Z", by: "agent", op: "edit" });
	});

	it("没变的小节不刷新时间", async () => {
		const a = "# 记忆\n\n## A\n- 一。\n\n## B\n- 二。\n";
		const b = "# 记忆\n\n## A\n- 一。\n\n## B\n- 二改。\n";
		await writeFile(
			journalPath(root),
			line("2026-10-27T03:00:00.000Z", "human", "# 记忆\n", a) + line("2026-10-28T03:00:00.000Z", "agent", a, b),
			"utf8",
		);
		const stamps = await memoryTimeline(root);
		expect(stamps.get("A")?.at).toBe("2026-10-27T03:00:00.000Z");
		expect(stamps.get("B")?.at).toBe("2026-10-28T03:00:00.000Z");
	});

	it("删掉的小节不再留时间戳（同名以后出现算新加的）", async () => {
		const a = "# 记忆\n\n## A\n- 一。\n";
		const gone = "# 记忆\n";
		const back = "# 记忆\n\n## A\n- 一。\n";
		await writeFile(
			journalPath(root),
			line("2026-10-27T03:00:00.000Z", "human", "# 记忆\n", a) +
				line("2026-10-28T03:00:00.000Z", "human", a, gone) +
				line("2026-10-29T03:00:00.000Z", "remember", gone, back),
			"utf8",
		);
		const stamps = await memoryTimeline(root);
		expect(stamps.get("A")).toEqual({ at: "2026-10-29T03:00:00.000Z", by: "remember", op: "add" });
	});

	it("坏行跳过，不影响其它行", async () => {
		const after = "# 记忆\n\n## A\n- 一。\n";
		await appendFile(journalPath(root), "{ 这不是 JSON\n", "utf8");
		await appendFile(journalPath(root), line("2026-10-27T03:00:00.000Z", "human", "", after), "utf8");
		const stamps = await memoryTimeline(root);
		expect(stamps.get("A")?.by).toBe("human");
	});
});
