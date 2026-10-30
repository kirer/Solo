/**
 * 组织：一个目录扫出来的东西，加上「新建一个 agent」这一个写动作。
 *
 * 这里没有 `createCompany`、没有 7 个身份枚举、没有 `bootstrapCompany`。公司不是被
 * 创建出来的，是从文件夹里读出来的：`agents/<slug>/identity.md` 有几份，公司就有几个人。
 *
 * 唯一需要写文件的地方是「新建 agent」——所以它只有一处，且写的是同一个格式。
 * 这保证了「读」和「写」永远对称：写出来的东西，`readAllIdentities` 一定读得回。
 */
import { listAgentSlugs, writeIdentity, type Identity, type IdentityHeader } from "./identity.ts";
import { assertName, slugifyName } from "../naming.ts";

/** 名字 → slug。规则只有一份，在 `naming.ts`。 */
export function slugify(name: string): string {
	return slugifyName(name);
}

/** slug 校验。规则只有一份，在 `naming.ts`（`owner` 是保留名）。 */
export function assertSlug(slug: string): string {
	return assertName(slug, "agent");
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
	// 显式传入的 slug 由 `writeIdentity` 过同一道名字闸（路径是拼出来的，不能只信调用方）。
	const slug = input.slug ?? (await uniqueSlug(input.root, input.name));
	const header: IdentityHeader = {
		name: input.name,
		...(input.title === undefined ? {} : { title: input.title }),
		...(input.manager === undefined ? {} : { manager: input.manager }),
		...(input.team === undefined ? {} : { team: input.team }),
	};
	const body =
		input.body ??
		`我是 ${input.name}。\n\n（这一段还没写。这是我的身份：我怎么理解自己的职责、我偏好怎么工作、我被交付了什么。\n我可以随时改这里 —— 改完下一条消息就生效。）`;
	return writeIdentity(input.root, slug, header, body);
}
