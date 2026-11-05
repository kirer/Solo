/**
 * 插件清单：`plugins/<slug>/plugin.md` 的 YAML 头 + 目录里有没有那两个入口文件。
 *
 * 为什么是一份 markdown 而不是 `package.json`：Solo 里「一个东西是什么」一直写在文档里
 * （`identity.md` / `README.md` / `SKILL.md`），插件不该是唯一一个要靠 JSON 才看得懂的
 * 文件夹。头只有四个字段，正文是给人看的说明 —— 它会出现在 `/api/plugins`。
 *
 * 入口文件名写死，不在清单里声明：
 * - `plugin.ts` 后端（Node 直接跑类型擦除，和本仓库其它代码同一种语言）；
 * - `client.js` 前端（浏览器原生 ESM，宿主把 React 和插槽注册器递给它）。
 * 没有哪个文件就是「只有另一半」的插件 —— 纯前端 / 纯后端都是合法的。
 */
import { join } from "node:path";
import { parseDoc, readDocFile, writeDocFile, type FrontmatterField } from "../documents/base/doc.ts";
import { existsAt, listDirSorted, readTextOrUndefined, removeDirAt, writeBytesAt } from "../runtime/io.ts";
import { isSafeName } from "../naming.ts";

export const PLUGIN_MANIFEST = "plugin.md";
/** 后端入口：先找 `.ts`，没有再看 `.js`（两者 Node 都直接跑，`.js` 留给不想写类型的人）。 */
export const PLUGIN_SERVERS = ["plugin.ts", "plugin.js"] as const;
export const PLUGIN_SERVER = PLUGIN_SERVERS[0];
export const PLUGIN_CLIENT = "client.js";

/** 一份读懂的清单。`dir` 是绝对路径。 */
export type PluginManifest = {
	readonly slug: string;
	readonly name: string;
	/** 一句话说明。头里没写就用正文第一行。 */
	readonly description: string;
	readonly enabled: boolean;
	/** 后端入口文件名（相对插件目录），没有就是纯前端插件。 */
	readonly server?: string;
	/** 前端入口文件名，没有就是纯后端插件。 */
	readonly client?: string;
	readonly dir: string;
};

/** 读清单的结果：坏清单是**一条错误**，不是异常 —— 一个坏插件不该让服务起不来。 */
export type ManifestRead =
	| { readonly manifest: PluginManifest }
	| { readonly error: string };

/**
 * 列插件目录名。
 *
 * 只认「合法名字的目录」：`plugins/` 里躺一个 `.DS_Store` 或 `说明.txt` 不该被当成插件
 * 报到界面上。名字规则复用 `naming.ts`，不另写一份正则。
 */
export async function listPluginSlugs(pluginsRoot: string): Promise<readonly string[]> {
	const entries = await listDirSorted(pluginsRoot);
	return entries
		.filter((entry) => entry.kind === "dir" && isSafeName(entry.name))
		.map((entry) => entry.name);
}

/**
 * 开关一个插件：只改 `plugin.md` 头里的 `enabled`，正文与其它字段原样留着。
 *
 * 为什么回写文档而不是另存一份状态：插件的开关就该和它的说明躺在同一个文件里，
 * 用编辑器手改和用界面点开关是同一件事（ADR-018 的「语义写在文档里」）。
 *
 * **改的是下一次启动**：这次进程里已经装上的工具 / 路由不会因为关掉而消失。
 */
export async function writePluginEnabled(pluginsRoot: string, slug: string, enabled: boolean): Promise<void> {
	if (!isSafeName(slug)) throw new Error(`插件名不合法：${slug}`);
	const path = join(pluginsRoot, slug, PLUGIN_MANIFEST);
	const doc = await readDocFile(path);
	if (doc === undefined) throw new Error(`插件 ${slug} 缺少 ${PLUGIN_MANIFEST}`);

	// 按原顺序写回：头的字段顺序本身就是可读性，不重排。
	const fields: FrontmatterField[] = Object.entries(doc.front).map(([key, value]) =>
		key === "enabled" ? [key, enabled ? "true" : "false"] : [key, value],
	);
	// 开着的插件头里通常没有这一行（缺省就是开）；点开关之后要有一条能看见的痕迹。
	if (doc.front["enabled"] === undefined) fields.push(["enabled", enabled ? "true" : "false"]);
	await writeDocFile(path, fields, doc.body);
}

/**
 * 装一个插件：把**已经写好的那一个文件夹**原样搬进 `plugins/<slug>/`。
 *
 * 为什么不是「起个名字建空目录」：插件的能力全在它的 `plugin.ts` / `client.js` 里，
 * 没有代码的空壳装进去什么都不做 —— 那不是安装，是占位。安装 = 选一个文件夹，
 * 宿主先校验再落盘（dsh 的 `inspect` → `install` 也是这个顺序，只是它从包管理器拿，
 * 我们从磁盘上拿，见 ADR-018）。
 *
 * 校验三件事，任一不满足就整份不落盘：
 * 1. 名字合法、没有重名（不覆盖别人的插件）；
 * 2. 每个文件的相对路径都在插件目录里面（`../`、绝对路径一律拒绝）；
 * 3. 文件夹根上有 `plugin.md` —— 没有清单的东西不是插件。
 */
export type PluginFile = {
	/** 相对插件目录的路径，用 `/` 分隔。 */
	readonly path: string;
	/** 文件内容（base64）。插件可能有图片之类的二进制文件。 */
	readonly base64: string;
};

/** 相对路径是不是落在插件目录里面。空段、`.`、`..`、反斜杠、绝对路径一律不算。 */
function isInsidePlugin(path: string): boolean {
	if (path === "" || path.startsWith("/") || path.includes("\\")) return false;
	const parts = path.split("/");
	return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

export async function installPluginFiles(
	pluginsRoot: string,
	slug: string,
	files: readonly PluginFile[],
): Promise<void> {
	if (!isSafeName(slug)) throw new Error(`不能用作插件名：${slug}。只能用字母、数字、中文、- 和 _。`);
	const dir = join(pluginsRoot, slug);
	if (await existsAt(dir)) throw new Error(`已经有一个叫「${slug}」的插件了`);
	if (!files.some((file) => file.path === PLUGIN_MANIFEST)) {
		throw new Error(`这个文件夹里没有 ${PLUGIN_MANIFEST}，不是插件`);
	}
	for (const file of files) {
		if (!isInsidePlugin(file.path)) throw new Error(`文件夹里有不安全的路径：${file.path}`);
	}
	for (const file of files) {
		await writeBytesAt(join(dir, ...file.path.split("/")), Buffer.from(file.base64, "base64"));
	}
}

/**
 * 删掉一个插件（整个目录，含它的代码）。
 *
 * 只删 `plugins/<合法名字>/`：名字先过 `isSafeName`，所以 `..` 与嵌套路径都到不了。
 */
export async function removePluginFolder(pluginsRoot: string, slug: string): Promise<void> {
	if (!isSafeName(slug)) throw new Error(`不能用作插件名：${slug}`);
	const dir = join(pluginsRoot, slug);
	if (!(await existsAt(dir))) throw new Error(`没有叫「${slug}」的插件`);
	await removeDirAt(dir);
}

/** 读一个插件目录的清单。目录里没有 `plugin.md` = 一条错误。 */
export async function readPluginManifest(pluginsRoot: string, slug: string): Promise<ManifestRead> {
	const dir = join(pluginsRoot, slug);
	const source = await readTextOrUndefined(join(dir, PLUGIN_MANIFEST));
	if (source === undefined) return { error: `插件 ${slug} 缺少 ${PLUGIN_MANIFEST}` };

	const doc = parseDoc(`${slug}/${PLUGIN_MANIFEST}`, source);
	const server = (await Promise.all(PLUGIN_SERVERS.map((name) => existsAt(join(dir, name))))).findIndex(Boolean);
	const client = await existsAt(join(dir, PLUGIN_CLIENT));
	const firstLine = doc.body.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
	return {
		manifest: {
			slug,
			name: doc.front.name ?? slug,
			description: doc.front.description ?? firstLine,
			// 头里没写 = 开着。关掉要显式写 `enabled: false`。
			enabled: doc.front.enabled !== "false",
			...(server < 0 ? {} : { server: PLUGIN_SERVERS[server] }),
			...(client ? { client: PLUGIN_CLIENT } : {}),
			dir,
		},
	};
}
