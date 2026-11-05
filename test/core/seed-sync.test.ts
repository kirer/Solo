/**
 * 全员层技能要能**补进**已有工作区，但不能覆盖用户改过的内容。
 *
 * 审计发现：`seed/skills/工作规矩/SKILL.md` 5766 字节 vs `workspace/skills/工作规矩/SKILL.md`
 * 4729 字节 —— 1037 字节的规则修正从没生效；`seed/skills/记忆整理/` 干脆没被拷过去，而
 * `documents/team/memory.ts` 让 agent `skills(action=read, name="记忆整理")`。所以同步改成每次启动都跑，
 * 用 `.seed-manifest.json` 里记的 hash 分辨「用户改过没有」。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SEED_MANIFEST_FILE, seedRules, syncAllSkills } from "../../src/shell/seed.ts";
import { resolveLayout, type Layout } from "../../src/core/layout.ts";

const SKILL = "记忆整理";
const FILE = "SKILL.md";

function hashOf(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

let root = "";
let layout: Layout;
let target = "";
let manifestPath = "";

/** seed 里这一份技能的当前内容（仓库自带的真身）。 */
async function seedContent(): Promise<string> {
	return readFile(new URL(`../../seed/skills/${SKILL}/${FILE}`, import.meta.url), "utf8");
}

async function writeManifest(skills: Record<string, Record<string, string>>): Promise<void> {
	await writeFile(manifestPath, `${JSON.stringify({ version: 2, skills, plugins: [], files: {} }, null, 2)}\n`, "utf8");
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "core-seed-sync-"));
	// 应用根与用户根合在临时目录里：manifest 与技能都在这个根下，和部署时的相对位置一致。
	layout = resolveLayout({ appRoot: root, userRoot: root });
	target = join(root, "skills", SKILL, FILE);
	manifestPath = join(root, SEED_MANIFEST_FILE);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("全员层技能：按 hash 同步", () => {
	it("工作区没有 → 拷过去，并记账", async () => {
		const report = await syncAllSkills(layout);
		expect(report.copied).toContain(SKILL);
		// 这一份是沉淀链路上的必需品：没它 `skills(action=read, name="记忆整理")` 读不到东西。
		expect(await readFile(target, "utf8")).toBe(await seedContent());

		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
			version: number;
			skills: Record<string, Record<string, string>>;
		};
		expect(manifest.version).toBe(2);
		expect(manifest.skills[SKILL]?.[FILE]).toBe(hashOf(await seedContent()));
	});

	it("工作区内容 = 上次同步的那份（用户没改过）→ 更新到新版", async () => {
		const old = "---\nname: 记忆整理\ndescription: 旧版\n---\n\n旧版正文\n";
		await mkdir(join(root, "skills", SKILL), { recursive: true });
		await writeFile(target, old, "utf8");
		await writeManifest({ [SKILL]: { [FILE]: hashOf(old) } });

		const report = await syncAllSkills(layout);
		expect(report.updated).toContain(SKILL);
		expect(await readFile(target, "utf8")).toBe(await seedContent());
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
			skills: Record<string, Record<string, string>>;
		};
		expect(manifest.skills[SKILL]?.[FILE]).toBe(hashOf(await seedContent()));
	});

	it("用户改过的文件一动不动（hash 对不上就是用户的）", async () => {
		const mine = "---\nname: 记忆整理\ndescription: 我自己那套\n---\n\n我自己的正文\n";
		await mkdir(join(root, "skills", SKILL), { recursive: true });
		await writeFile(target, mine, "utf8");
		// 账本记的是「上次同步给它的那份」，和现在的内容不一样 = 用户动过。
		await writeManifest({ [SKILL]: { [FILE]: hashOf("上次同步的那份") } });

		const report = await syncAllSkills(layout);
		expect(report.kept).toContain(SKILL);
		expect(report.updated).not.toContain(SKILL);
		expect(await readFile(target, "utf8")).toBe(mine);
	});

	it("幂等：第二次跑不写文件", async () => {
		await syncAllSkills(layout);
		await new Promise((resolve) => setTimeout(resolve, 15));
		const before = (await stat(target)).mtimeMs;
		const manifestBefore = (await stat(manifestPath)).mtimeMs;

		const second = await syncAllSkills(layout);
		expect(second.copied).toEqual([]);
		expect(second.updated).toEqual([]);
		expect((await stat(target)).mtimeMs).toBe(before);
		expect((await stat(manifestPath)).mtimeMs).toBe(manifestBefore);
	});

	it("老工作区（没有账本）里已经一模一样的文件 → 只补账本，不报「用户改过」", async () => {
		await mkdir(join(root, "skills", SKILL), { recursive: true });
		await writeFile(target, await seedContent(), "utf8");

		const report = await syncAllSkills(layout);
		expect(report.kept).toEqual([]);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
			skills: Record<string, Record<string, string>>;
		};
		expect(manifest.skills[SKILL]?.[FILE]).toBe(hashOf(await seedContent()));
	});
});

describe("规矩文件：同一套 hash 判据", () => {
	it("工作区没有 rules.md → 写入；已有（用户改过）→ 不动", async () => {
		expect(await seedRules(layout)).toBe("written");
		const written = await readFile(join(root, "rules.md"), "utf8");
		expect(written).toContain("一两句");
		expect(await seedRules(layout)).toBe("exists");

		const mine = "- 我自己的规矩\n";
		await writeFile(join(root, "rules.md"), mine, "utf8");
		expect(await seedRules(layout)).toBe("exists");
		expect(await readFile(join(root, "rules.md"), "utf8")).toBe(mine);
	});

	it("没改过的老规矩 → 升到新版（出厂修正能进已在跑的工作区）", async () => {
		const old = "- 旧规矩\n";
		await writeFile(join(root, "rules.md"), old, "utf8");
		await writeFile(
			manifestPath,
			`${JSON.stringify({ version: 2, skills: {}, plugins: [], files: { "rules.md": hashOf(old) } }, null, 2)}\n`,
			"utf8",
		);
		expect(await seedRules(layout)).toBe("updated");
		const seed = await readFile(new URL("../../seed/rules.md", import.meta.url), "utf8");
		expect(await readFile(join(root, "rules.md"), "utf8")).toBe(seed);
	});

	it("账本坏了：改名留证，不当成「都没改过」硬覆盖", async () => {
		await writeFile(join(root, "rules.md"), "- 我的规矩\n", "utf8");
		await writeFile(manifestPath, "{ 坏掉的 JSON", "utf8");
		expect(await seedRules(layout)).toBe("exists");
		expect(await readFile(join(root, "rules.md"), "utf8")).toBe("- 我的规矩\n");
	});
});
