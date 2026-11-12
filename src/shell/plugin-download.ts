/**
 * 首次联网下载出厂插件（`Token统计`、`模型管理`）。
 *
 * 为什么不在 seed 里：这两个插件合计 76 KB，占着 `seed/` 的体积上限（528384 字节），
 * 而它们不是「没有就开不了机」的东西。挪到线上让新装的机器按需取，`seed/` 就能回落到 512 KB 以下。
 *
 * 三条底线（Solo 2026-11-12 拍）：
 * 1. **老用户盘上有就一个字节不动、也不发请求** —— 判据只有一条：`<pluginsRoot>/<名字>/` 在就跳过，
 *    连清单都不取。用户手改过的（ADR-097）因此根本走不到这里。
 * 2. **清单必须带签名**，复用更新那条链路（`src/core/signing.ts` + 同一把发布公钥），
 *    但清单文件是**独立的一份** `plugins.json`，不和 `latest-mac.json` 混。
 * 3. **下载的文件按 sha256 校**（任务卡要求，更新清单那边是 sha512），对不上就不落盘。
 *
 * 下载源只能由环境变量 `SOLO_PLUGIN_FEED` 覆盖（默认线上），**不做命令行参数、不做配置项**：
 * 那个口子等于给用户开「装任意插件」的后门，只有调试和验收用。
 */
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import type { Layout } from "../core/layout.ts";
import { existsAt, writeTextAt } from "../core/runtime/io.ts";
import { verifySignature } from "../core/signing.ts";
import { UPDATE_PUBLIC_KEY } from "../core/update-key.ts";
import { hashOf, readManifest, writeManifest } from "./seed.ts";

/** 线上默认下载源。改这个等于改「插件从哪儿来」，别随手动。 */
export const DEFAULT_PLUGIN_FEED = "https://github.com/kirer/Solo/releases/latest/download/";

/** 签名清单的文件名（旁边那份是 `<这个名字>.sig`）。**和 `latest-mac.json` 是两份东西。** */
export const PLUGIN_MANIFEST_ASSET = "plugins.json";

/**
 * 改成「首次联网下载」的出厂插件名（就是插件目录名）。
 *
 * 写死在代码里而不是 spread 一份文件：这样 `seed/` 一个字节都不用留，
 * 离线时界面也知道该显示哪两个「没装上」。
 */
export const REMOTE_PLUGINS = ["Token统计", "模型管理"] as const;

export type RemotePluginName = (typeof REMOTE_PLUGINS)[number];

export type RemotePluginState = "installed" | "missing" | "downloading" | "failed";

/** 界面上「没装上」那一段要用的一条：名字 + 现在什么状态 + 一句能给人看的话。 */
export type RemotePluginStatus = {
	readonly name: string;
	readonly state: RemotePluginState;
	readonly message?: string;
};

/** 清单里一条：一个插件对应线上一个**纯文本** bundle。 */
type ManifestEntry = {
	readonly name: string;
	readonly version: string;
	readonly file: string;
	readonly sha256: string;
	readonly size: number;
};

/** 这个进程里两个插件的下载状态（只在内存里：重启会按磁盘重算，不需要持久化）。 */
const progress = new Map<string, { state: RemotePluginState; message?: string }>();

export function isRemotePlugin(name: string): name is RemotePluginName {
	return (REMOTE_PLUGINS as readonly string[]).includes(name);
}

/** 下载源：环境变量优先，兜底线上。末尾补一个 `/`，拼资产名时不用每处都判。 */
export function pluginFeed(override?: string): string {
	const raw = override ?? process.env["SOLO_PLUGIN_FEED"] ?? DEFAULT_PLUGIN_FEED;
	return raw.endsWith("/") ? raw : `${raw}/`;
}

/**
 * 两个插件现在分别是什么状态。
 *
 * **只看磁盘**：目录在就是 `installed`，一个请求都不发 —— 老用户升级上来时这条是唯一的判据，
 * 也是「不触发下载」能拿计数服务证明的原因。
 */
export async function remotePluginStatuses(layout: Layout): Promise<readonly RemotePluginStatus[]> {
	const out: RemotePluginStatus[] = [];
	for (const name of REMOTE_PLUGINS) {
		if (await existsAt(join(layout.pluginsRoot, name))) {
			out.push({ name, state: "installed" });
			continue;
		}
		const state = progress.get(name);
		out.push({ name, state: state?.state ?? "missing", ...(state?.message === undefined ? {} : { message: state.message }) });
	}
	return out;
}

/** 调试/测试用的口子：换下载源、换公钥、换 fetch。生产一律走默认。 */
type DownloadOptions = {
	readonly feed?: string;
	readonly publicKey?: string;
	readonly fetchImpl?: typeof fetch;
};

/**
 * 下一个插件：取清单 → 验签 → 取 bundle → 校 sha256 → 落盘 → 记账本。
 *
 * 返回值只表示「现在盘上有这个插件了没有」。失败不抛：调用方是启动流程和界面按钮，
 * 抛出去只会变成一个没人处理的 rejection，状态已经记在 `progress` 里给界面看。
 */
export async function downloadRemotePlugin(layout: Layout, name: string, options: DownloadOptions = {}): Promise<boolean> {
	if (!isRemotePlugin(name)) return false;
	const target = join(layout.pluginsRoot, name);
	// 目录在：老用户 / 已经装上了 / 用户手改过。**一个请求都不发**就直接返回。
	if (await existsAt(target)) return true;

	const manifestPath = layout.seedManifestFile;
	const manifest = await readManifest(manifestPath);
	// 用户走过「删除」入口：尊重删除，不偷偷装回来。
	if (manifest.removed.includes(name)) return false;

	progress.set(name, { state: "downloading" });
	try {
		const feed = pluginFeed(options.feed);
		const fetcher = options.fetchImpl ?? fetch;
		const get = async (url: string): Promise<Response> => {
			const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
			if (!response.ok) throw new Error(`${url} 回 ${response.status}`);
			return response;
		};

		// 1. 清单 + 签名。签名对不上就到此为止 —— 后面那些字节一个都不信。
		const text = await (await get(`${feed}${PLUGIN_MANIFEST_ASSET}`)).text();
		const signature = await (await get(`${feed}${PLUGIN_MANIFEST_ASSET}.sig`)).text();
		if (!verifySignature(options.publicKey ?? UPDATE_PUBLIC_KEY, text, signature)) {
			throw new Error("插件清单签名不对：不是用发布密钥签的");
		}

		// 2. 找到这个插件那一条。
		const entry = manifestEntryOf(text, name);
		if (entry === undefined) throw new Error(`插件清单里没有「${name}」`);

		// 3. 取 bundle，校 sha256（+ 字节数）。清单签名是真的也照样校：签名保护的是清单，
		//    下载回来的文件是另一条链路，被换了只有 sha256 拦得住。
		const bundle = Buffer.from(await (await get(`${feed}${entry.file}`)).arrayBuffer());
		if (bundle.byteLength !== entry.size) throw new Error(`插件包大小不对：${bundle.byteLength} != ${entry.size}`);
		const digest = createHash("sha256").update(bundle).digest("hex");
		if (digest !== entry.sha256) throw new Error(`插件包 sha256 不对：${digest} != ${entry.sha256}`);

		// 4. 拆包落盘。路径逐个校验：清单是线上来的，不许它往插件目录外面写。
		const files = bundleFiles(bundle.toString("utf8"));
		const hashes: Record<string, string> = {};
		for (const [relpath, content] of files) {
			// 路径逐个校验：清单和包都是线上来的，不许它们往插件目录外面写。
			// 这里**不能**用 `isSafeName`（它按 slug 的规矩不认点，`plugin.js` 都过不去）；
			// 判据是「拆开没有空段 / `.` / `..` / 反斜杠」，落点再比一次是否还在目录里。
			const segments = relpath.split("/");
			const odd = segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\\"));
			const path = join(target, ...segments);
			if (relpath === "" || odd || !resolve(path).startsWith(`${resolve(target)}${sep}`)) {
				throw new Error(`插件包里的路径不合法：${relpath}`);
			}
			await writeTextAt(path, content);
			hashes[relpath] = hashOf(content);
		}

		// 5. 记账本：以后按 ADR-097 的判据「整个目录和上次播种时一样」继续生效。
		const seen = new Set([...manifest.plugins, name]);
		await writeManifest(manifestPath, {
			...manifest,
			plugins: [...seen].sort(),
			removed: manifest.removed.filter((item) => item !== name),
			pluginFiles: { ...manifest.pluginFiles, [name]: hashes },
		});
		progress.set(name, { state: "installed" });
		return true;
	} catch (error) {
		const message = humanMessage(error);
		progress.set(name, { state: "failed", message });
		// 日志留原始那一句（栈也算上）：给界面的是一句人话，排查时得看得到到底哪一步炸的。
	console.warn(`[plugin] 「${name}」没下下来：${message}｜${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		return false;
	}
}

/** 启动时补一次：缺哪个下哪个，**不阻塞启动**，失败只留状态等界面重试。 */
export async function ensureDownloadablePlugins(layout: Layout, options: DownloadOptions = {}): Promise<readonly string[]> {
	const done: string[] = [];
	for (const name of REMOTE_PLUGINS) {
		if (await existsAt(join(layout.pluginsRoot, name))) continue;
		if (await downloadRemotePlugin(layout, name, options)) done.push(name);
	}
	return done;
}

/** 清单里挑出这个插件那一条。字段类型不对就当成没有 —— 清单是线上来的，别信它的形状。 */
function manifestEntryOf(text: string, name: string): ManifestEntry | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null) return undefined;
	const list = (raw as Record<string, unknown>)["plugins"];
	if (!Array.isArray(list)) return undefined;
	for (const item of list) {
		if (typeof item !== "object" || item === null) continue;
		const entry = item as Record<string, unknown>;
		if (entry["name"] !== name) continue;
		const { version, file, sha256, size } = entry;
		if (typeof version !== "string" || typeof file !== "string" || typeof sha256 !== "string" || typeof size !== "number") {
			return undefined;
		}
		return { name, version, file, sha256, size };
	}
	return undefined;
}

/**
 * bundle 拆成「相对路径 → 内容」。bundle 是纯文本 JSON：
 * `{ "files": { "plugin.js": "<原文>", ... } }`。
 *
 * 为什么不是 zip：macOS 有 `ditto`、Windows 只有 PowerShell，仓库里也没有 zip 库；
 * 这两个插件的出厂文件全是文本，一个 JSON 就够，跨平台也一致。
 * 将来真出现二进制文件，得先把它 base64 进 bundle，再把这里改成按需解码。
 */
function bundleFiles(text: string): Map<string, string> {
	const raw: unknown = JSON.parse(text);
	if (typeof raw !== "object" || raw === null) throw new Error("插件包格式不对");
	const files = (raw as Record<string, unknown>)["files"];
	if (typeof files !== "object" || files === null || Array.isArray(files)) throw new Error("插件包里没有 files");
	const out = new Map<string, string>();
	for (const [relpath, content] of Object.entries(files as Record<string, unknown>)) {
		if (typeof content !== "string") throw new Error(`插件包里的 ${relpath} 不是文本`);
		out.set(relpath, content);
	}
	if (out.size === 0) throw new Error("插件包是空的");
	return out;
}

/** 给界面看的那句话：断网和校验失败要说得出区别，别都写成「下载失败」。 */
function humanMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timed out|aborted/i.test(raw)) return "这次没连上，稍后重试";
	if (raw.includes("签名")) return "插件清单签名不对，已拒绝安装";
	if (raw.includes("sha256") || raw.includes("大小")) return "下载回来的文件校验没过，已拒绝安装";
	return "没下下来，稍后重试";
}
