import { SEED_TEXT } from "./catalog.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOURNAL_FILE, appendJournal, journalPath } from "../../src/core/agent/journal.ts";
import { appendMemory, readMemory, writeMemory } from "../../src/core/agent/memory.ts";

/**
 * 记忆留痕。守的是「文件可改」的代价：改得动是优点，改了没痕迹是缺点。
 * 事后要能回答三个问题：什么时候、谁、从什么改成什么。
 */
let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "core-journal-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function lines(): Promise<Record<string, unknown>[]> {
	const source = await readFile(journalPath(root), "utf8");
	return source
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("记忆日志", () => {
	it("一行一条 JSON，字段原样留着", async () => {
		await appendJournal(root, {
			at: "2026-10-27T00:00:00.000Z",
			by: "human",
			op: "append",
			before: "旧",
			after: "旧\n新",
		});
		await appendJournal(root, {
			at: "2026-10-28T00:00:00.000Z",
			by: "agent",
			op: "replace",
			before: "旧\n新",
			after: "只剩这一条",
		});
		const entries = await lines();
		expect(entries).toHaveLength(2);
		expect(entries[1]).toMatchObject({ by: "agent", op: "replace", before: "旧\n新" });
	});

	it("落盘失败只 warn，不打断主写入", async () => {
		const missing = join(root, "没有这个目录");
		await expect(
			appendJournal(missing, { at: "x", by: "agent", op: "append", before: "", after: "a" }),
		).resolves.toBeUndefined();
	});

	it("appendMemory 留痕的 before 是写入前的整篇内容", async () => {
		await appendMemory(root, "第一条", new Date("2026-10-01T00:00:00Z"), "remember", SEED_TEXT);
		const afterFirst = (await readMemory(root)) ?? "";
		await appendMemory(root, "第二条", new Date("2026-10-02T00:00:00Z"), "remember", SEED_TEXT);
		const entries = await lines();
		expect(entries).toHaveLength(2);
		expect(entries[0]?.before).toBe("# 记忆\n");
		expect(entries[1]?.before).toBe(afterFirst);
		expect(String(entries[1]?.after)).toContain("第二条");
		expect(entries[1]).toMatchObject({ by: "remember", op: "append" });
	});

	it("整篇重写也留痕（op=replace）", async () => {
		await appendMemory(root, "旧结论", new Date(), "agent", SEED_TEXT);
		await writeMemory(root, "## 新\n只有这一条", "agent");
		const entries = await lines();
		const last = entries[entries.length - 1];
		expect(last).toMatchObject({ op: "replace" });
		expect(String(last?.before)).toContain("旧结论");
		expect(String(last?.after)).not.toContain("旧结论");
	});
});

describe("记忆日志文件位置", () => {
	it("跟 memory.md 在同一个目录，人一眼能找到", () => {
		expect(journalPath("/tmp/x")).toBe(join("/tmp/x", JOURNAL_FILE));
	});
});
