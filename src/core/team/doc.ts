/**
 * 一个团队 = `<userRoot>/teams/<slug>/`。
 *
 * 与新核心的其他部分一致：**团队也是文件夹**，`README.md` 是唯一事实来源。
 * 代码只负责两件事 —— 读写这份文件、按它算出「谁在这个团队里」。至于
 * 「什么时候该立一个团队」「团队该有哪些人」「这个团队的边界在哪」，
 * 那些是判断，写在 agent 的技能里（`assistant/<slug>/skills/建立团队/SKILL.md`），
 * 不写在这里。
 *
 * 格式与 `identity.md` 对称：可选的 YAML 头 + 正文。
 *
 * ```markdown
 * ---
 * name: 演示团队
 * status: active
 * ---
 *
 * 目标是 X。验收标准是 Y。不做的是 Z。
 * ```
 */
import { join } from "node:path";
import {
	parseDoc,
	readDocFile,
	renderFrontmatter,
	writeDocFile,
	type Doc,
	type FrontmatterField,
} from "../md/doc.ts";
import { assertName } from "../naming.ts";
import { fill, type TextCatalog } from "../md/catalog.ts";
import { listDirSorted } from "../runtime/io.ts";

export const TEAM_FILE = "README.md";

export type TeamStatus = "active" | "paused" | "done" | "archived";

export type TeamDoc = {
	/** 目录名。 */
	readonly slug: string;
	/** 显示名，缺省用 slug。 */
	readonly name: string;
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
};

const STATUSES: readonly TeamStatus[] = ["active", "paused", "done", "archived"];

/**
 * 正文第一个 `# 标题`。
 *
 * 团队档案没写 `---` 头（早期是手写出来的）时，标题就在这一行 —— 拿它当显示名，
 * 界面上才不会是目录名那样的拼音（实测：`# 俱乐大玩家` 的团队显示成 `juledawanjia`）。
 */
function headingOf(body: string): string | undefined {
	const found = /^#[ \t]+(.+?)[ \t]*$/mu.exec(body);
	return found?.[1]?.trim() || undefined;
}

function teamOf(slug: string, doc: Doc): TeamDoc {
	const header = doc.front;
	const status = STATUSES.find((item) => item === header.status) ?? "active";
	return {
		slug,
		name: header.name ?? headingOf(doc.body) ?? slug,
		...(header.doing === undefined ? {} : { doing: header.doing }),
		status,
		body: doc.body,
	};
}

/** 团队说明在文件里的样子（渲染与写盘共用）。 */
export type TeamFile = {
	readonly name: string;
	readonly doing?: string;
	readonly status?: TeamStatus;
	readonly body: string;
};

function teamFields(doc: TeamFile): readonly FrontmatterField[] {
	// 空串按「没写」处理（`status` 例外：它是枚举，只在缺省时才不写）。
	return [
		["name", doc.name],
		["doing", doc.doing === "" ? undefined : doc.doing],
		["status", doc.status],
	];
}

/** 渲染成文件内容（写盘与测试共用，保证格式只有一份）。 */
export function renderTeamFile(doc: TeamFile): string {
	return renderFrontmatter(teamFields(doc), doc.body);
}

/**
 * 团队 slug 只允许字母、数字、中文、`-`、`_`。
 *
 * 它会被拼成 `teams/<slug>/...`：`..` 能跳出 `teams/`，`a/b` 能指到预期之外。
 * 团队 slug 来自 agent 的自由文本（`remember(scope=team)` 的 `team` 参数），
 * 不能只信调用方 —— 这里是唯一的闸。
 */
export function assertTeamSlug(slug: string, text?: TextCatalog): string {
	return assertName(slug, "team", text);
}

/**
 * `teams/<slug>/README.md` → 团队 slug；别的路径 → `undefined`。
 *
 * 写给 `file` 工具用：团队说明改了，团队频道（成员表是它的投影）必须跟着重算 ——
 * 新建的团队要有频道、改名的要跟着改名、写 `status: archived` 的要把频道归档。
 */
export function teamSlugOfReadmePath(rel: string): string | undefined {
	const parts = rel.split(/[\\/]+/u).filter((part) => part !== "" && part !== ".");
	if (parts.length !== 3) return undefined;
	const [root, slug, file] = parts;
	if (root !== "teams" || file !== TEAM_FILE || slug === undefined) return undefined;
	return slug;
}

/** 团队目录名（与频道 id `team:<slug>` 用的是同一个 slug）。 */
function teamDirOf(teamsRoot: string, slug: string): string {
	return join(teamsRoot, assertTeamSlug(slug));
}

export async function readTeam(teamsRoot: string, slug: string): Promise<TeamDoc | undefined> {
	// 读是「尽力而为」：身份文件里写了 `team: foo/bar` 这样的坏值，只该让这个团队
	// 不存在，不能把整个提示词渲染打挂。写（`writeTeam`）仍然严格拒绝。
	try {
		assertTeamSlug(slug);
	} catch {
		return undefined;
	}
	const doc = await readDocFile(join(teamDirOf(teamsRoot, slug), TEAM_FILE));
	return doc === undefined ? undefined : teamOf(slug, doc);
}

/** 全部团队（按 slug 码点序，保证渲染确定）。 */
export async function listTeams(teamsRoot: string): Promise<readonly TeamDoc[]> {
	const entries = await listDirSorted(teamsRoot);
	const out: TeamDoc[] = [];
	for (const entry of entries) {
		if (entry.kind !== "dir" || entry.name.startsWith(".")) continue;
		const doc = await readTeam(teamsRoot, entry.name);
		if (doc !== undefined) out.push(doc);
	}
	return out;
}

/**
 * 写一份团队说明（整篇替换）。目录不存在就建。
 *
 * **不检查团队里有没有人** —— 那是判断，不是这里该管的事。一个空团队在频道里只有
 * 我和助理，这件事由 agent 自己（看频道成员 / 技能）发现。代码不替它兜。
 */
export async function writeTeam(
	teamsRoot: string,
	input: {
		readonly slug: string;
		readonly name?: string;
		/**
		 * 一句话现状。**不传 = 沿用文件里已有的**：
		 * 大多数写入只改正文，调用方没必要把 `doing` 抄一遍，抄漏了就会把它抹掉。
		 */
		readonly doing?: string;
		readonly status?: TeamStatus;
		readonly body: string;
	},
): Promise<TeamDoc> {
	const slug = input.slug.trim();
	if (slug === "") throw new Error("团队 slug 不能为空");
	const dir = teamDirOf(teamsRoot, slug);
	const existing = await readTeam(teamsRoot, slug);
	const doc = {
		name: input.name ?? existing?.name ?? slug,
		...(input.doing === undefined ? (existing?.doing === undefined ? {} : { doing: existing.doing }) : { doing: input.doing }),
		status: input.status ?? existing?.status ?? "active",
		body: input.body,
	};
	const text = await writeDocFile(join(dir, TEAM_FILE), teamFields(doc), doc.body);
	return teamOf(slug, parseDoc("", text));
}

/**
 * 建团队能不能由这个人做。返回一句能直接回给模型的话；可以建就是 `undefined`。
 *
 * 建团队是助理的职权（技能「建立团队」写在助理自己的技能里）：成员发现需要新团队，
 * 该 @助理，由助理建。写新的团队 README 之前校验 —— 成员自己开一个团队，会同时带出
 * 一个频道、一批被叫醒的人，和一份没人认可的目标。
 */
export function createTeamProblem(input: {
	readonly self: string;
	readonly assistants: readonly string[];
	readonly text?: TextCatalog;
}): string | undefined {
	if (input.assistants.includes(input.self)) return undefined;
	return fill(input.text, "org.team.create.denied", { slug: input.self });
}

/** 团队里的 agent（谁在 `identity.md` 里写了 `team: <slug>`）。 */
export function membersOfTeam(
	identities: readonly { readonly slug: string; readonly team?: string }[],
	slug: string,
): readonly string[] {
	return identities.filter((identity) => identity.team === slug).map((identity) => identity.slug);
}
