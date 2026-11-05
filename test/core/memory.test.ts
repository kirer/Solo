import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SEED_TEXT } from "./catalog.ts";
import { appendMemory, readMemory, writeMemory } from "../../src/core/documents/member/memory.ts";
import {
	DIGEST_LIMIT,
	MEMORY_LIMITS,
	entryProblem,
	memoryDigest,
	problemText,
	sectionsOf,
} from "../../src/core/documents/base/memory.ts";

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
		expect(memoryDigest("# 记忆\n", SEED_TEXT)).toBeUndefined();
	});

	it("目录带摘要首行，超长截断到 60 字", () => {
		const long = "这是一句很长很长的结论".repeat(10);
		const digest = memoryDigest(`# 记忆\n\n## 2026-10-27\n${long}\n`, SEED_TEXT);
		expect(digest).toContain("2026-10-27");
		expect(digest?.length).toBeLessThan(120);
	});

	it("条目超过上限时只列最近几条，并提示还有更早的", async () => {
		const lines = ["# 记忆"];
		for (let index = 0; index < DIGEST_LIMIT + 3; index += 1) lines.push(`## 条${index}`, `内容${index}`);
		const digest = memoryDigest(lines.join("\n"), SEED_TEXT) ?? "";
		expect(digest).toContain("还有 3 条更早的没列出");
		expect(digest).toContain(`条${DIGEST_LIMIT + 2}`);
		expect(digest).not.toContain("条0 —");
	});
});

/**
 * 机器守的三条底线。模型判断不了这三件事：一条太长会吃掉整个记忆目录的预算，
 * 重复一条等于挤掉一条真正不同的，而密钥写进来就是**每一轮**都发给模型。
 */
describe("记忆的底线", () => {
	it("空的和只有空白的都拒", () => {
		expect(problemText(entryProblem("") ?? "empty", "", SEED_TEXT)).toBe("这条记忆是空的。");
		expect(problemText(entryProblem("   \n  ") ?? "empty", "   \n  ", SEED_TEXT)).toBe("这条记忆是空的。");
	});

	it("超长要报出具体字数，好让它自己压缩", () => {
		const long = "字".repeat(MEMORY_LIMITS.entry + 1);
		const problem = problemText(entryProblem(long) ?? "empty", long, SEED_TEXT);
		expect(problem).toContain(`${MEMORY_LIMITS.entry} 字上限`);
		expect(problem).toContain(`${MEMORY_LIMITS.entry + 1} 字`);
	});

	it("密钥一律拒收（记忆会被拼进每一轮提示词）", () => {
		for (const entry of ["我的 key 是 sk-abcdefghijklmnopqrstuvwx", "密码：hunter2hunter2hunter2", "AKIAABCDEFGHIJKLMNOP"]) {
			expect(problemText(entryProblem(entry) ?? "empty", entry, SEED_TEXT)).toContain("密钥");
		}
	});

	it("正常的经验照写", () => {
		expect(entryProblem("改端口要同时改 .env 和 ui 里的常量，否则界面连不上")).toBeUndefined();
	});

	it("重复的一条不写第二遍", async () => {
		await appendMemory(root, "先跑 check 再跑 test");
		const again = await appendMemory(root, "  先跑 check   再跑 test  ", new Date(), "agent", SEED_TEXT);
		expect(again.changed).toBe(false);
		expect(again.message).toBe("这条记忆已经有了。");
		const source = (await readMemory(root)) ?? "";
		expect(source.split("先跑 check 再跑 test").length - 1).toBe(1);
	});

	it("像密钥的内容根本落不了盘", async () => {
		const result = await appendMemory(root, "token: ghp_abcdefghijklmnopqrstuvwxyz012345");
		expect(result.changed).toBe(false);
		expect(await readMemory(root)).toBeUndefined();
	});

	it("并发写不丢条目（读-拼-写不是原子的）", async () => {
		await Promise.all([
			appendMemory(root, "第一条"),
			appendMemory(root, "第二条"),
			appendMemory(root, "第三条"),
		]);
		const source = (await readMemory(root)) ?? "";
		expect(source).toContain("第一条");
		expect(source).toContain("第二条");
		expect(source).toContain("第三条");
	});

	it("同一天的第二条并进当天的小节，不再新开一个同名标题", async () => {
		await appendMemory(root, "上午的结论", new Date("2026-10-27T01:00:00Z"));
		await appendMemory(root, "下午的结论", new Date("2026-10-27T09:00:00Z"));
		const source = (await readMemory(root)) ?? "";
		expect(source.split("## 2026-10-27").length - 1).toBe(1);
		expect(source).toContain("上午的结论");
		expect(source).toContain("下午的结论");
	});
});
