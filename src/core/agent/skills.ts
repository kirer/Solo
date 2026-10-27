/**
 * 技能（skill）= `agents/<slug>/skills/<名字>/SKILL.md`。
 *
 * 一个人的身份是「他是谁」，技能是「他会怎么做一件事」。两者分开存放，因为它们
 * 变化频率完全不同：身份几个月改一次，技能天天加。混在一份 `identity.md` 里，
 * 每加一门手艺都要重写整篇身份，而且提示词会越滚越长。
 *
 * 加载策略（照搬 Agent Skills 规范，也照搬了 pi 的做法）：
 * - `name` + `description` **常驻**提示词，让 agent 知道自己会什么、什么时候该用；
 * - 正文**按需读**（`read_skill` 工具），不占常驻上下文。
 *
 * 这一条对成本很要紧：一个 agent 攒 20 门手艺，常驻的只有 20 行描述，而不是 20 篇正文。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 技能根目录（相对某个 agent 的目录）。 */
export const SKILLS_DIR = "skills";
/** 便携形式：一个目录一份 `SKILL.md`。 */
export const SKILL_FILE = "SKILL.md";

export type Skill = {
	/** 目录名（或单文件时的文件名去掉 `.md`）。稳定标识。 */
	readonly name: string;
	/** 路由描述：说清「做什么」+「什么时候用」。缺省时退回 name。 */
	readonly description: string;
	/** 技能目录（正文里写的相对路径以它为准）。 */
	readonly dir: string;
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
 * 扫一个人的全部技能。
 *
 * 支持两种摆法：
 * - `skills/<名字>/SKILL.md`（推荐，能带 scripts/ references/）；
 * - `skills/<名字>.md`（单个文件，省事）。
 *
 * 排序：按名字的码点序。**必须确定**，否则同一组文件每次渲染出的提示词顺序不同，
 * prompt cache 会被白白打穿。
 */
export async function listSkills(agentDir: string): Promise<readonly Skill[]> {
	let entries;
	try {
		entries = await readdir(join(agentDir, SKILLS_DIR), { withFileTypes: true });
	} catch {
		return [];
	}
	const found: Skill[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory()) {
			const dir = join(agentDir, SKILLS_DIR, entry.name);
			const source = await readOrUndefined(join(dir, SKILL_FILE));
			if (source === undefined) continue;
			const header = parseFrontmatter(source);
			found.push({
				name: header.name ?? entry.name,
				description: header.description ?? entry.name,
				dir,
			});
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			const dir = join(agentDir, SKILLS_DIR);
			const source = await readOrUndefined(join(dir, entry.name));
			if (source === undefined) continue;
			const header = parseFrontmatter(source);
			const bare = entry.name.slice(0, -3);
			found.push({ name: header.name ?? bare, description: header.description ?? bare, dir });
		}
	}
	return found.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * 读一份技能的正文。
 *
 * 找不到返回 `undefined`（不抛）：模型调用时拼错一个名字是常事，回一句「没有这门
 * 手艺」比让整轮生成失败有用。
 */
export async function readSkill(agentDir: string, name: string): Promise<SkillBody | undefined> {
	const skills = await listSkills(agentDir);
	const hit = skills.find((skill) => skill.name === name);
	if (hit === undefined) return undefined;
	// 单文件形式时 `dir` 是 skills/ 本身，文件名得从 name 反推。
	const source =
		(await readOrUndefined(join(hit.dir, SKILL_FILE))) ?? (await readOrUndefined(join(hit.dir, `${hit.name}.md`)));
	if (source === undefined) return undefined;
	return { ...hit, body: stripFrontmatter(source) };
}

/**
 * 写一份技能（整篇替换）。`name` 里不能有路径分隔符 —— 技能名是目录名。
 */
export async function writeSkill(
	agentDir: string,
	input: { readonly name: string; readonly description: string; readonly body: string },
): Promise<Skill> {
	const clean = input.name.trim().replace(/[/\\]/gu, "-");
	if (clean === "" || clean === "." || clean === "..") throw new Error("技能名不能为空");
	const dir = join(agentDir, SKILLS_DIR, clean);
	const { mkdir, writeFile } = await import("node:fs/promises");
	await mkdir(dir, { recursive: true });
	const source = `---\nname: ${clean}\ndescription: ${input.description.trim()}\n---\n\n${input.body.trim()}\n`;
	await writeFile(join(dir, SKILL_FILE), source, "utf8");
	return { name: clean, description: input.description.trim(), dir };
}
