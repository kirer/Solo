/**
 * 一个 agent 的身份 = `members/<slug>/identity.md` 这一份文件。
 *
 * 没有数据库、没有枚举、没有 schema 校验。文件里的 YAML 头只提供**结构化的一点点**
 * （名字、身份标签、上级），正文才是身份。系统不解析正文，只把它放进提示词。
 *
 * 为什么上级写在文件头而不是数据库：`docs/AGENT.md` §6 把「公共事实」定义为
 * 组织架构，而组织架构的唯一权威来源就是这些文件的 `manager` 字段 —— 扫一遍
 * 目录就是组织架构，改了文件就是改了组织架构，不需要第二条真相。
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
import { assertName, slugifyName } from "../naming.ts";
import { fill, type TextCatalog } from "../md/catalog.ts";
import { ensureDir, existsAt, listDirSorted } from "../runtime/io.ts";
import { workspaceOf } from "../layout.ts";

/** 一个人的身份文件。读写都经 `doc.ts`，格式只有一份。 */
export const IDENTITY_FILE = "identity.md";

/** `identity.md` 的 YAML 头。全部可选 —— 缺什么就渲染成「未设置」。 */
export type IdentityHeader = {
	readonly name?: string;
	/** 身份标签，纯展示用。不决定能力，不决定层级。 */
	readonly title?: string;
	/** 上级的 slug。我本人用 `owner`。 */
	readonly manager?: string;
	/** 所在团队 slug；管理层与我不必填。 */
	readonly team?: string;
};

export type Identity = IdentityHeader & {
	/** 目录名。全局唯一，是 agent 的稳定标识。 */
	readonly slug: string;
	/** 正文：写给人读的身份描述。 */
	readonly body: string;
	readonly dir: string;
};

/** 我的 slug 常量。它不是 agent，是对话的另一端。 */
export const OWNER_SLUG = "owner";

/** 头 → 身份头。只留认得的那几个字段；其余字段照旧留在文件里，不解析也不丢。 */
function headerOf(front: Readonly<Record<string, string>>): IdentityHeader {
	return {
		...(front.name === undefined ? {} : { name: front.name }),
		...(front.title === undefined ? {} : { title: front.title }),
		...(front.manager === undefined ? {} : { manager: front.manager }),
		// 迁移窗口：老工作区还写着 `project:`，改名后仍认它（`scripts/rename-teams.ts` 会改写）。
		...(front.team === undefined
			? front.project === undefined
				? {}
				: { team: front.project }
			: { team: front.team }),
	};
}

/** 身份头 → 文件里的字段（顺序就是人读到的顺序）。 */
export function identityFields(header: IdentityHeader): readonly FrontmatterField[] {
	return [
		["name", header.name],
		["title", header.title],
		["manager", header.manager],
		["team", header.team],
	];
}

function identityOf(slug: string, dir: string, doc: Doc): Identity {
	return { slug, dir, ...headerOf(doc.front), body: doc.body };
}

export function parseIdentity(slug: string, dir: string, source: string): Identity {
	return identityOf(slug, dir, parseDoc("", source));
}

/** 渲染一份身份文件（写盘与测试共用，保证格式只有一份）。 */
export function renderIdentityFile(header: IdentityHeader, body: string): string {
	return renderFrontmatter(identityFields(header), body);
}

/**
 * 写一份身份。读与写在同一处：`createAgent` 与将来的编辑入口都只调它。
 *
 * 返回**写下去的内容**解析出的身份（不再「写完重读一遍」—— 同一份正文解析两次，
 * 多出来的那次只会制造不一致的机会）。
 */
export async function writeIdentity(
	agentsRoot: string,
	slug: string,
	header: IdentityHeader,
	body: string,
	text?: TextCatalog,
): Promise<Identity> {
	// 路径是拼出来的，不能只信调用方：写入口自己过同一道名字闸。
	const safe = assertName(slug, "agent", text);
	const dir = join(agentsRoot, safe);
	const path = join(dir, IDENTITY_FILE);
	const written = await writeDocFile(path, identityFields(header), body);
	return identityOf(safe, dir, parseDoc(path, written));
}

/**
 * 人的根目录：可以是一个，也可以是几个（助理在 app 根、成员在用户根）。
 * 顺序就是优先级 —— 同一个 slug 出现在两个根里时，前面的那份说了算。
 */
export type AgentRoots = string | readonly string[];

function rootList(roots: AgentRoots): readonly string[] {
	return typeof roots === "string" ? [roots] : roots;
}

/** 所有根下的子目录，slug 去重（先出现的根优先）。 */
export async function listAgentSlugs(roots: AgentRoots): Promise<readonly string[]> {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const root of rootList(roots)) {
		for (const entry of await listDirSorted(root)) {
			if (entry.kind !== "dir" || entry.name.startsWith(".") || seen.has(entry.name)) continue;
			seen.add(entry.name);
			out.push(entry.name);
		}
	}
	return out;
}

/** 读一份身份；文件不存在返回 undefined（不是错误 —— 缺席是一种正常状态）。 */
export async function readIdentity(roots: AgentRoots, slug: string): Promise<Identity | undefined> {
	for (const root of rootList(roots)) {
		const dir = join(root, slug);
		const doc = await readDocFile(join(dir, IDENTITY_FILE));
		if (doc !== undefined) return identityOf(slug, dir, doc);
	}
	return undefined;
}

/**
 * 这个人的目录：有身份就按身份所在根；还没有身份文件时，看哪个根里已经有这个文件夹
 * （技能、记忆这类东西可能在身份写好之前就存在）。都没有就是 `undefined`。
 */
export async function agentDirOf(roots: AgentRoots, slug: string): Promise<string | undefined> {
	const identity = await readIdentity(roots, slug);
	if (identity !== undefined) return identity.dir;
	for (const root of rootList(roots)) {
		const dir = join(root, slug);
		if (await existsAt(dir)) return dir;
	}
	return undefined;
}

/** 拿一个还没被占用的 slug：重名就加 `-2`、`-3`。 */
export async function uniqueSlug(roots: AgentRoots, name: string, text?: TextCatalog): Promise<string> {
	const base = slugifyName(name);
	const taken = new Set(await listAgentSlugs(roots));
	if (!taken.has(base)) return base;
	for (let index = 2; index < 1000; index += 1) {
		const candidate = `${base}-${index}`;
		if (!taken.has(candidate)) return candidate;
	}
	const message = fill(text, "org.name.exhausted", { base });
	throw new Error(message === "" ? `no free name: ${base}` : message);
}

export type CreateAgentInput = {
	/** 用户根下的 `members`（与助理所在的 `assistant` 一起构成两个扫描根）。 */
	readonly root: string;
	/** 显示名。也用来生成 slug（除非显式给了 slug）。 */
	readonly name: string;
	/** 想指定的 slug。缺省从 name 生成，重名自动加后缀。 */
	readonly slug?: string;
	readonly title?: string;
	/** 上级的 slug。我是 `owner`。 */
	readonly manager?: string;
	readonly team?: string;
	/** 身份正文。空的话提示词里那一段整段消失。 */
	readonly body?: string;
	/** 文案目录：名字校验失败时要回一句人话给模型。缺省 = 机械的英文兜底。 */
	readonly text?: TextCatalog;
};

/**
 * 新建一个 agent：建目录、写 `identity.md`，返回读回来的身份。
 *
 * **不建会话、不配模型、不进频道。** 那些是外壳的事（`src/shell/`），
 * 而且都可以在之后补 —— 文件先存在，人才存在。
 */
export async function createAgent(input: CreateAgentInput): Promise<Identity> {
	// 显式传入的 slug 由 `writeIdentity` 过同一道名字闸（路径是拼出来的，不能只信调用方）。
	const slug = input.slug ?? (await uniqueSlug(input.root, input.name, input.text));
	const header: IdentityHeader = {
		name: input.name,
		...(input.title === undefined ? {} : { title: input.title }),
		...(input.manager === undefined ? {} : { manager: input.manager }),
		...(input.team === undefined ? {} : { team: input.team }),
	};
	// 没写正文就写空正文：提示词里那一段由 `05-body.md` 的 `skip-empty` 整段吞掉，
	// 不在代码里编一段「我是谁」——身份正文归那个人自己（或招他的人）写。
	const identity = await writeIdentity(input.root, slug, header, input.body ?? "", input.text);
	// 每人一个自己的工作目录：`run` 不写 cwd 时就在这儿跑（提示词里也是这么说的）。
	await ensureDir(workspaceOf(identity.dir));
	return identity;
}

/** 读全部身份。组织架构就是这份结果。 */
export async function readAllIdentities(roots: AgentRoots): Promise<readonly Identity[]> {
	const slugs = await listAgentSlugs(roots);
	const out: Identity[] = [];
	for (const slug of slugs) {
		const identity = await readIdentity(roots, slug);
		if (identity !== undefined) out.push(identity);
	}
	return out;
}

/** 名册里的显示名。我是「我」，其余用 `name`，没有就用 slug。 */
export function nameOf(
	all: readonly { readonly slug: string; readonly name?: string }[],
	slug: string,
): string {
	if (slug === OWNER_SLUG) return "我";
	return all.find((identity) => identity.slug === slug)?.name ?? slug;
}

/** slug → 显示名的投影。名册落盘时用；真相仍是每个 `identity.md` 的 `name`。 */
export function labelsOf(
	all: readonly { readonly slug: string; readonly name?: string }[],
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const identity of all) out[identity.slug] = identity.name ?? identity.slug;
	return out;
}

/** 某个 agent 的直接下属。 */
export function reportsOf(all: readonly Identity[], slug: string): readonly Identity[] {
	return all.filter((identity) => identity.manager === slug);
}

/**
 * 从某个 agent 往上走到我的整条链，**不含自己，含我**。
 *
 * 用来渲染「你的汇报线」，也用来做「逐级上报」的工具校验。断链（`manager`
 * 指向一个不存在的 slug）时就地停止 —— 渲染出一半的链比报错有用。
 */
export function chainUp(all: readonly Identity[], slug: string): readonly string[] {
	const bySlug = new Map(all.map((identity) => [identity.slug, identity]));
	const chain: string[] = [];
	const seen = new Set<string>([slug]);
	let current = bySlug.get(slug)?.manager;
	while (current !== undefined && !seen.has(current)) {
		chain.push(current);
		seen.add(current);
		if (current === OWNER_SLUG) break;
		current = bySlug.get(current)?.manager;
	}
	return chain;
}

/** 直接上级。我返回 undefined。断链返回 `undefined` 且 `broken: true`。 */
export function managerOf(all: readonly Identity[], slug: string): string | undefined {
	const manager = all.find((identity) => identity.slug === slug)?.manager;
	return manager === undefined || manager === "" ? undefined : manager;
}
