/**
 * 消息里点到的文件：把一句「`teams/x/workspace/a.md:12`」解成一份可预览的文件。
 *
 * 三个根按顺序认（老板 2026-11-10 放开）：用户根、应用根、源码仓库根。前两个是
 * **相对路径的候选起点**；仓库根让 `src/app/files.ts` 这种仓库相对写法也能点开。
 * **绝对路径**不再挡在门口，直接去 `stat`（`/etc/hosts` 这种能看，只读）。
 *
 * 三条底线（怎么守的，一条一条说）：
 *
 * 1. **`..` 不许跳出**：绝对路径也过一遍归一化，原样里出现 `..` 一律拒（`a/../b` 也拒，
 *    宁可多挡一次）；相对路径拼到根上以后，解析结果必须**落在这个根里面**（`relative`
 *    不是 `..` 开头），三个根都不落就拒。
 * 2. **软链接不许指向奇怪的地方**：判定用的是 `realpath` 之后的真实路径，不是字符串。
 *    - 相对路径：真的那个必须还在**同一个根**里面 —— 一个指向 `/etc/shadow` 的软链接
 *      会在这里被挡下；
 *    - 绝对路径：允许（它本来就是任意位置），但**自家的密钥与库按真实路径再挡一次**，
 *      免得 `~/link-to-settings.json` 从侧门进来。
 * 3. **只读预览**：这条例行只 `stat` + `createReadStream`，没有任何写。唯一会落盘的是
 *    「转成附件」（`uploads.stage`），它复制字节，**不改原文件**。
 *
 * `路径:行号` 的行号会解析出来放进 `line`：后端只负责解出来，界面据此定位（`files`
 * 本身不读文件内容，行号对不对不是它的事）。只认 `名字.ts:77` 这种「冒号 + 纯数字尾」，
 * Windows 的 `C:\x` 不会因此被拆坏。
 *
 * 认得的只有三种：图片、PDF、文本（HTML / SVG 一律降成文本 —— 它们能在同源里执行脚本，
 * 和附件那条 `INLINE_IMAGE` 不含 svg 是同一个理由）。其余老实说「不支持预览」。
 */
import { basename, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import type { Layout } from "../core/layout.ts";
import { fileStatAt, realPathOrUndefined } from "../core/runtime/io.ts";

/** 一份能交给界面去画的东西；`none` 是「说给人听的一句原因」。 */
export type FilePreview =
	| {
			readonly kind: "image" | "pdf" | "text";
			readonly path: string;
			readonly name: string;
			readonly size: number;
			readonly mime: string;
			/** `路径:行号` 里的行号；没有就是 `undefined`。 */
			readonly line: number | undefined;
	  }
	| { readonly kind: "none"; readonly name: string; readonly reason: string; readonly status: 404 | 415 };

const IMAGE_MIME: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	avif: "image/avif",
};

/** 能按文本读的扩展名。HTML / SVG 也在这里，只是 mime 会降成 `text/plain`。 */
const TEXT_EXT = new Set([
	"txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "xml", "yml", "yaml",
	"toml", "ini", "env", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "html", "htm",
	"svg", "sh", "bash", "zsh", "py", "sql",
]);

/** 没有扩展名的文件（`LICENSE`、`Makefile`）按文本读；有扩展名但不认识的就不猜。 */
const MAX_TEXT = 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_PDF = 16 * 1024 * 1024;

function extOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function createFiles(layout: Layout) {
	/** 点到了也不给看：密钥、库、播种清单。 */
	const denied = [layout.settingsFile, layout.secretsFile, layout.databasePath, layout.seedManifestFile];

	async function denyList(): Promise<readonly string[]> {
		const hits = await Promise.all(denied.map((path) => realPathOrUndefined(path)));
		return hits.filter((path): path is string => path !== undefined);
	}

	/** 说不了的东西：`status` 让路由直接回对（404 = 没有，415 = 有但不能预览）。 */
	function none(name: string, reason: string, status: 404 | 415 = 404): FilePreview {
		return { kind: "none", name, reason, status };
	}

	/**
	 * 解 `路径:行号`：只认「冒号后面是纯数字」的尾巴。
	 *
	 * 为什么要挑一挑：Windows 的 `C:\x\a.ts` 里也有冒号，URL 里也有。规则只有一条 ——
	 * 最后一段是纯数字才算行号，其余原样当路径。
	 */
	function splitLine(input: string): { readonly path: string; readonly line: number | undefined } {
		const match = /^(.*):(\d{1,7})$/.exec(input);
		if (match === null) return { path: input, line: undefined };
		const path = match[1] ?? "";
		const line = Number(match[2]);
		// 剩下的不能只剩一个盘符（`C:` 是驱动器，不是「C 文件第几行」）。
		if (path === "" || /^[A-Za-z]$/.test(path)) return { path: input, line: undefined };
		return { path, line: line > 0 ? line : undefined };
	}

	/** 这个真实路径是不是还在 `base` 里面（两个都是 `realpath` 之后的结果）。 */
	function inside(base: string, real: string): boolean {
		const back = relative(base, real);
		return back !== ".." && !back.startsWith(`..${sep}`) && !isAbsolute(back);
	}

	/**
	 * 先按原名找、找不到再去掉行号找。
	 *
	 * 为什么要两步：`report.md:abc` 这种「名字里本来就有冒号」的文件，与 `a.ts:77`
	 * 长得一样。先信文件名，再信行号 —— 顺序反了就会把能打开的文件变成 404。
	 */
	async function preview(input: string): Promise<FilePreview> {
		const wanted = input.trim();
		if (wanted === "") return none("", "没有指定文件");
		if (!wanted.startsWith("~")) {
			const asIs = await locate(wanted, undefined);
			if (asIs !== undefined) return asIs;
		}
		const { path: raw, line } = splitLine(wanted);
		// `:0` 拆出来的行号是 0，语义上是「不是行号」—— 那就拿整串再当一次文件名
		// （`report.md:0` 这种名字确实可能有人起），找不到才算 404。
		const target = line === undefined ? wanted : raw;
		return (await locate(target, line)) ?? none(basename(target), "找不到这个文件");
	}

	/** 解一个路径；解不出来给 `undefined`（调用方再试别的读法）。 */
	async function locate(raw: string, line: number | undefined): Promise<FilePreview | undefined> {
		if (raw.startsWith("~")) return none(basename(raw), "不认 ~ 开头的路径");

		const blocked = await denyList();
		/** 命中了就按格式说清楚：图片 / PDF / 文本各一档。 */
		const describe = (real: string, info: { readonly size: number }): FilePreview => {
			const name = basename(real);
			const ext = extOf(name);
			if (ext in IMAGE_MIME) {
				if (info.size > MAX_IMAGE) return none(name, "图片太大（超过 8 MB），到工作台里看", 415);
				return { kind: "image", path: real, name, size: info.size, mime: IMAGE_MIME[ext] ?? "application/octet-stream", line };
			}
			if (ext === "pdf") {
				if (info.size > MAX_PDF) return none(name, "PDF 太大（超过 16 MB），到工作台里看", 415);
				return { kind: "pdf", path: real, name, size: info.size, mime: "application/pdf", line };
			}
			const text = ext === "" || TEXT_EXT.has(ext);
			if (!text) return none(name, "这种格式不支持预览", 415);
			if (info.size > MAX_TEXT) return none(name, "文件太大（超过 1 MB），到工作台里看", 415);
			// 一律 text/plain：HTML / SVG 能在同源里执行脚本，别当页面渲染。
			return { kind: "text", path: real, name, size: info.size, mime: "text/plain; charset=utf-8", line };
		};

		if (isAbsolute(raw)) {
			// 绝对路径：门口不挡，交给「归一化里有没有 `..`」+「真实路径不在禁区」两道判据。
			if (normalize(raw).split(/[\\/]+/).includes("..")) return none(basename(raw), "路径不能往上走");
			// 归一化之后再比对一次：`/x/./../../etc/passwd` 这种归一化后就带 `..`，上面已经挡了，
			// 这里再确认一遍归一化没把「跳出去」伪装成合法路径。
			const real = await realPathOrUndefined(normalize(raw));
			if (real === undefined) return undefined;
			if (blocked.includes(real)) return none(basename(real), "这个文件不开放预览");
			const info = await fileStatAt(real);
			if (info === undefined) return undefined;
			return describe(real, info);
		}

		const segments = raw.split(/[\\/]+/);
		// 相对路径里任何一段 `..` 都不给：`teams/../../etc/passwd` 与 `../etc/passwd` 一样拒。
		if (segments.includes("..")) return none(basename(raw), "路径不能往上走");
		if (segments.some((segment) => segment.startsWith(".") && segment !== ".")) {
			return none(basename(raw), "隐藏文件不预览");
		}

		// 相对路径的候选起点：用户根 → 应用根 → 源码仓库根（有才排上）。
		const roots = [layout.userRoot, layout.appRoot, ...(layout.projectRoot === undefined ? [] : [layout.projectRoot])];
		for (const root of roots) {
			const base = await realPathOrUndefined(root);
			if (base === undefined) continue;
			const real = await realPathOrUndefined(resolve(base, raw));
			if (real === undefined) continue;
			// 软链接跟出去也不行：真实路径必须还落在这个根里。
			if (!inside(base, real)) continue;
			if (blocked.includes(real)) return none(basename(real), "这个文件不开放预览");
			const info = await fileStatAt(real);
			// 目录：换下一个根再试一次，都不行就是「找不到」。
			if (info === undefined) continue;
			return describe(real, info);
		}
		return undefined;
	}

	return { preview };
}
