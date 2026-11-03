import { SEED_TEXT } from "./catalog.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendTeamMemory,
	teamMemoryDigest,
	teamMemoryPath,
	teamMemorySections,
	readTeamMemory,
} from "../../src/core/team/memory.ts";

let teams = "";

beforeEach(async () => {
	teams = await mkdtemp(join(tmpdir(), "core-team-memory-"));
});

afterEach(async () => {
	await rm(teams, { recursive: true, force: true });
});

describe("团队记忆：teams/<slug>/memory.md", () => {
	it("没记过就是 undefined，不自动建空文件", async () => {
		expect(await readTeamMemory(teams, "alpha")).toBeUndefined();
	});

	it("追加一条带日期与记录人", async () => {
		await appendTeamMemory(teams, "alpha", {
			text: "后端超时是因为连接池默认只有 5。",
			by: "林越",
			at: new Date("2026-10-27T03:00:00Z"),
			catalog: SEED_TEXT,
		});
		const source = await readTeamMemory(teams, "alpha");
		expect(source).toContain("## 2026-10-27 林越");
		expect(source).toContain("连接池默认只有 5");
		expect(source?.startsWith("# 团队记忆：alpha")).toBe(true);
	});

	it("第二条追加在末尾，第一条不丢", async () => {
		await appendTeamMemory(teams, "alpha", { text: "第一条", at: new Date("2026-10-26T00:00:00Z") });
		await appendTeamMemory(teams, "alpha", { text: "第二条", at: new Date("2026-10-27T00:00:00Z") });
		const sections = teamMemorySections((await readTeamMemory(teams, "alpha")) ?? "");
		expect(sections).toHaveLength(2);
		expect(sections[0]?.body).toBe("第一条");
		expect(sections[1]?.body).toBe("第二条");
	});

	it("不带 by 时标题只有日期", async () => {
		await appendTeamMemory(teams, "alpha", { text: "x", at: new Date("2026-10-27T00:00:00Z") });
		const source = await readTeamMemory(teams, "alpha");
		expect(source).toContain("## 2026-10-27\n");
	});

	it("不同团队互不干扰", async () => {
		await appendTeamMemory(teams, "alpha", { text: "alpha 的事" });
		await appendTeamMemory(teams, "beta", { text: "beta 的事" });
		expect(await readTeamMemory(teams, "alpha")).toContain("alpha 的事");
		expect(await readTeamMemory(teams, "alpha")).not.toContain("beta 的事");
		expect(await readTeamMemory(teams, "beta")).toContain("beta 的事");
	});

	it("摘要只给标题 + 首行，不给全文", async () => {
		for (let index = 0; index < 3; index += 1) {
			await appendTeamMemory(teams, "alpha", {
				text: `第 ${index} 条的正文，这句话不该整段进提示词。`,
				by: "林越",
				at: new Date(`2026-10-2${index}T00:00:00Z`),
			});
		}
		const digest = teamMemoryDigest((await readTeamMemory(teams, "alpha")) ?? "", SEED_TEXT);
		expect(digest).toBeDefined();
		expect(digest).toContain("2026-10-22 林越");
		expect(digest?.split("\n")).toHaveLength(3);
	});

	it("路径就是 teams/<slug>/memory.md（能被 git 直接看见）", () => {
		expect(teamMemoryPath(teams, "alpha")).toBe(join(teams, "alpha", "memory.md"));
	});

	it("写盘的是 Markdown，不是二进制", async () => {
		await appendTeamMemory(teams, "alpha", { text: "人可读" });
		const raw = await readFile(join(teams, "alpha", "memory.md"), "utf8");
		expect(raw).toContain("人可读");
	});
});

describe("团队记忆的闸", () => {
	it("超长条目直接拒写，不做静默截断", async () => {
		await expect(
			appendTeamMemory(teams, "alpha", { text: "长".repeat(301), catalog: SEED_TEXT }),
		).rejects.toThrow(/上限/);
		expect(await readTeamMemory(teams, "alpha")).toBeUndefined();
	});

	it("空条目拒写", async () => {
		await expect(appendTeamMemory(teams, "alpha", { text: "   ", catalog: SEED_TEXT })).rejects.toThrow(/空/);
	});

	it("像密钥的内容拒写", async () => {
		await expect(
			appendTeamMemory(teams, "alpha", { text: "token 是 sk-abcdefghijklmnopqrstuvwxyz123456", catalog: SEED_TEXT }),
		).rejects.toThrow(/密钥|密码/);
	});

	it("并发追加不丢条目（串行闸）", async () => {
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				appendTeamMemory(teams, "alpha", { text: `第 ${index} 条` }),
			),
		);
		const source = (await readTeamMemory(teams, "alpha")) ?? "";
		for (let index = 0; index < 8; index += 1) expect(source).toContain(`第 ${index} 条`);
	});
});

