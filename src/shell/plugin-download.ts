/**
 * 首次联网下载出厂插件（`悬浮球`、`文件树`、`IM机器人`、`Token统计`、`模型管理`）。
 *
 * 为什么不在 seed 里：这五个插件合计 471669 字节，占着 `seed/` 的体积上限（524288 字节），
 * 而它们不是「没有就开不了机」的东西。挪到线上让新装的机器按需取，`seed/` 就能从 448842
 * 掉到 53662（2.9.17 一次挪走三个，Solo 2026-11-12）。
 *
 * 四条底线（Solo 2026-11-12 拍，2.9.18 补第一、第四条）：
 * 1. **用户动过的一个字节不动、也不发请求** —— 判据是「整份是不是出厂原样」（见 `isUntouchedPlugin`）：
 *    有基线就逐文件和基线比，老账本没基线就比历史出厂 hash + 出厂文件名集合（`SHIPPED_PLUGIN_FILES`）。
 *    改过 / 加过 / 删过都算动过，照 ADR-097 留着。只有原样的才整份升到线上新版 —— 不然 2.9.16
 *    那几个插件修正永远到不了老用户（`data-tip` 那次就是，老板报的 bug 在老机器上没修到）。
 * 2. **清单必须带签名**，复用更新那条链路（`src/core/signing.ts` + 同一把发布公钥），
 *    但清单文件是**独立的一份** `plugins.json`，不和 `latest-mac.json` 混。
 * 3. **下载的文件按 sha256 校**（任务卡要求，更新清单那边是 sha512），对不上就不落盘。
 * 4. **不出现「升一半」**：新内容先写进 `<appRoot>/.plugin-staging`，全写成功才两次 rename 换目录；
 *    启动时先收拾残局（旧的挪回去、新的删掉），崩在哪一步都不会留下半份插件。
 *
 * 下载源只能由环境变量 `SOLO_PLUGIN_FEED` 覆盖（默认线上），**不做命令行参数、不做配置项**：
 * 那个口子等于给用户开「装任意插件」的后门，只有调试和验收用。
 */
import { createHash, randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";
import type { Layout } from "../core/layout.ts";
import { ensureDir, existsAt, listDirSorted, moveAt, removeDirAt, writeTextAtomic } from "../core/runtime/io.ts";
import { assetRequest, latestReleaseApi } from "../core/release-assets.ts";
import { verifySignature } from "../core/signing.ts";
import { UPDATE_PUBLIC_KEY } from "../core/update-key.ts";
import { hashOf, pluginHashes, readManifest, writeManifest, type SeedManifest } from "./seed.ts";
import { LEGACY_PLUGIN_HASHES } from "./seed-legacy.ts";

/** 线上默认下载源。改这个等于改「插件从哪儿来」，别随手动。 */
export const DEFAULT_PLUGIN_FEED = "https://github.com/kirer/Solo/releases/latest/download/";

/** 签名清单的文件名（旁边那份是 `<这个名字>.sig`）。**和 `latest-mac.json` 是两份东西。** */
export const PLUGIN_MANIFEST_ASSET = "plugins.json";

/**
 * 改成「首次联网下载」的出厂插件名（就是插件目录名）。
 *
 * 写死在代码里而不是 spread 一份文件：这样 `seed/` 一个字节都不用留，
 * 离线时界面也知道该显示哪几个「没装上」。
 *
 * **顺序就是首启串行下载的顺序**：越靠前越先下。悬浮球排第一是因为它最显眼
 * （桌面那扇独立的窗，没装上就是空的）；五个各记各的状态，一个失败不影响后面的
 * （`downloadRemotePlugin` 自己 catch、状态按名字记）。
 */
export const REMOTE_PLUGINS = ["悬浮球", "文件树", "IM机器人", "Token统计", "模型管理"] as const;

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

/** 这个进程里每个插件的下载状态，按名字记（只在内存里：重启会按磁盘重算，不需要持久化）。 */
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
 * 每个插件现在分别是什么状态（按名字各记各的，不合成一个全局状态）。
 *
 * **只看磁盘，一个请求都不发**：目录在就是 `installed`（哪怕它是旧版 —— 升级是后台按
 * `isUntouchedPlugin` 判的，界面这里只说「装上没装上」，不问版本）。
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
	/**
	 * 用户亲手点了「重试」。
	 *
	 * 只有这一种情况绕过「账本见过就跳过」：他走过删除入口，现在又明确说要。
	 * 启动时那一次（`ensureDownloadablePlugins`）不带这个，尊重删除。
	 * 盘上已有目录仍然不覆盖（ADR-097）——真要从头来是「卸载再装」，这版不做。
	 */
	readonly explicit?: boolean;
};

/**
 * 出厂插件目录里**该有的文件名**。
 *
 * 只在「老账本没有基线」（2.9.14 那种机器）时用：那种机器上不知道上次装的是哪一份，只能拿历史
 * 出厂 hash 猜；而光看 hash 猜不出「删了一个文件」—— 少一个文件，剩下的每个 hash 都还命中，
 * 那份插件看着就像没被动过。名字集合补的就是这个洞。
 *
 * **它不是第二套真相**：真相是 `plugins-src/` 里真实存在的文件。`plugin-download.test.ts`
 * 有一条断言逐个比对，对不上就红（改插件文件名忘了改这里，CI 当场拦住）。
 */
export const SHIPPED_PLUGIN_FILES: Record<RemotePluginName, readonly string[]> = {
		悬浮球: ["asr.swift", "client.js", "kokoro.js", "plugin.js", "plugin.md", "qwen.js", "tts-worker.js"],
		文件树: ["client.js", "plugin.js", "plugin.md"],
		IM机器人: ["client.js", "plugin.js", "plugin.md", "qrcode.mjs"],
		Token统计: ["client.js", "plugin.js", "plugin.md"],
		模型管理: ["client.js", "plugin.js", "plugin.md"],
};

/**
 * 半成品放在插件目录**外面**。
 *
 * `plugins/` 挂着目录监听（改一下就 reload 插件），staging 放里面等于自己踢自己：
 * 写几个文件就触发一次重装，装到一半的插件会先被加载一遍。
 */
const STAGING_DIR = ".plugin-staging";

const stagingRoot = (layout: Layout): string => join(layout.appRoot, STAGING_DIR);

const stageName = (kind: "new" | "old", name: string): string => `${kind}-${name}-${randomBytes(4).toString("hex")}`;

/** `new-悬浮球-a1b2c3d4` → `悬浮球`；认不出来的返回 undefined（残局一律清掉）。 */
function pluginOfStage(base: string): RemotePluginName | undefined {
	return REMOTE_PLUGINS.find((name) => base.startsWith(`${name}-`));
}

/**
 * 收拾上一次升级留下的残局（崩溃 / 被 kill / 断电）。
 *
 * 换目录的顺序永远是「先挪开旧的，再挪进新的」，所以两个时刻之间进程没了，`plugins/<名字>`
 * 会**不在**，旧内容躺在 `.plugin-staging/old-…` 里。这时挪回去 —— **宁旧不残**：旧版能跑，
 * 半份不能跑。反过来 `new-…` 一律删掉：新内容没换进去就不算数，下次启动重新下一遍。
 *
 * 返回修了几样（启动日志用）。这一步必须在 `ensureDownloadablePlugins` 之前跑。
 */
export async function recoverStaging(layout: Layout): Promise<readonly string[]> {
	const root = stagingRoot(layout);
	if (!(await existsAt(root))) return [];
	const fixed: string[] = [];
	for (const entry of await listDirSorted(root)) {
		const path = join(root, entry.name);
		const kind = entry.name.startsWith("new-") ? "new" : entry.name.startsWith("old-") ? "old" : undefined;
		const name = kind === undefined ? undefined : pluginOfStage(entry.name.slice(4));
		if (kind === undefined || name === undefined) {
			await removeDirAt(path).catch(() => undefined);
			continue;
		}
		const target = join(layout.pluginsRoot, name);
		if (kind === "new") {
			await removeDirAt(path).catch(() => undefined);
			fixed.push(`清掉「${name}」的半成品`);
			continue;
		}
		if (await existsAt(target)) {
			await removeDirAt(path).catch(() => undefined);
			continue;
		}
		await ensureDir(layout.pluginsRoot);
		await moveAt(path, target);
		fixed.push(`把「${name}」挪回上一份`);
	}
	return fixed;
}

/**
 * 盘上这一份是不是「出厂原样」。
 *
 * 两个判据，任一成立就算没动过：**有基线**就逐文件和基线比（基线就是「当前版本自己那份」，
 * 不用往历史 hash 表里登记线上包的 hash）；**老账本没基线**就比历史出厂 hash + 出厂文件名集合。
 * 都不成立 = 用户改过，一个字节不碰（ADR-097）。
 */
export async function isUntouchedPlugin(layout: Layout, manifest: SeedManifest, name: RemotePluginName): Promise<boolean> {
	const current = await pluginHashes(join(layout.pluginsRoot, name));
	const baseline = manifest.pluginFiles[name];
	if (baseline !== undefined) {
		const keys = Object.keys(baseline);
		return keys.length === Object.keys(current).length && keys.every((key) => current[key] === baseline[key]);
	}
	const shipped = SHIPPED_PLUGIN_FILES[name];
	const names = Object.keys(current);
	return (
		names.length === shipped.length &&
		shipped.every((file) => names.includes(file)) &&
		names.every((file) => LEGACY_PLUGIN_HASHES.has(current[file] ?? ""))
	);
}

/** 一个下载源：清单只取一次（五个插件共用），资产各取各的。 */
type Source = {
	readonly manifest: () => Promise<string>;
	readonly asset: (name: string) => Promise<Response>;
};

/** 懒开一个下载源：一次启动最多取一本清单（五个插件共用），一个包都不用取时那就只花这一本。 */
function sourceOf(options: DownloadOptions): () => Promise<Source> {
	const feed = pluginFeed(options.feed);
	const fetcher = options.fetchImpl ?? fetch;
	const publicKey = options.publicKey ?? UPDATE_PUBLIC_KEY;
	let opened: Promise<Source> | undefined;
	return () => (opened ??= openSource(feed, fetcher, publicKey));
}

/**
 * 地址只认 `assetRequest()` 一个算法：GitHub 源问 API 要资产直链（`api.github.com/.../assets/<id>`，
 * 带 `Accept: application/octet-stream`）。**不回落**到 `github.com/.../latest/download/`：
 * 那条路在一些网络里就是不通，回落等于把「更新包能下、插件包下不动」这个坑留给用户。
 */
async function openSource(feed: string, fetcher: typeof fetch, publicKey: string): Promise<Source> {
	const release = await releaseOf(feed, fetcher);
	const asset = async (name: string): Promise<Response> => {
		const request = assetRequest(feed, release, name);
		const response = await fetcher(request.url, {
			signal: AbortSignal.timeout(30_000),
			...(request.headers === undefined ? {} : { headers: request.headers }),
		});
		if (!response.ok) throw new Error(`${request.url} 回 ${response.status}`);
		return response;
	};
	let text: Promise<string> | undefined;
	return {
		asset,
		// 清单 + 签名。签名对不上就到此为止 —— 后面那些字节一个都不信。
		manifest: () =>
			(text ??= (async () => {
				const body = await (await asset(PLUGIN_MANIFEST_ASSET)).text();
				const signature = await (await asset(`${PLUGIN_MANIFEST_ASSET}.sig`)).text();
				if (!verifySignature(publicKey, body, signature)) throw new Error("插件清单签名不对：不是用发布密钥签的");
				return body;
			})()),
	};
}

/**
 * 装 / 升一份。**只在这里动插件目录和账本**：先比包、再下、再换目录、最后一次性记账本。
 * 抛错就什么都没变（正式目录和账本都不动），由调用方记状态。
 */
async function install(layout: Layout, name: RemotePluginName, source: Source, manifest: SeedManifest): Promise<boolean> {
	const entry = manifestEntryOf(await source.manifest(), name);
	if (entry === undefined) throw new Error(`插件清单里没有「${name}」`);
	const target = join(layout.pluginsRoot, name);
	const hadBefore = await existsAt(target);
	// 线上这份和上次装的是同一个包：不用下、也不用写盘。老用户每版只花两个请求就靠这一步。
	if (manifest.pluginBundle[name] === entry.sha256 && hadBefore) return false;

	// 取 bundle，校 sha256（+ 字节数）。清单签名是真的也照样校：签名保护的是清单，
	// 下载回来的文件是另一条链路，被换了只有 sha256 拦得住。
	const bundle = Buffer.from(await (await source.asset(entry.file)).arrayBuffer());
	if (bundle.byteLength !== entry.size) throw new Error(`插件包大小不对：${bundle.byteLength} != ${entry.size}`);
	const digest = createHash("sha256").update(bundle).digest("hex");
	if (digest !== entry.sha256) throw new Error(`插件包 sha256 不对：${digest} != ${entry.sha256}`);

	const staged = await writeStaged(layout, name, bundleFiles(bundle.toString("utf8")));
	await swapInto(layout, name, staged.path);
	await writeManifest(layout.seedManifestFile, {
		...manifest,
		plugins: [...new Set([...manifest.plugins, name])].sort(),
		removed: manifest.removed.filter((item) => item !== name),
		pluginFiles: { ...manifest.pluginFiles, [name]: staged.hashes },
		pluginBundle: { ...manifest.pluginBundle, [name]: entry.sha256 },
	});
	// 装成了也打一行（Solo #2417）：只打「没下下来」的话，用户报「插件没反应」时查不到
	// 到底装成功过没有、装的是哪一份 —— 排障等于瞎。失败那条在 `logFailure`，两条口径一致。
	console.log(
		`[plugin] 「${name}」${hadBefore ? "整份升级" : "装上"}了：${Object.keys(staged.hashes).length} 个文件，包 ${entry.sha256.slice(0, 12)}`,
	);
	return true;
}

/** 拆包写进 staging（全部写成功才有下一步）。返回落点和每个文件的 hash。 */
async function writeStaged(
	layout: Layout,
	name: RemotePluginName,
	files: Map<string, string>,
): Promise<{ path: string; hashes: Record<string, string> }> {
	const path = join(stagingRoot(layout), stageName("new", name));
	try {
		await ensureDir(path);
		const hashes: Record<string, string> = {};
		for (const [relpath, content] of files) {
			// 路径逐个校验：清单和包都是线上来的，不许它们往插件目录外面写。
			// 这里**不能**用 `isSafeName`（它按 slug 的规矩不认点，`plugin.js` 都过不去）；
			// 判据是「拆开没有空段 / `.` / `..` / 反斜杠」，落点再比一次是否还在目录里。
			const segments = relpath.split("/");
			const odd = segments.some(
				(segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\\"),
			);
			const file = join(path, ...segments);
			if (relpath === "" || odd || !resolve(file).startsWith(`${resolve(path)}${sep}`)) {
				throw new Error(`插件包里的路径不合法：${relpath}`);
			}
			// 原子写（同目录临时文件 + rename + 读回核对）：staging 里的文件也不许半截。
			// 顺带给「写到一半被 kill」留了个可注入的点（`setAtomicWriteFault`），
			// 那条验收就是这么造出来的 —— 不靠改权限、不靠 sleep 撞时机。
			await writeTextAtomic(file, content);
			hashes[relpath] = hashOf(content);
		}
		return { path, hashes };
	} catch (error) {
		await removeDirAt(path).catch(() => undefined);
		throw error;
	}
}

/**
 * 换目录：正式目录先挪到 `old-…`，staging 再挪进来（同一卷上两次 rename）。
 * 中间崩了由 `recoverStaging` 把旧的挪回去。失败时自己也尽力还原，不留半份。
 */
async function swapInto(layout: Layout, name: RemotePluginName, staged: string): Promise<void> {
	const target = join(layout.pluginsRoot, name);
	const old = join(stagingRoot(layout), stageName("old", name));
	const hadOld = await existsAt(target);
	try {
		await ensureDir(layout.pluginsRoot);
		if (hadOld) await moveAt(target, old);
		await moveAt(staged, target);
	} catch (error) {
		if (await existsAt(staged)) await removeDirAt(staged).catch(() => undefined);
		if (hadOld && !(await existsAt(target))) await moveAt(old, target).catch(() => undefined);
		throw error;
	}
	await removeDirAt(old).catch(() => undefined);
}

/**
 * 装下一个插件：缺了补上；出厂原样但线上有新版就整份升级。
 *
 * 返回值只表示「现在盘上有这个插件了没有」。失败不抛：调用方是启动流程和界面按钮，
 * 抛出去只会变成一个没人处理的 rejection，状态已经记在 `progress` 里给界面看。
 */
export async function downloadRemotePlugin(layout: Layout, name: string, options: DownloadOptions = {}): Promise<boolean> {
	if (!isRemotePlugin(name)) return false;
	const manifest = await readManifest(layout.seedManifestFile);
	const installed = await existsAt(join(layout.pluginsRoot, name));
	if (installed) {
		// 目录在：只有「出厂原样」的才可能动（整份升级）。用户改过的一个字节都不碰（ADR-097）；
		// 他删过又自己放回来的那份也一样 —— 那不是我们装的，不动。
		if (options.explicit !== true && manifest.removed.includes(name)) return true;
		if (!(await isUntouchedPlugin(layout, manifest, name))) return true;
	} else if (options.explicit !== true && manifest.removed.includes(name)) {
		// 用户走过「删除」入口：尊重删除，不偷偷装回来 —— 除非他这次是亲手点的重试。
		return false;
	}

	progress.set(name, { state: "downloading" });
	try {
		await install(layout, name, await sourceOf(options)(), manifest);
		progress.set(name, { state: "installed" });
		return true;
	} catch (error) {
		progress.set(name, { state: "failed", message: humanMessage(error) });
		logFailure(name, "没下下来", error);
		return false;
	}
}

/**
 * GitHub 形状的源：先问一次 `/releases/latest` 拿资产列表（一次下载只问一次）。
 *
 * 实际有两种走向，别当成一种：
 * - **接口这层拿不到**（限流 60 次/小时、连不上、回非 2xx）→ **抛**，不静默回落。回落拼的
 *   `github.com/.../latest/download/` 正好是那些连不上的网络，出了事用户只看到「没装上」。
 * - **接口通了、但清单里没有这个资产**（发布时漏传），或者名字对上了、地址却是空的 →
 *   `assetUrlOf` 直接抛「清单里没有这个包：<名字>」，不再回落去 `github.com` 白等到超时
 *   （2.9.16 做掉的待办；界面那句由 `humanMessage` 单独认，看得出不是网络问题）。
 * 认不出仓库的源（`SOLO_PLUGIN_FEED` 的本机端口、自建源）本来就没有 API 这一层，直接拼地址。
 */
async function releaseOf(feed: string, fetcher: typeof fetch): Promise<unknown> {
	const api = latestReleaseApi(feed);
	if (api === undefined) return undefined;
	let response: Response;
	try {
		response = await fetcher(api, {
			signal: AbortSignal.timeout(30_000),
			headers: { Accept: "application/vnd.github+json" },
		});
	} catch (error) {
		// `cause` 留着：日志要能打出根因（`code` 是 ECONNREFUSED / ENOTFOUND / 超时），
		// 光一句 `fetch failed` 分不出是哪种不通（Solo 2026-11-12）。
		throw new Error(`更新接口没通：${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	if (!response.ok) throw new Error(`更新接口没通：${api} 回 ${response.status}`);
	return await response.json();
}

/**
 * 启动时补一次：缺哪个下哪个，出厂原样而线上有新版的整份升级，**不阻塞启动**，失败只留状态等界面重试。
 *
 * 五个**串行**（并发去抢同一个 GitHub 限流额度只会更难），但彼此独立：`install` 的异常在这里接住、
 * 状态按名字记，其中一个失败不会让后面的停住。判据全在本地：用户改过的连清单都不取、一个请求都不发。
 * 走过删除入口的不在这里装回来（只有界面点重试、带 `explicit` 才真下）。
 */
export async function ensureDownloadablePlugins(layout: Layout, options: DownloadOptions = {}): Promise<readonly string[]> {
	// 上次升级被 kill 留下的残局先收拾：正式目录要么旧的、要么新的，不许半份。
	const fixed = await recoverStaging(layout);
	if (fixed.length > 0) console.log(`[plugin] 收拾了上次没装完的：${fixed.join("、")}`);

	const done: string[] = [];
	const source = sourceOf(options);
	for (const name of REMOTE_PLUGINS) {
		const manifest = await readManifest(layout.seedManifestFile);
		if (options.explicit !== true && manifest.removed.includes(name)) continue;
		// 已经装着、但用户改过：一个字节不动、一个请求不发（ADR-097）。判据在本地，连清单都不取。
		if ((await existsAt(join(layout.pluginsRoot, name))) && !(await isUntouchedPlugin(layout, manifest, name))) {
			continue;
		}
		progress.set(name, { state: "downloading" });
		try {
			if (await install(layout, name, await source(), manifest)) done.push(name);
			progress.set(name, { state: "installed" });
		} catch (error) {
			// 没网那几个：状态是 failed + 一句人话，界面上「重试」还在，主界面不等它。
			progress.set(name, { state: "failed", message: humanMessage(error) });
			logFailure(name, "没装成", error);
		}
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
export function humanMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	// 接口没通 vs 清单里没这个包：前者是网络，后者是发布时漏传，用户得看得出差别。
	const missing = /清单里没有这个包[：:]\s*(\S+)/.exec(raw);
	if (missing !== null) return `清单里没有这个包：「${missing[1]}」（不是网络问题，等下一版带上）`;
	// 限流和「不通」分开：一个是等一会儿就好，一个是网络本身到不了。
	if (/403|429|rate limit/i.test(raw)) return "插件包地址取不到（GitHub 限流），稍后重试";
	if (raw.includes("更新接口没通")) return "插件包地址取不到（更新接口没通），稍后重试";
	if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timed out|aborted/i.test(raw)) return "这次没连上，稍后重试";
	if (raw.includes("签名")) return "插件清单签名不对，已拒绝安装";
	if (raw.includes("sha256") || raw.includes("大小")) return "下载回来的文件校验没过，已拒绝安装";
	return "没下下来，稍后重试";
}

/**
 * 日志里那句「到底哪一步炸的」：错误原文 + 整条 `cause` 链。
 *
 * `TypeError: fetch failed` 是 undici 的通用外壳，根因在 `cause` 里：`code` 可能是
 * `ECONNREFUSED`（端口没人听）、`ENOTFOUND`（DNS 解析不出来）、`UND_ERR_CONNECT_TIMEOUT`
 * （连不上）。只打外壳的话，验的人分不出是拒绝还是超时（Solo 2026-11-12）。
 * 界面仍然是 `humanMessage` 那一句人话，根因只进日志。
 */
export function errorDetail(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
		if (current instanceof Error) {
			const code = (current as { code?: unknown }).code;
			parts.push(`${current.name}: ${current.message}${typeof code === "string" ? ` [${code}]` : ""}`);
			current = (current as { cause?: unknown }).cause;
			continue;
		}
		if (typeof current === "object") {
			const code = (current as { code?: unknown }).code;
			parts.push(typeof code === "string" ? `{ code: ${code} }` : JSON.stringify(current));
			current = (current as { cause?: unknown }).cause;
			continue;
		}
		parts.push(String(current));
		break;
	}
	return parts.join(" ← ");
}

/** 失败日志只留一个出口：一句人话给界面，原文 + `cause` 链 + 栈给排查。 */
function logFailure(name: string, what: string, error: unknown): void {
	const detail = errorDetail(error);
	const stack = error instanceof Error ? error.stack : undefined;
	const tail = stack === undefined || stack.includes(detail) ? "" : `\n${stack}`;
	console.warn(`[plugin] 「${name}」${what}：${humanMessage(error)}｜${detail}${tail}`);
}
