/**
 * 提示词里的记忆目录：三段拼。
 *
 * 现场：成员把「先复现再修」记了三条，真遇到线上崩溃时一条也想不起来 —— 因为它排在
 * 尾巴 12 条之外，提示词里根本没有。反过来，无关的任务也会被灌进十几条旧经验。
 * 所以取法要同时满足两件互相拉扯的事：**相关的必须能进来**、**无关的一条也别进**。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planMemoryDigest, queryTerms } from "../../src/core/documents/base/memory.ts";
import {
	EMPTY_MEMORY_USE,
	MEMORY_USE_FILE,
	markUsed,
	readMemoryUse,
	recordClosing,
	writeMemoryUse,
} from "../../src/core/documents/member/memory-use.ts";

function memoryOf(count: number, extra: (index: number) => string = () => ""): string {
	const parts = ["# 记忆"];
	for (let index = 1; index <= count; index += 1) parts.push(`## 第 ${index} 条\n\n第 ${index} 条的内容。${extra(index)}`);
	return `${parts.join("\n\n")}\n`;
}

describe("记忆目录：三段拼", () => {
	it("连写 20 条：和老任务相关的那条、以及最新一条，都在", () => {
		const source = memoryOf(20, (index) => (index === 1 ? "音色迁移前先备份 userData。" : ""));
		const plan = planMemoryDigest(source, undefined, { query: "音色迁移怎么做", round: 21 });
		expect(plan).toBeDefined();
		expect(plan?.text).toContain("第 1 条");
		expect(plan?.text).toContain("第 20 条");
		// 相关的要展开正文，不是只有一行标题。
		expect(plan?.text).toContain("音色迁移前先备份 userData");
	});

	it("无关任务：不相关的一条也不许塞进来", () => {
		const source = memoryOf(20, (index) => (index === 1 ? "音色迁移前先备份 userData。" : ""));
		const plan = planMemoryDigest(source, undefined, { query: "数据库连接池超时", round: 3 });
		expect(plan?.text).not.toContain("第 1 条");
		// 只剩最近 3 条保底，没有「还有 N 条」以外的老条目。
		expect(plan?.text).toContain("第 20 条");
		expect(plan?.text).toContain("第 18 条");
		expect(plan?.text).not.toContain("第 17 条");
	});

	it("连续 20 轮没被取到：只给一行标题，不展开正文", () => {
		const source = memoryOf(20, (index) => (index === 1 ? "音色迁移前先备份 userData。" : ""));
		const plan = planMemoryDigest(source, undefined, { query: "数据库连接池超时", round: 25 });
		expect(plan?.text).toContain("第 1 条");
		const line = plan?.text.split("\n").find((item) => item.includes("第 1 条")) ?? "";
		expect(line).not.toContain("—");
	});

	it("刚被取到过的不召回：20 轮以内不给", () => {
		const source = memoryOf(20, (index) => (index === 1 ? "音色迁移前先备份 userData。" : ""));
		const plan = planMemoryDigest(source, undefined, {
			query: "数据库连接池超时",
			round: 25,
			used: { "第 1 条": 20 },
		});
		expect(plan?.text).not.toContain("第 1 条");
	});

	it("没有任务正文时退回旧取法（从新往旧、最多 12 条），不许把记忆关掉", () => {
		const source = memoryOf(20);
		const plan = planMemoryDigest(source, undefined, { query: "" });
		expect(plan?.text).toContain("第 20 条");
		expect(plan?.text).toContain("第 9 条");
		expect(plan?.text).not.toContain("第 8 条");
	});

	it("取到哪几条要报出来：调用方靠它记「上次被取到的轮次」", () => {
		const source = memoryOf(5, (index) => (index === 2 ? "音色迁移前先备份 userData。" : ""));
		const plan = planMemoryDigest(source, undefined, { query: "音色迁移", round: 5 });
		expect(plan?.picked).toContain("第 2 条");
		expect(plan?.picked).toContain("第 5 条");
	});

	it("切词：中文二元组能对上中间加了空格的写法，英文按整词", () => {
		const terms = queryTerms("音色 迁移 WebRTC");
		expect(terms).toContain("音色");
		expect(terms).toContain("迁移");
		expect(terms).toContain("webrtc");
		expect(queryTerms("")).toEqual([]);
	});
});

describe("轮次账：旁挂 .memory-use.json", () => {
	let box: string | undefined;
	afterEach(async () => {
		if (box !== undefined) await rm(box, { recursive: true, force: true });
		box = undefined;
	});

	it("读不到就当空的：这份账不能挡住提示词渲染", async () => {
		box = await mkdtemp(join(tmpdir(), "memory-use-"));
		expect(await readMemoryUse(box)).toEqual(EMPTY_MEMORY_USE);
	});

	it("坏了也当空的（删掉重算，最坏是多召回一条）", async () => {
		box = await mkdtemp(join(tmpdir(), "memory-use-"));
		await writeFile(join(box, MEMORY_USE_FILE), "{ 不是 json", "utf8");
		expect(await readMemoryUse(box)).toEqual(EMPTY_MEMORY_USE);
	});

	it("写进去读得回来；取到的标题记成「第几轮见过」", async () => {
		box = await mkdtemp(join(tmpdir(), "memory-use-"));
		const used = markUsed(EMPTY_MEMORY_USE, ["音色", "端口"]);
		await writeMemoryUse(box, used);
		const back = await readMemoryUse(box);
		expect(back.round).toBe(1);
		expect(back.seen).toEqual({ 音色: 1, 端口: 1 });
		const next = markUsed(back, ["端口"]);
		expect(next.round).toBe(2);
		expect(next.seen).toEqual({ 音色: 1, 端口: 2 });
	});

	it("收尾写了 none 要记进比例里", () => {
		const once = recordClosing(EMPTY_MEMORY_USE, "none");
		expect(once).toEqual({ ...EMPTY_MEMORY_USE, closing: 1, none: 1 });
		const twice = recordClosing(once, "先复现再改");
		expect(twice.closing).toBe(2);
		expect(twice.none).toBe(1);
	});
});
