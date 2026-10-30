/**
 * 一个团队 = `workspace/teams/<slug>/`。
 *
 * 与新核心的其他部分一致：**团队也是文件夹**，`README.md` 是唯一事实来源。
 * 代码只负责两件事 —— 读写这份文件、按它算出「谁在这个团队里」。至于
 * 「什么时候该立一个团队」「团队该有哪些人」「团队管理员该管到什么程度」，
 * 那些是判断，写在 agent 的技能里（`agents/<slug>/skills/立项/SKILL.md`），
 * 不写在这里。
 *
 * 格式与 `identity.md` 对称：可选的 YAML 头 + 正文。
 *
 * ```markdown
 * ---
 * name: 演示团队
 * lead: 林越
 * status: active
 * ---
 *
 * 目标是 X。验收标准是 Y。不做的是 Z。
 * ```
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const TEAM_FILE = "README.md";

export type TeamStatus = "active" | "paused" | "done" | "archived";

export type TeamDoc = {
	/** 目录名。 */
	readonly slug: string;
	/** 显示名，缺省用 slug。 */
	readonly name: string;
	/** 团队管理员（agent 的 slug）。缺省 = 没人负责。 */
	readonly lead?: string;
	/**
	 * 一句话现状（「谁在做什么」）。缺省 = 没写。
	 *
	 * 它只给界面用（团队频道顶栏的副标题），不参与任何调度判断 —— 所以是自由文本，
	 * 空串按「没写」处理，免得界面渲染出一段空白。
	 */
	readonly doing?: string;
	readonly status: TeamStatus;
	/** 正文：目标、验收标准、边界、当前进展。 */
	readonly body: string;
	readonly dir: string;
};

const STATUSES: readonly TeamStatus[] = ["active", "paused", "done", "archived"];

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

export function parseTeam(slug: string, dir: string, source: string): TeamDoc {
	const header = parseHeader(source);
	const status = STATUSES.find((item) => item === header.status) ?? "active";
	const lead = header.lead;
	return {
		slug,
		name: header.name ?? slug,
		...(lead === undefined ? {} : { lead }),
		...(header.doing === undefined ? {} : { doing: header.doing }),
		status,
		body: stripFrontmatter(source),
		dir,
	};
}

/** 渲染成文件内容（写盘与测试共用，保证格式只有一份）。 */
export function renderTeamFile(doc: {
	readonly name: string;
	readonly lead?: string;
	readonly doing?: string;
	readonly status?: TeamStatus;
	readonly body: string;
}): string {
	const lines = ["---", `name: ${doc.name}`];
	if (doc.lead !== undefined && doc.lead !== "") lines.push(`lead: ${doc.lead}`);
	if (doc.doing !== undefined && doc.doing !== "") lines.push(`doing: ${doc.doing}`);
	if (doc.status !== undefined) lines.push(`status: ${doc.status}`);
	lines.push("---", "", doc.body.trim());
	return `${lines.join("\n")}\n`;
}

/** 团队目录名（与频道 id `team:<slug>` 用的是同一个 slug）。 */
export function teamDirOf(teamsRoot: string, slug: string): string {
	return join(teamsRoot, slug);
}

export async function readTeam(teamsRoot: string, slug: string): Promise<TeamDoc | undefined> {
	const dir = teamDirOf(teamsRoot, slug);
	try {
		return parseTeam(slug, dir, await readFile(join(dir, TEAM_FILE), "utf8"));
	} catch {
		return undefined;
	}
}

/** 全部团队（按 slug 码点序，保证渲染确定）。 */
export async function listTeams(teamsRoot: string): Promise<readonly TeamDoc[]> {
	let entries;
	try {
		entries = await readdir(teamsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: TeamDoc[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const doc = await readTeam(teamsRoot, entry.name);
		if (doc !== undefined) out.push(doc);
	}
	return out.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
}

/**
 * 写一份团队说明（整篇替换）。目录不存在就建。
 *
 * **不检查团队管理员是不是真的存在** —— 那是判断，不是这里该管的事。写错了人的名字，
 * `renderAgentPrompt` 会原样告诉团队成员「团队管理员是 X」，而 X 不存在这件事，
 * 由 agent 自己 `org` 发现。代码不替它兜。
 */
export async function writeTeam(
	teamsRoot: string,
	input: {
		readonly slug: string;
		readonly name?: string;
		readonly lead?: string;
		/**
		 * 一句话现状。**不传 = 沿用文件里已有的**（与 `lead` 同一口径）：
		 * 大多数写入只改正文，调用方没必要把 `doing` 抄一遍，抄漏了就会把它抹掉。
		 */
		readonly doing?: string;
		readonly status?: TeamStatus;
		readonly body: string;
	},
): Promise<TeamDoc> {
	const slug = input.slug.trim();
	if (slug === "" || slug === "." || slug === "..") throw new Error("团队 slug 不能为空");
	const dir = teamDirOf(teamsRoot, slug);
	await mkdir(dir, { recursive: true });
	const existing = await readTeam(teamsRoot, slug);
	const doc = {
		name: input.name ?? existing?.name ?? slug,
		...(input.lead === undefined ? (existing?.lead === undefined ? {} : { lead: existing.lead }) : { lead: input.lead }),
		...(input.doing === undefined ? (existing?.doing === undefined ? {} : { doing: existing.doing }) : { doing: input.doing }),
		status: input.status ?? existing?.status ?? "active",
		body: input.body,
	};
	await writeFile(join(dir, TEAM_FILE), renderTeamFile(doc), "utf8");
	return parseTeam(slug, dir, renderTeamFile(doc));
}

/** 团队里的 agent（谁在 `identity.md` 里写了 `team: <slug>`）。 */
export function membersOfTeam(
	identities: readonly { readonly slug: string; readonly team?: string }[],
	slug: string,
): readonly string[] {
	return identities.filter((identity) => identity.team === slug).map((identity) => identity.slug);
}
