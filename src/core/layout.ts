/**
 * 两个根：应用私有目录与用户目录。
 *
 * 为什么要拆：应用自带的东西（助理、提示词、内置插件、配置、数据库、上传）属于**这份安装**，
 * 升级时该跟着换；我的组织（成员、团队、技能、规矩）属于**我**，换机器也要带走。混在一个
 * `workspace/` 里，两者就只能一起备份、一起丢。
 *
 * 日志是个例外，放在**用户根**（`<userRoot>/logs/`）：排查问题时它要和组织数据在一起 ——
 * 一次崩溃、一份审计、一条后台命令的收尾，脱离「当时组织里发生了什么」就没什么用。
 * 它只是追加写的小文件，跟着用户根走不会成为负担（ADR-041）。
 *
 * 这是**唯一**拼这套路径的地方。以前 `dirname(agentsRoot)` 这种隐式约定散在十二个文件里，
 * 漏一处就是静默降级（没有提示词、没有插件），没有任何一处会报错。
 *
 * 不 import 任何东西，只拿 `node:path` 拼字符串 —— 它和 `fsx.ts` / `naming.ts` 一样是原语。
 */
import { basename, isAbsolute, join, relative, resolve } from "node:path";

/** 应用私有目录下的固定名字。 */
export const ASSISTANT_DIR = "assistant";
/** 用户目录下的固定名字。成员曾经叫 `agents`，现在叫 `members`。 */
export const MEMBERS_DIR = "members";
export const TEAMS_DIR = "teams";
export const SKILLS_DIR = "skills";
/** 每个成员 / 团队自己干活的地方，名字叫 `workspace`。 */
export const WORKSPACE_DIR = "workspace";

/** 两个根派生出来的全部位置。字段都是绝对路径。 */
export type Layout = {
	/** 应用私有根：助理、提示词、内置插件、配置、数据库、上传、日志。 */
	readonly appRoot: string;
	/** 用户根：成员、团队、全员技能、规矩。 */
	readonly userRoot: string;
	/** 助理（出厂那个人）的身份目录，`appRoot/assistant/<slug>`。 */
	readonly assistantRoot: string;
	readonly membersRoot: string;
	readonly teamsRoot: string;
	readonly skillsRoot: string;
	readonly rulesFile: string;
	readonly promptRoot: string;
	/** 模型看得见的文案（工具描述、拒绝话术、投递头）：`appRoot/text/`。 */
	readonly textRoot: string;
	readonly pluginsRoot: string;
	readonly settingsFile: string;
	readonly databasePath: string;
	readonly uploadsRoot: string;
	/** 日志跟着用户根走（`<userRoot>/logs/`）：排查要和组织数据在一起（ADR-041）。 */
	readonly logsRoot: string;
	readonly secretsFile: string;
	readonly seedManifestFile: string;
	/** 扫人时按这个顺序：助理在前，成员在后。 */
	readonly agentRoots: readonly [string, string];
};

/** 把一个根拆成全部位置。`appRoot` 与 `userRoot` 允许相同（测试和单机部署都这么用）。 */
export function resolveLayout(input: { readonly appRoot: string; readonly userRoot: string }): Layout {
	const appRoot = resolve(input.appRoot);
	const userRoot = resolve(input.userRoot);
	const assistantRoot = join(appRoot, ASSISTANT_DIR);
	const membersRoot = join(userRoot, MEMBERS_DIR);
	return {
		appRoot,
		userRoot,
		assistantRoot,
		membersRoot,
		teamsRoot: join(userRoot, TEAMS_DIR),
		skillsRoot: join(userRoot, SKILLS_DIR),
		rulesFile: join(userRoot, "rules.md"),
		promptRoot: join(appRoot, "prompt"),
		textRoot: join(appRoot, "text"),
		pluginsRoot: join(appRoot, "plugins"),
		settingsFile: join(appRoot, "settings.json"),
		databasePath: join(appRoot, "core.sqlite"),
		uploadsRoot: join(appRoot, "uploads"),
		logsRoot: join(userRoot, "logs"),
		secretsFile: join(appRoot, ".secrets.json"),
		seedManifestFile: join(appRoot, ".seed-manifest.json"),
		agentRoots: [assistantRoot, membersRoot],
	};
}

/**
 * 身份目录相对两个根的写法（`assistant/<slug>/` 或 `members/<slug>/`）。
 *
 * 提示词里要告诉这个人「你的目录在哪」。写死 `members/` 对助理就是错的 —— 它在应用
 * 私有根里。判断只在这里，别处不要自己拼。
 */
export function agentDirLabel(layout: Layout, identityDir: string): string {
	return `${isAssistantDir(layout, identityDir) ? ASSISTANT_DIR : MEMBERS_DIR}/${basename(identityDir)}/`;
}

/**
 * 这个身份目录是不是助理（应用私有根下）。谁是助理只由这一处判断。
 *
 * 用 `relative` 按路径分量判断：Windows 的分隔符是 `\`，写死 `/` 会让助理在 Windows
 * 上「消失」—— 团队频道里没有助理、没人被 @ 时也醒不来。
 */
export function isAssistantDir(layout: Layout, identityDir: string): boolean {
	const rel = relative(layout.assistantRoot, identityDir);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 一个人的工作目录：他的身份目录下的 `workspace/`。 */
export function workspaceOf(identityDir: string): string {
	return join(identityDir, WORKSPACE_DIR);
}

/** 一个团队成员的工作目录。 */
export function memberWorkspace(layout: Layout, slug: string): string {
	return join(layout.membersRoot, slug, WORKSPACE_DIR);
}

/** 一个团队的工作目录。 */
export function teamWorkspace(layout: Layout, slug: string): string {
	return join(layout.teamsRoot, slug, WORKSPACE_DIR);
}
