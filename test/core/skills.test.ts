import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	listCompanySkills,
	listSkills,
	readSkill,
	writeCompanySkill,
	writeSkill,
	type SkillRoots,
} from "../../src/core/agent/skills.ts";
import { adoptSkills } from "../../src/core/channel/tools.ts";

/** 工作区根：`agents/` 与 `skills/` 都在它下面。 */
let root = "";
/** 某个 agent 的目录。 */
let agent = "";
/** 两级根目录（公司层 = root/skills，个人层 = root/agents/<slug>/skills）。 */
let roots: SkillRoots;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "core-skills-"));
	agent = join(root, "agents", "me");
	roots = { workspace: root, agents: join(root, "agents") };
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** 装技能用的临时目录（每个用例一个，用例结束统一删）。 */
const extraRoots: string[] = [];
async function adoptRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "skills-adopt-"));
	extraRoots.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(extraRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("技能：目录即事实", () => {
	it("没有 skills 目录时是空列表，不报错", async () => {
		expect(await listSkills(roots, "me")).toEqual([]);
	});

	it("读两种摆法：目录里的 SKILL.md 与单文件 .md", async () => {
		await mkdir(join(agent, "skills", "立项"), { recursive: true });
		await writeFile(
			join(agent, "skills", "立项", "SKILL.md"),
			"---\nname: 立项\ndescription: 什么时候该开一个新项目\n---\n\n正文一\n",
			"utf8",
		);
		await writeFile(join(agent, "skills", "复盘.md"), "---\ndescription: 做完之后的回看\n---\n\n正文二\n", "utf8");

		const skills = await listSkills(roots, "me");
		expect(skills.map((skill) => skill.name)).toEqual(["复盘", "立项"]);
		expect(skills.map((skill) => skill.description)).toEqual(["做完之后的回看", "什么时候该开一个新项目"]);
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

describe("技能：公司层与个人层", () => {
	it("公司层的技能所有人都看得见", async () => {
		await writeCompanySkill(root, { name: "统一流程", description: "全公司都这么做", body: "步骤" });
		const mine = await listSkills(roots, "me");
		const other = await listSkills(roots, "someone-else");
		expect(mine.map((skill) => skill.name)).toContain("统一流程");
		expect(other.map((skill) => skill.name)).toContain("统一流程");
		expect(mine.find((skill) => skill.name === "统一流程")?.scope).toBe("company");
	});

	it("个人层同名技能覆盖公司层，而不是两份都列出来", async () => {
		await writeCompanySkill(root, { name: "复盘", description: "公司的复盘做法", body: "公司正文" });
		await writeSkill(roots, "me", { name: "复盘", description: "我自己的复盘做法", body: "我的正文" });
		const mine = await listSkills(roots, "me");
		const hit = mine.filter((skill) => skill.name === "复盘");
		expect(hit).toHaveLength(1);
		expect(hit[0]?.scope).toBe("personal");
		expect(await readSkill(roots, "me", "复盘")).toMatchObject({ body: "我的正文" });

		// 别人不受影响，读到的还是公司层。
		expect((await readSkill(roots, "someone-else", "复盘"))?.body).toBe("公司正文");
	});

	it("listCompanySkills 只给公司层（不掺个人技能）", async () => {
		await writeCompanySkill(root, { name: "a", description: "公司", body: "x" });
		await writeSkill(roots, "me", { name: "b", description: "个人", body: "y" });
		expect((await listCompanySkills(root)).map((skill) => skill.name)).toEqual(["a"]);
	});
});

describe("从技能市场装进来的技能", () => {
	it("把 npx 装出来的技能真身拷进公司层，跳过没有 SKILL.md 的目录", async () => {
		const root = await adoptRoot();
		const staging = join(root, "staging");
		const skillsRoot = join(root, "workspace", "skills");

		// `npx skills add` 的真实布局：技能在 `.agents/skills/<名字>/SKILL.md`，
		// 同目录下还有它自己的缓存/脚本目录（那些没有 SKILL.md）。
		await mkdir(join(staging, ".agents", "skills", "skill-creator", "scripts"), { recursive: true });
		await writeFile(
			join(staging, ".agents", "skills", "skill-creator", "SKILL.md"),
			"---\nname: skill-creator\ndescription: 造技能用的\n---\n\n# 正文\n",
			"utf8",
		);
		await writeFile(join(staging, ".agents", "skills", "skill-creator", "scripts", "run.py"), "print(1)", "utf8");
		// 老版本布局：直接放 `skills/`。
		await mkdir(join(staging, "skills", "find-skills"), { recursive: true });
		await writeFile(
			join(staging, "skills", "find-skills", "SKILL.md"),
			"---\nname: find-skills\ndescription: 找技能用的\n---\n\n# 正文\n",
			"utf8",
		);
		// 一个没有 SKILL.md 的目录：不是技能，不该被收。
		await mkdir(join(staging, ".agents", "skills", "cache"), { recursive: true });

		const adopted = await adoptSkills(staging, skillsRoot);
		expect(adopted.sort()).toEqual(["find-skills", "skill-creator"]);

		const skills = await listCompanySkills(join(root, "workspace"));
		expect(skills.map((skill) => skill.name).sort()).toEqual(["find-skills", "skill-creator"]);

		// 连带文件也拷过来了（技能正文里常引用相对路径的脚本）。
		const script = await readFile(join(skillsRoot, "skill-creator", "scripts", "run.py"), "utf8");
		expect(script).toBe("print(1)");
	});

	it("已经是普通文件而不是符号链接", async () => {
		const root = await adoptRoot();
		const staging = join(root, "staging");
		const skillsRoot = join(root, "workspace", "skills");
		await mkdir(join(staging, ".agents", "skills", "pdf"), { recursive: true });
		await writeFile(join(staging, ".agents", "skills", "pdf", "SKILL.md"), "---\nname: pdf\n---\n\n# 正文\n", "utf8");
		await adoptSkills(staging, skillsRoot);

		// 拷完就删临时目录。如果拷进来的是符号链接，这里会断 —— 所以必须是实体文件。
		await rm(staging, { recursive: true, force: true });
		const body = await readSkill({ workspace: join(root, "workspace"), agents: join(root, "agents") }, "owner", "pdf");
		expect(body?.body).toContain("# 正文");
	});

	it("用户改过的同名技能不会被再次安装冲掉", async () => {
		const root = await adoptRoot();
		const staging = join(root, "staging");
		const workspace = join(root, "workspace");
		await mkdir(join(staging, ".agents", "skills", "pdf"), { recursive: true });
		await writeFile(join(staging, ".agents", "skills", "pdf", "SKILL.md"), "---\nname: pdf\n---\n\n# 原版\n", "utf8");
		await adoptSkills(staging, join(workspace, "skills"));

		await writeCompanySkill(workspace, { name: "pdf", description: "改过", body: "# 我改的" });
		await writeFile(join(staging, ".agents", "skills", "pdf", "SKILL.md"), "---\nname: pdf\n---\n\n# 新版\n", "utf8");
		await adoptSkills(staging, join(workspace, "skills"));

		const body = await readSkill({ workspace, agents: join(root, "agents") }, "owner", "pdf");
		expect(body?.body).toContain("我改的");
	});
});
