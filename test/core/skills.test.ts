import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	listSkills,
	readSkill,
	writeAllSkill,
	writeSkill,
	type SkillRoots,
} from "../../src/core/agent/skills.ts";

/** 工作区根：`agents/` 与 `skills/` 都在它下面。 */
let root = "";
/** 某个 agent 的目录。 */
let agent = "";
/** 两级根目录（全员层 = root/skills，个人层 = root/agents/<slug>/skills）。 */
let roots: SkillRoots;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "core-skills-"));
	agent = join(root, "agents", "me");
	roots = { workspace: root, agents: join(root, "agents") };
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("技能：目录即事实", () => {
	it("没有 skills 目录时是空列表，不报错", async () => {
		expect(await listSkills(roots, "me")).toEqual([]);
	});

	it("读两种摆法：目录里的 SKILL.md 与单文件 .md", async () => {
		await mkdir(join(agent, "skills", "建立团队"), { recursive: true });
		await writeFile(
			join(agent, "skills", "建立团队", "SKILL.md"),
			"---\nname: 建立团队\ndescription: 什么时候该开一个新团队\n---\n\n正文一\n",
			"utf8",
		);
		await writeFile(join(agent, "skills", "复盘.md"), "---\ndescription: 做完之后的回看\n---\n\n正文二\n", "utf8");

		const skills = await listSkills(roots, "me");
		expect(skills.map((skill) => skill.name)).toEqual(["复盘", "建立团队"]);
		expect(skills.map((skill) => skill.description)).toEqual(["做完之后的回看", "什么时候该开一个新团队"]);
	});

	it("缺 description 时退回名字，不编造", async () => {
		await mkdir(join(agent, "skills"), { recursive: true });
		await writeFile(join(agent, "skills", "随手.md"), "没有头部的正文\n", "utf8");
		const skills = await listSkills(roots, "me");
		expect(skills).toHaveLength(1);
		expect(skills[0]?.description).toBe("随手");
	});

	it("排序确定：同组文件两次扫描顺序一致", async () => {
		await mkdir(join(agent, "skills"), { recursive: true });
		for (const name of ["c", "a", "b"]) {
			await writeFile(join(agent, "skills", `${name}.md`), `---\ndescription: ${name}\n---\n`, "utf8");
		}
		const first = (await listSkills(roots, "me")).map((skill) => skill.name);
		const second = (await listSkills(roots, "me")).map((skill) => skill.name);
		expect(first).toEqual(["a", "b", "c"]);
		expect(second).toEqual(first);
	});

	it("读正文时剥掉 frontmatter", async () => {
		await writeSkill(roots, "me", { name: "招人", description: "怎么招", body: "第一步：想清楚要判断还是要执行。" });
		const skill = await readSkill(roots, "me", "招人");
		expect(skill?.body).toBe("第一步：想清楚要判断还是要执行。");
		expect(skill?.description).toBe("怎么招");
	});

	it("读不存在的技能返回 undefined（模型拼错名字不该炸整轮生成）", async () => {
		expect(await readSkill(roots, "me", "不存在")).toBeUndefined();
	});

	it("写入后立刻可读，且下一条消息就能看到", async () => {
		const written = await writeSkill(roots, "me", { name: "部署", description: "怎么上线", body: "跑 npm run check 再发。" });
		expect(written.name).toBe("部署");
		const listed = await listSkills(roots, "me");
		expect(listed.map((skill) => skill.name)).toContain("部署");
	});

	it("技能名里的斜杠会被替换，不能逃出 skills 目录", async () => {
		const written = await writeSkill(roots, "me", { name: "../坏", description: "x", body: "y" });
		expect(written.dir.startsWith(join(agent, "skills"))).toBe(true);
		expect(written.name.includes("/")).toBe(false);
	});

	it("空的技能名被拒绝", async () => {
		await expect(writeSkill(roots, { name: "  ", description: "x", body: "y" })).rejects.toThrow();
	});
});

describe("技能：全员层与个人层", () => {
	it("全员层的技能所有人都看得见", async () => {
		await writeAllSkill(root, { name: "统一流程", description: "全员都这么做", body: "步骤" });
		const mine = await listSkills(roots, "me");
		const other = await listSkills(roots, "someone-else");
		expect(mine.map((skill) => skill.name)).toContain("统一流程");
		expect(other.map((skill) => skill.name)).toContain("统一流程");
		expect(mine.find((skill) => skill.name === "统一流程")?.scope).toBe("all");
	});

	it("个人层同名技能覆盖全员层，而不是两份都列出来", async () => {
		await writeAllSkill(root, { name: "复盘", description: "全员的复盘做法", body: "全员正文" });
		await writeSkill(roots, "me", { name: "复盘", description: "我自己的复盘做法", body: "我的正文" });
		const mine = await listSkills(roots, "me");
		const hit = mine.filter((skill) => skill.name === "复盘");
		expect(hit).toHaveLength(1);
		expect(hit[0]?.scope).toBe("personal");
		expect(await readSkill(roots, "me", "复盘")).toMatchObject({ body: "我的正文" });

		// 别人不受影响，读到的还是全员层。
		expect((await readSkill(roots, "someone-else", "复盘"))?.body).toBe("全员正文");
	});

	it("别人只看得到全员层（不掺某个人的个人技能）", async () => {
		await writeAllSkill(root, { name: "a", description: "全员", body: "x" });
		await writeSkill(roots, "me", { name: "b", description: "个人", body: "y" });
		expect((await listSkills(roots, "someone-else")).map((skill) => skill.name)).toEqual(["a"]);
	});
});

