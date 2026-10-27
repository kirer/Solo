/**
 * 一个 agent 的身份 = `agents/<slug>/identity.md` 这一份文件。
 *
 * 没有数据库、没有枚举、没有 schema 校验。文件里的 YAML 头只提供**结构化的一点点**
 * （名字、岗位标签、上级），正文才是身份。系统不解析正文，只把它放进提示词。
 *
 * 为什么上级写在文件头而不是数据库：`docs/AGENT.md` §6 把「公共事实」定义为
 * 组织架构，而组织架构的唯一权威来源就是这些文件的 `manager` 字段 —— 扫一遍
 * 目录就是组织架构，改了文件就是改了组织架构，不需要第二条真相。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** `identity.md` 的 YAML 头。全部可选 —— 缺什么就渲染成「未设置」。 */
export type IdentityHeader = {
	readonly name?: string;
	/** 岗位标签，纯展示用。不决定能力，不决定层级。 */
	readonly title?: string;
	/** 上级的 slug。老板本人用 `owner`。 */
	readonly manager?: string;
	/** 所在项目 slug；管理层与老板不必填。 */
	readonly project?: string;
};

export type Identity = IdentityHeader & {
	/** 目录名。全局唯一，是 agent 的稳定标识。 */
	readonly slug: string;
	/** 正文：写给人读的身份描述。 */
	readonly body: string;
	readonly dir: string;
};

/** 老板的 slug 常量。它不是 agent，是对话的另一端。 */
export const OWNER_SLUG = "owner";

/** 只取 `---` 之间的行，逐行 `key: value`。不引入 YAML 依赖。 */
function parseHeader(source: string): IdentityHeader {
	if (!source.startsWith("---")) return {};
	const end = source.indexOf("\n---", 3);
	if (end < 0) return {};
	const header: Record<string, string> = {};
	for (const line of source.slice(3, end).split("\n")) {
		const match = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (match === null) continue;
		const key = match[1];
		const raw = match[2];
		if (key === undefined || raw === undefined) continue;
		const value = raw.trim().replace(/^["']|["']$/g, "");
		if (value !== "") header[key] = value;
	}
	return {
		...(header.name === undefined ? {} : { name: header.name }),
		...(header.title === undefined ? {} : { title: header.title }),
		...(header.manager === undefined ? {} : { manager: header.manager }),
		...(header.project === undefined ? {} : { project: header.project }),
	};
}

/** 只取 `---` 之后的正文。 */
function parseBody(source: string): string {
	if (!source.startsWith("---")) return source.trim();
	const end = source.indexOf("\n---", 3);
	if (end < 0) return source.trim();
	return source.slice(end + 4).trim();
}

export function parseIdentity(slug: string, dir: string, source: string): Identity {
	return { slug, dir, ...parseHeader(source), body: parseBody(source) };
}

/** agent 根目录（`workspace/agents`）下的所有子目录。 */
export async function listAgentSlugs(root: string): Promise<readonly string[]> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => entry.name)
		.sort();
}

/** 读一份身份；文件不存在返回 undefined（不是错误 —— 缺席是一种正常状态）。 */
export async function readIdentity(root: string, slug: string): Promise<Identity | undefined> {
	const dir = join(root, slug);
	try {
		const source = await readFile(join(dir, "identity.md"), "utf8");
		return parseIdentity(slug, dir, source);
	} catch {
		return undefined;
	}
}

/** 读全部身份。组织架构就是这份结果。 */
export async function readAllIdentities(root: string): Promise<readonly Identity[]> {
	const slugs = await listAgentSlugs(root);
	const out: Identity[] = [];
	for (const slug of slugs) {
		const identity = await readIdentity(root, slug);
		if (identity !== undefined) out.push(identity);
	}
	return out;
}

/** 某个 agent 的直接下属。 */
export function reportsOf(all: readonly Identity[], slug: string): readonly Identity[] {
	return all.filter((identity) => identity.manager === slug);
}

/**
 * 从某个 agent 往上走到老板的整条链，**不含自己，含老板**。
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

/** 直接上级。老板返回 undefined。断链返回 `undefined` 且 `broken: true`。 */
export function managerOf(all: readonly Identity[], slug: string): string | undefined {
	const manager = all.find((identity) => identity.slug === slug)?.manager;
	return manager === undefined || manager === "" ? undefined : manager;
}
