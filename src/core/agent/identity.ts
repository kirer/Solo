/**
 * 一个 agent 的身份 = `agents/<slug>/identity.md` 这一份文件。
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
} from "../doc.ts";
import { assertName } from "../naming.ts";
import { listDirSorted } from "../runtime/io.ts";

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
): Promise<Identity> {
	// 路径是拼出来的，不能只信调用方：写入口自己过同一道名字闸。
	const safe = assertName(slug, "agent");
	const dir = join(agentsRoot, safe);
	const path = join(dir, IDENTITY_FILE);
	const text = await writeDocFile(path, identityFields(header), body);
	return identityOf(safe, dir, parseDoc(path, text));
}

/** agent 根目录（`workspace/agents`）下的所有子目录。 */
export async function listAgentSlugs(root: string): Promise<readonly string[]> {
	const entries = await listDirSorted(root);
	return entries.filter((entry) => entry.kind === "dir" && !entry.name.startsWith(".")).map((entry) => entry.name);
}

/** 读一份身份；文件不存在返回 undefined（不是错误 —— 缺席是一种正常状态）。 */
export async function readIdentity(root: string, slug: string): Promise<Identity | undefined> {
	const dir = join(root, slug);
	const doc = await readDocFile(join(dir, IDENTITY_FILE));
	return doc === undefined ? undefined : identityOf(slug, dir, doc);
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
