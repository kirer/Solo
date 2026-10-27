/**
 * 一个项目 = `workspace/projects/<slug>/`。
 *
 * 与新核心的其他部分一致：**项目也是文件夹**，`README.md` 是唯一事实来源。
 * 代码只负责两件事 —— 读写这份文件、按它算出「谁在这个项目里」。至于
 * 「什么时候该立一个项目」「项目该有哪些人」「负责人该管到什么程度」，
 * 那些是判断，写在 agent 的技能里（`agents/<slug>/skills/立项/SKILL.md`），
 * 不写在这里。
 *
 * 格式与 `identity.md` 对称：可选的 YAML 头 + 正文。
 *
 * ```markdown
 * ---
 * name: 演示项目
 * owner: 林越
 * status: active
 * ---
 *
 * 目标是 X。验收标准是 Y。不做的是 Z。
 * ```
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PROJECT_FILE = "README.md";

export type ProjectStatus = "active" | "paused" | "done" | "archived";

export type ProjectDoc = {
	/** 目录名。 */
	readonly slug: string;
	/** 显示名，缺省用 slug。 */
	readonly name: string;
	/** 负责人（agent 的 slug）。缺省 = 没人负责。 */
	readonly owner?: string;
	readonly status: ProjectStatus;
	/** 正文：目标、验收标准、边界、当前进展。 */
	readonly body: string;
	readonly dir: string;
};

const STATUSES: readonly ProjectStatus[] = ["active", "paused", "done", "archived"];

function parseHeader(source: string): Record<string, string> {
	if (!source.startsWith("---")) return {};
	const end = source.indexOf("\n---", 3);
	if (end < 0) return {};
	const out: Record<string, string> = {};
	for (const line of source.slice(3, end).split("\n")) {
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

function stripFrontmatter(source: string): string {
	if (!source.startsWith("---")) return source.trim();
	const end = source.indexOf("\n---", 3);
	if (end < 0) return source.trim();
	return source.slice(end + 4).trim();
}

export function parseProject(slug: string, dir: string, source: string): ProjectDoc {
	const header = parseHeader(source);
	const status = STATUSES.find((item) => item === header.status) ?? "active";
	return {
		slug,
		name: header.name ?? slug,
		...(header.owner === undefined ? {} : { owner: header.owner }),
		status,
		body: stripFrontmatter(source),
		dir,
	};
}

/** 渲染成文件内容（写盘与测试共用，保证格式只有一份）。 */
export function renderProjectFile(doc: {
	readonly name: string;
	readonly owner?: string;
	readonly status?: ProjectStatus;
	readonly body: string;
}): string {
	const lines = ["---", `name: ${doc.name}`];
	if (doc.owner !== undefined && doc.owner !== "") lines.push(`owner: ${doc.owner}`);
	if (doc.status !== undefined) lines.push(`status: ${doc.status}`);
	lines.push("---", "", doc.body.trim());
	return `${lines.join("\n")}\n`;
}

/** 项目目录名（与频道 id `proj:<slug>` 用的是同一个 slug）。 */
export function projectDirOf(projectsRoot: string, slug: string): string {
	return join(projectsRoot, slug);
}

export async function readProject(projectsRoot: string, slug: string): Promise<ProjectDoc | undefined> {
	const dir = projectDirOf(projectsRoot, slug);
	try {
		return parseProject(slug, dir, await readFile(join(dir, PROJECT_FILE), "utf8"));
	} catch {
		return undefined;
	}
}

/** 全部项目（按 slug 码点序，保证渲染确定）。 */
export async function listProjects(projectsRoot: string): Promise<readonly ProjectDoc[]> {
	let entries;
	try {
		entries = await readdir(projectsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: ProjectDoc[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const doc = await readProject(projectsRoot, entry.name);
		if (doc !== undefined) out.push(doc);
	}
	return out.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
}

/**
 * 写一份项目说明（整篇替换）。目录不存在就建。
 *
 * **不检查负责人是不是真的存在** —— 那是判断，不是这里该管的事。写错了人的名字，
 * `renderAgentPrompt` 会原样告诉项目成员「负责人是 X」，而 X 不存在这件事，
 * 由 agent 自己 `org_chart` 发现。代码不替它兜。
 */
export async function writeProject(
	projectsRoot: string,
	input: {
		readonly slug: string;
		readonly name?: string;
		readonly owner?: string;
		readonly status?: ProjectStatus;
		readonly body: string;
	},
): Promise<ProjectDoc> {
	const slug = input.slug.trim();
	if (slug === "" || slug === "." || slug === "..") throw new Error("项目 slug 不能为空");
	const dir = projectDirOf(projectsRoot, slug);
	await mkdir(dir, { recursive: true });
	const existing = await readProject(projectsRoot, slug);
	const doc = {
		name: input.name ?? existing?.name ?? slug,
		...(input.owner === undefined ? (existing?.owner === undefined ? {} : { owner: existing.owner }) : { owner: input.owner }),
		status: input.status ?? existing?.status ?? "active",
		body: input.body,
	};
	await writeFile(join(dir, PROJECT_FILE), renderProjectFile(doc), "utf8");
	return parseProject(slug, dir, renderProjectFile(doc));
}

/** 项目里的 agent（谁在 `identity.md` 里写了 `project: <slug>`）。 */
export function membersOfProject(
	identities: readonly { readonly slug: string; readonly project?: string }[],
	slug: string,
): readonly string[] {
	return identities.filter((identity) => identity.project === slug).map((identity) => identity.slug);
}
