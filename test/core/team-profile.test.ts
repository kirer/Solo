/**
 * 团队档案（`GET /api/teams/:slug`）：README + 管理员显示名 + 团队记忆。
 *
 * 只钉三件会悄悄坏掉的事：
 * 1. 没有这个团队 → 404，而不是一份空档案（界面会画出一个没名字的团队）。
 * 2. `lead` 的显示名从**名册**取，不是把 slug 原样印出来。
 * 3. 团队记忆没有逐条日志，时间是 `null` —— 不拿「现在」冒充「当时」。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTeams } from "../../src/core/app/teams.ts";
import type { CoreServices } from "../../src/core/app/types.ts";
import { writeTeam } from "../../src/core/team/doc.ts";
import { appendTeamMemory } from "../../src/core/team/memory.ts";

let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "core-team-profile-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function teams() {
	const shell = { teamsRoot: root, labelOf: (slug: string) => (slug === "林越" ? "林越" : slug) } as unknown as CoreServices;
	return createTeams(shell);
}

describe("团队档案", () => {
	test("没有这个团队就 404", async () => {
		await expect(teams().readTeamProfile("demo")).rejects.toThrow("没有这个团队");
	});

	test("README 的四个字段都搬过来", async () => {
		await writeTeam(root, { slug: "demo", name: "演示团队", lead: "林越", doing: "林越在写", body: "# 演示团队\n\n目标是 X。\n" });
		const profile = await teams().readTeamProfile("demo");
		expect(profile.name).toBe("演示团队");
		expect(profile.lead).toBe("林越");
		expect(profile.leadLabel).toBe("林越");
		expect(profile.doing).toBe("林越在写");
		expect(profile.body).toContain("目标是 X");
	});

	test("团队层的技能进档案（`teams/<slug>/skills/`）", async () => {
		await writeTeam(root, { slug: "demo", name: "演示团队", body: "目标。\n" });
		await mkdir(join(root, "demo", "skills", "发布"), { recursive: true });
		await writeFile(join(root, "demo", "skills", "发布", "SKILL.md"), "---\nname: 发布\ndescription: 怎么上线\n---\n\n正文\n", "utf8");
		const profile = await teams().readTeamProfile("demo");
		expect(profile.skills).toHaveLength(1);
		expect(profile.skills[0]).toMatchObject({ name: "发布", description: "怎么上线", scope: "team", overrides: false });
	});

	test("团队记忆按小节拆开，时间留空", async () => {
		await writeTeam(root, { slug: "demo", name: "演示团队", body: "目标。\n" });
		await appendTeamMemory(root, "demo", { text: "8080 常驻，别再起第二个。", by: "林越", at: new Date("2026-10-31T00:00:00Z") });
		const profile = await teams().readTeamProfile("demo");
		expect(profile.memory.exists).toBe(true);
		expect(profile.memory.entries).toHaveLength(1);
		expect(profile.memory.entries[0]?.body).toContain("8080");
		expect(profile.memory.entries[0]?.at).toBeNull();
	});
});
