/**
 * 组织：一个目录扫出来的东西，加上「新建一个 agent」这一个写动作。
 *
 * 这里没有 `createCompany`、没有 7 个身份枚举、没有 `bootstrapCompany`。公司不是被
 * 创建出来的，是从文件夹里读出来的：`agents/<slug>/identity.md` 有几份，公司就有几个人。
 *
 * 唯一需要写文件的地方是「新建 agent」——所以它只有一处，且写的是同一个格式。
 * 这保证了「读」和「写」永远对称：写出来的东西，`readAllIdentities` 一定读得回。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listAgentSlugs, readIdentity, type Identity, type IdentityHeader } from "../agent/identity.ts";
import { renderFrontmatter } from "./frontmatter.ts";

/** 名字 → slug。中文保留（`林越` → `林越`），空白与其他符号换成 `-`。 */
export function slugify(name: string): string {
	const flat = name
		.trim()
		.replace(/[\s/\\:*?"<>|]+/gu, "-")
		.replace(/-+/gu, "-")
		.replace(/^-|-$/gu, "");
	return flat === "" ? "agent" : flat;
}

/** 拿一个还没被占用的 slug：重名就加 `-2`、`-3`。 */
export async function uniqueSlug(root: string, name: string): Promise<string> {
	const base = slugify(name);
	const taken = new Set(await listAgentSlugs(root));
	if (!taken.has(base)) return base;
	for (let index = 2; index < 1000; index += 1) {
		const candidate = `${base}-${index}`;
		if (!taken.has(candidate)) return candidate;
	}
	throw new Error(`找不到可用名：${base}`);
}

/** 把一份身份写成 `identity.md`。头的字段按固定顺序输出，方便人读、也方便 diff。 */
export function renderIdentityFile(header: IdentityHeader, body: string): string {
	return renderFrontmatter(
		[
			["name", header.name],
			["title", header.title],
			["manager", header.manager],
			["team", header.team],
		],
		body,
	);
}

export type CreateAgentInput = {
	/** `workspace/agents`。 */
	readonly root: string;
	/** 显示名。也用来生成 slug（除非显式给了 slug）。 */
	readonly name: string;
	/** 想指定的 slug。缺省从 name 生成，重名自动加后缀。 */
	readonly slug?: string;
	readonly title?: string;
	/** 上级的 slug。我是 `owner`。 */
	readonly manager?: string;
	readonly team?: string;
	/** 身份正文。空的话写一句占位，让它自己来改。 */
	readonly body?: string;
};

/**
 * 新建一个 agent：建目录、写 `identity.md`，返回读回来的身份。
 *
 * **不建会话、不配模型、不进频道。** 那些是外壳的事（`src/core/shell/`），
 * 而且都可以在之后补 —— 文件先存在，人才存在。
 */
export async function createAgent(input: CreateAgentInput): Promise<Identity> {
	const slug = input.slug ?? (await uniqueSlug(input.root, input.name));
	const dir = join(input.root, slug);
	await mkdir(dir, { recursive: true });
	const header: IdentityHeader = {
		name: input.name,
		...(input.title === undefined ? {} : { title: input.title }),
		...(input.manager === undefined ? {} : { manager: input.manager }),
		...(input.team === undefined ? {} : { team: input.team }),
	};
	const body =
		input.body ??
		`我是 ${input.name}。\n\n（这一段还没写。这是我的身份：我怎么理解自己的职责、我偏好怎么工作、我被交付了什么。\n我可以随时改这里 —— 改完下一条消息就生效。）`;
	await writeFile(join(dir, "identity.md"), renderIdentityFile(header, body), "utf8");
	const identity = await readIdentity(input.root, slug);
	if (identity === undefined) throw new Error(`身份写入后读不回来：${slug}`);
	return identity;
}
