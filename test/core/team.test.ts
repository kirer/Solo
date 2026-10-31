import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	leadProblem,
	listTeams,
	membersOfTeam,
	readTeam,
	renderTeamFile,
	writeTeam,
} from "../../src/core/team/doc.ts";

let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "core-team-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("团队：一份 README.md 就是全部事实", () => {
	it("团队 slug 是路径的一部分：`.`、`..`、带 / 的一律拒绝", async () => {
		await expect(writeTeam(root, { slug: "..", body: "x" })).rejects.toThrow();
		await expect(writeTeam(root, { slug: "a/b", body: "x" })).rejects.toThrow();
		// 读是尽力而为：坏 slug 只等于「没有这个团队」，不能打挂提示词渲染。
		expect(await readTeam(root, "..")).toBeUndefined();
	});

	it("没有目录时返回 undefined，列表为空", async () => {
		expect(await readTeam(root, "demo")).toBeUndefined();
		expect(await listTeams(root)).toEqual([]);
	});

	it("写进去能读出来，头部字段正确", async () => {
		const written = await writeTeam(root, {
			slug: "demo",
			name: "演示团队",
			lead: "linyue",
			status: "active",
			body: "目标：能跑通。验收：输入 A 得到 B。",
		});
		expect(written.name).toBe("演示团队");
		expect(written.lead).toBe("linyue");
		expect(written.status).toBe("active");

		const read = await readTeam(root, "demo");
		expect(read?.body).toBe("目标：能跑通。验收：输入 A 得到 B。");
	});

	it("重复写只换正文时，name/owner/status 保留", async () => {
		await writeTeam(root, { slug: "demo", name: "演示", lead: "linyue", status: "paused", body: "v1" });
		const second = await writeTeam(root, { slug: "demo", body: "v2" });
		expect(second.name).toBe("演示");
		expect(second.lead).toBe("linyue");
		expect(second.status).toBe("paused");
		expect(second.body).toBe("v2");
	});

	it("doing：写进去能读出来，且只重复写正文时沿用原值", async () => {
		await writeTeam(root, { slug: "demo", doing: "沈舟在改 doing 链路", body: "v1" });
		expect((await readTeam(root, "demo"))?.doing).toBe("沈舟在改 doing 链路");
		const second = await writeTeam(root, { slug: "demo", body: "v2" });
		expect(second.doing).toBe("沈舟在改 doing 链路");
		expect(second.body).toBe("v2");
	});

	it("doing：没写的团队读出来是 undefined，空串也不落盘", async () => {
		await writeTeam(root, { slug: "demo", body: "v1" });
		expect((await readTeam(root, "demo"))?.doing).toBeUndefined();
		await writeTeam(root, { slug: "demo", doing: "", body: "v2" });
		expect((await readTeam(root, "demo"))?.doing).toBeUndefined();
	});

	it("doing：显式传入时覆盖原值（契约只把「不传」当保留）", async () => {
		await writeTeam(root, { slug: "demo", doing: "旧", body: "v1" });
		const second = await writeTeam(root, { slug: "demo", doing: "新", body: "v2" });
		expect(second.doing).toBe("新");
	});

	it("缺 owner 时不编造团队管理员（写「没人负责」是渲染层的事）", async () => {
		const written = await writeTeam(root, { slug: "solo", body: "只有我一个人做" });
		expect(written.lead).toBeUndefined();
		expect(written.name).toBe("solo");
	});

	it("非法 status 回落 active，不炸", async () => {
		const written = await writeTeam(root, { slug: "x", body: "b", status: "什么鬼" as never });
		expect(written.status).toBe("active");
	});

	it("列表按 slug 码点序，保证渲染确定", async () => {
		for (const slug of ["c", "a", "b"]) await writeTeam(root, { slug, body: slug });
		expect((await listTeams(root)).map((team) => team.slug)).toEqual(["a", "b", "c"]);
	});

	it("空 slug 被拒绝", async () => {
		await expect(writeTeam(root, { slug: "  ", body: "x" })).rejects.toThrow();
	});

	it("renderTeamFile 是唯一格式来源：写盘内容与它逐字节相同", async () => {
		const text = renderTeamFile({ name: "A", lead: "b", status: "done", body: "正文" });
		expect(text).toBe("---\nname: A\nlead: b\nstatus: done\n---\n\n正文\n");
	});

	it("membersOfTeam 按 identity 的 team 字段算成员", () => {
		const identities = [
			{ slug: "a", team: "demo" },
			{ slug: "b", team: "other" },
			{ slug: "c" },
			{ slug: "d", team: "demo" },
		];
		expect(membersOfTeam(identities, "demo")).toEqual(["a", "d"]);
	});
});

describe("团队管理员校验：写 README 之前的三条判据", () => {
	const all = { slugs: ["林越", "沈舟", "知言"], assistants: ["知言"] };

	it("缺 lead 直接拒绝，并说清先招人", () => {
		const problem = leadProblem({ lead: undefined, ...all });
		expect(problem).toContain("必须写");
		expect(problem).toContain("先招一个团队管理员");
	});

	it("lead 不在名册里：列出可选 slug", () => {
		const problem = leadProblem({ lead: "查无此人", ...all });
		expect(problem).toContain("不在名册里");
		expect(problem).toContain("林越");
	});

	it("助理不能当团队管理员", () => {
		expect(leadProblem({ lead: "知言", ...all })).toContain("不能当团队管理员");
	});

	it("合法的团队成员照常通过", () => {
		expect(leadProblem({ lead: "林越", ...all })).toBeUndefined();
	});
});
