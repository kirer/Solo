import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSkills, readSkill, writeSkill } from "../../src/core/agent/skills.ts";

let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "core-skills-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("技能：目录即事实", () => {
	it("没有 skills 目录时是空列表，不报错", async () => {
		expect(await listSkills(root)).toEqual([]);
	});

	it("读两种摆法：目录里的 SKILL.md 与单文件 .md", async () => {
		await mkdir(join(root, "skills", "立项"), { recursive: true });
		await writeFile(
			join(root, "skills", "立项", "SKILL.md"),
			"---\nname: 立项\ndescription: 什么时候该开一个新项目\n---\n\n正文一\n",
			"utf8",
		);
		await writeFile(join(root, "skills", "复盘.md"), "---\ndescription: 做完之后的回看\n---\n\n正文二\n", "utf8");

		const skills = await listSkills(root);
		expect(skills.map((skill) => skill.name)).toEqual(["复盘", "立项"]);
		expect(skills.map((skill) => skill.description)).toEqual(["做完之后的回看", "什么时候该开一个新项目"]);
	});

	it("缺 description 时退回名字，不编造", async () => {
		await writeFile(join(root, "skills", "随手.md"), "没有头部的正文\n", "utf8").catch(async () => {
			await mkdir(join(root, "skills"), { recursive: true });
			await writeFile(join(root, "skills", "随手.md"), "没有头部的正文\n", "utf8");
		});
		const skills = await listSkills(root);
		expect(skills).toHaveLength(1);
		expect(skills[0]?.description).toBe("随手");
	});

	it("排序确定：同组文件两次扫描顺序一致", async () => {
		await mkdir(join(root, "skills"), { recursive: true });
		for (const name of ["c", "a", "b"]) {
			await writeFile(join(root, "skills", `${name}.md`), `---\ndescription: ${name}\n---\n`, "utf8");
		}
		const first = (await listSkills(root)).map((skill) => skill.name);
		const second = (await listSkills(root)).map((skill) => skill.name);
		expect(first).toEqual(["a", "b", "c"]);
		expect(second).toEqual(first);
	});

	it("读正文时剥掉 frontmatter", async () => {
		await writeSkill(root, { name: "招人", description: "怎么招", body: "第一步：想清楚要判断还是要执行。" });
		const skill = await readSkill(root, "招人");
		expect(skill?.body).toBe("第一步：想清楚要判断还是要执行。");
		expect(skill?.description).toBe("怎么招");
	});

	it("读不存在的技能返回 undefined（模型拼错名字不该炸整轮生成）", async () => {
		expect(await readSkill(root, "不存在")).toBeUndefined();
	});

	it("写入后立刻可读，且下一条消息就能看到", async () => {
		const written = await writeSkill(root, { name: "部署", description: "怎么上线", body: "跑 npm run check 再发。" });
		expect(written.name).toBe("部署");
		const listed = await listSkills(root);
		expect(listed.map((skill) => skill.name)).toContain("部署");
	});

	it("技能名里的斜杠会被替换，不能逃出 skills 目录", async () => {
		const written = await writeSkill(root, { name: "../坏", description: "x", body: "y" });
		expect(written.dir.startsWith(join(root, "skills"))).toBe(true);
		expect(written.name.includes("/")).toBe(false);
	});

	it("空的技能名被拒绝", async () => {
		await expect(writeSkill(root, { name: "  ", description: "x", body: "y" })).rejects.toThrow();
	});
});
