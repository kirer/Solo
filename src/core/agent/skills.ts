/**
 * 技能（skill）= 一份 `SKILL.md`。两级：
 *
 * ```
 * <workspace>/skills/<名字>/SKILL.md             公司层：所有人都看得见
 * <workspace>/agents/<slug>/skills/<名字>/...    个人层：只有他自己看得见
 * ```
 *
 * 个人层**覆盖**公司层：同名时用个人的。这样「全公司统一流程」写公司层，
 * 「我这个人有自己的一套」写个人层，不需要拷贝，也不需要「取消继承」这类开关。
 *
 * 加载策略照搬 Agent Skills 规范（也照搬 pi 的做法）：
 * - `name` + `description` **常驻**提示词，让 agent 知道自己会什么、什么时候该用；
 * - 正文**按需读**（`read_skill` 工具），不占常驻上下文。
 *
 * 这一条对成本很要紧：一个人攒 20 门手艺，常驻的是 20 行描述，不是 20 篇正文。
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 技能子目录名（公司层根目录与个人目录下都用它）。 */
export const SKILLS_DIR = "skills";
/** 便携形式：一个目录一份 `SKILL.md`。 */
export const SKILL_FILE = "SKILL.md";

/** 技能来源。提示词里会标出来 —— 「这是公司教我的」和「这是我自己写的」不是一回事。 */
export type SkillScope = "company" | "personal";

export type Skill = {
	/** 目录名（或单文件时的文件名去掉 `.md`）。稳定标识。 */
	readonly name: string;
	/** 路由描述：说清「做什么」+「什么时候用」。缺省时退回 name。 */
	readonly description: string;
	/** 技能所在目录（正文里写的相对路径以它为准）。 */
	readonly dir: string;
	/** 哪一级的。个人层同名覆盖公司层。 */
	readonly scope: SkillScope;
	/** 个人层且公司层有同名技能 —— 提示词里要标出来「这是你自己改过的版本」。 */
	readonly overrides?: true;
};

export type SkillBody = Skill & {
	/** `SKILL.md` 的正文（frontmatter 之后的部分）。 */
	readonly body: string;
};

/**
 * 解析 frontmatter 里的 `name` / `description`。
 *
 * 只认这两个字段：技能是给模型读的说明书，不需要 schema。`license`、
 * `allowed-tools` 这类字段留着不动（不解析也不丢，读正文时原样给模型看）。
 */
function parseFrontmatter(source: string): Record<string, string> {
	if (!source.startsWith("---")) return {};
	const end = source.indexOf("\n---", 3);
	if (end < 0) return {};
	const out: Record<string, string> = {};
	for (const line of source.slice(3, end).split("\n")) {
		// 支持 `key: value`；不解析多行 YAML（技能描述就该是一句话）。
		const match = /^\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (match === null) continue;
		const key = match[1];
		const raw = match[2];
		if (key === undefined || raw === undefined) continue;
		const value = raw.trim().replace(/^["']|["']$/g, "");
		if (value !== "") out[key] = value;
	}
	return out;
}

/** frontmatter 之后的正文。 */
function stripFrontmatter(source: string): string {
	if (!source.startsWith("---")) return source.trim();
	const end = source.indexOf("\n---", 3);
	if (end < 0) return source.trim();
	return source.slice(end + 4).trim();
}

async function readOrUndefined(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * 扫一个 `skills/` 目录。
 *
 * 支持两种摆法：
 * - `skills/<名字>/SKILL.md`（推荐，能带 scripts/ references/）；
 * - `skills/<名字>.md`（单个文件，省事）。
 *
 * 排序：按名字的码点序。**必须确定**，否则同一组文件每次渲染出的提示词顺序不同，
 * prompt cache 会被白白打穿。
 */
async function scanSkillsDir(skillsRoot: string, scope: SkillScope): Promise<readonly Skill[]> {
	let entries;
	try {
		entries = await readdir(skillsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const found: Skill[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory()) {
			const dir = join(skillsRoot, entry.name);
			const source = await readOrUndefined(join(dir, SKILL_FILE));
			if (source === undefined) continue;
			const header = parseFrontmatter(source);
			found.push({
				name: header.name ?? entry.name,
				description: header.description ?? entry.name,
				dir,
				scope,
			});
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			const source = await readOrUndefined(join(skillsRoot, entry.name));
			if (source === undefined) continue;
			const header = parseFrontmatter(source);
			const bare = entry.name.slice(0, -3);
			found.push({ name: header.name ?? bare, description: header.description ?? bare, dir: skillsRoot, scope });
		}
	}
	return found.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** 技能所在的两级根目录。传一个对象而不是三个字符串，调用点不容易把顺序搞错。 */
export type SkillRoots = {
	/** 工作区根：公司层技能在 `<workspace>/skills/`。 */
	readonly workspace: string;
	/** `<workspace>/agents`：个人层技能在 `<agents>/<slug>/skills/`。 */
	readonly agents: string;
};

/** 一个 agent 能看见的全部技能：公司层打底，个人层同名覆盖。 */
export async function listSkills(roots: SkillRoots, slug: string): Promise<readonly Skill[]> {
	const company = await scanSkillsDir(join(roots.workspace, SKILLS_DIR), "company");
	const personal = await scanSkillsDir(join(roots.agents, slug, SKILLS_DIR), "personal");
	const byName = new Map<string, Skill>();
	const companyNames = new Set(company.map((skill) => skill.name));
	for (const skill of company) byName.set(skill.name, skill);
	// 个人层后写 → 同名覆盖。这是「我这个人跟公司不一样」的唯一机制，没有别的开关。
	for (const skill of personal) {
		byName.set(skill.name, companyNames.has(skill.name) ? { ...skill, overrides: true } : skill);
	}
	return [...byName.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** 只列公司层的技能（给「公司教了什么」用）。 */
export async function listCompanySkills(workspaceRoot: string): Promise<readonly Skill[]> {
	return scanSkillsDir(join(workspaceRoot, SKILLS_DIR), "company");
}

/**
 * 读一份技能的正文。
 *
 * 找不到返回 `undefined`（不抛）：模型调用时拼错一个名字是常事，回一句「没有这门
 * 手艺」比让整轮生成失败有用。
 */
export async function readSkill(roots: SkillRoots, slug: string, name: string): Promise<SkillBody | undefined> {
	const hit = (await listSkills(roots, slug)).find((skill) => skill.name === name);
	if (hit === undefined) return undefined;
	// 单文件形式时 `dir` 是 skills/ 本身，文件名得从 name 反推。
	const source =
		(await readOrUndefined(join(hit.dir, SKILL_FILE))) ?? (await readOrUndefined(join(hit.dir, `${hit.name}.md`)));
	if (source === undefined) return undefined;
	return { ...hit, body: stripFrontmatter(source) };
}

/**
 * 写一份技能（整篇替换）。`skillsRoot` 是**哪一个 `skills/` 目录**：
 * 公司层传 `agentsRoot/skills`，个人层传 `agentsRoot/<slug>/skills`。
 */
export async function writeSkillTo(
	skillsRoot: string,
	input: { readonly name: string; readonly description: string; readonly body: string },
): Promise<Skill> {
	const clean = input.name.trim().replace(/[/\\]/gu, "-");
	if (clean === "" || clean === "." || clean === "..") throw new Error("技能名不能为空");
	const dir = join(skillsRoot, clean);
	await mkdir(dir, { recursive: true });
	const source = `---\nname: ${clean}\ndescription: ${input.description.trim()}\n---\n\n${input.body.trim()}\n`;
	await writeFile(join(dir, SKILL_FILE), source, "utf8");
	return { name: clean, description: input.description.trim(), dir, scope: "personal" };
}

/** 写进某个人的个人层。 */
export async function writeSkill(
	roots: SkillRoots,
	slug: string,
	input: { readonly name: string; readonly description: string; readonly body: string },
): Promise<Skill> {
	const written = await writeSkillTo(join(roots.agents, slug, SKILLS_DIR), input);
	return { ...written, scope: "personal" };
}

/** 写进公司层（所有 agent 立刻看得见）。 */
export async function writeCompanySkill(
	workspaceRoot: string,
	input: { readonly name: string; readonly description: string; readonly body: string },
): Promise<Skill> {
	const written = await writeSkillTo(join(workspaceRoot, SKILLS_DIR), input);
	return { ...written, scope: "company" };
}
