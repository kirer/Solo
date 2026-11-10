/**
 * 文件树的三个动作：看树、预览、把二进制搬出来给浏览器自己放。
 *
 * 工作区在哪由内核回答（`api.scope`），这里只拿到一个根目录字符串 —— 所以**越界检查
 * 必须在这里做完**：先把根 `realpath`，解析目标后再 `realpath` 一次（挡住指向外面的
 * 软链接），两次都要确认结果仍在根下面。单文件 1 MB 上限（媒体另算）、一次最多 400 条、
 * 最多 3 层。
 *
 * 三条路由的意义各不相同，别混：
 * - `/tree`、`/preview` 回 **JSON**（插件路由只有 JSON，`api.route` 的发不出字节）；
 * - `/raw` 回 **一段 data URL**：浏览器的 `<img>` / `<video>` / `<audio>` / `<iframe>`
 *   直接吃它，所以「真正的播放器」是浏览器自己的，这里不写任何渲染器。
 *
 * 写成 `.js`：与「模型管理」同一个理由 —— 单测会把插件原样装进临时目录里跑。
 */
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const MAX_BYTES = 1024 * 1024;
/** 图片单独放宽：截图常过 1 MB，但再大就别塞进 JSON 了。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 媒体（音频 / 视频）走 `/raw`，浏览器边下边放；再大就别在预览里放了。 */
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 400;
const MAX_DEPTH = 3;
/** 一次最多搬多少个（界面「预览全部图片」用的）。 */
const MAX_RAW_BATCH = 40;

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico)$/i;
const PDF = /\.pdf$/i;
const AUDIO = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i;
const VIDEO = /\.(mp4|m4v|webm|ogv|mov)$/i;
const HTML = /\.html?$/i;
const MARKDOWN = /\.(md|markdown)$/i;
const TEXT =
	/\.(txt|json|jsonl|ts|tsx|js|jsx|mjs|cjs|css|scss|less|yml|yaml|toml|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|sh|bash|zsh|sql|log|csv|tsv|xml|ini|conf|env|gitignore|lock)$/i;

/** 后缀 → 媒体类型。**不看内容**：这是猜测，只用来让浏览器挑播放器。 */
const MIME = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	avif: "image/avif",
	svg: "image/svg+xml",
	ico: "image/x-icon",
	pdf: "application/pdf",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	m4a: "audio/mp4",
	aac: "audio/aac",
	flac: "audio/flac",
	opus: "audio/opus",
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	ogv: "video/ogg",
	mov: "video/quicktime",
};

/** 先看 `.env` / `.git` 这类名字：名册里不该出现的东西，这里也不该出现。 */
function hidden(name) {
	return name.startsWith(".") || name === "node_modules";
}

function suffixOf(name) {
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return "";
	return name.slice(dot + 1).toLowerCase();
}

function mimeOf(name) {
	return MIME[suffixOf(name)] ?? "application/octet-stream";
}

/**
 * 把 `path`（相对根）解析成真实路径，并确认它仍在根下面。
 *
 * 两次 `realpath` 是刻意的：第一次挡 `../`，第二次挡「根里有一个指向外面的软链接」。
 * 只做字符串前缀检查的话，软链接就是一条逃逸通道。
 */
async function inside(root, path) {
	const base = await realpath(root);
	const wanted = resolve(base, path === undefined || path === "" ? "." : path);
	const rel = relative(base, wanted);
	if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) throw new Error("不在工作区里");
	const real = await realpath(wanted);
	const back = relative(base, real);
	if (back !== "" && (back.startsWith("..") || isAbsolute(back))) throw new Error("不在工作区里");
	return { base, real };
}

function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}

/** 一段路径的读者视角：这是文件吗、多大、是不是软链接。越界与不存在都抛错。 */
async function inspect(root, path) {
	const { real } = await inside(root, path);
	const info = await lstat(real);
	if (info.isSymbolicLink()) throw new Error("软链接不预览");
	if (!info.isFile()) throw new Error("不是文件");
	return { real, size: info.size, mtime: info.mtimeMs };
}

async function childrenOf(base, dir, rel, depth) {
	const entries = await readdir(dir, { withFileTypes: true });
	const rows = [];
	for (const entry of entries) {
		if (rows.length >= MAX_ENTRIES) break;
		if (hidden(entry.name)) continue;
		const full = join(dir, entry.name);
		const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
		// 软链接一律不跟：它可能指向根外面，跟着走就等于把守卫绕开。
		if (entry.isSymbolicLink()) {
			rows.push({ name: entry.name, path, dir: false });
			continue;
		}
		if (entry.isDirectory()) {
			const row = { name: entry.name, path, dir: true };
			if (depth < MAX_DEPTH) {
				try {
					row.children = await childrenOf(base, full, path, depth + 1);
				} catch {
					row.children = [];
				}
			}
			rows.push(row);
			continue;
		}
		if (entry.isFile()) rows.push({ name: entry.name, path, dir: false });
	}
	// 目录在前、同类按名字：界面不用自己排，两边也不会排出两种顺序。
	rows.sort((left, right) => (left.dir === right.dir ? left.name.localeCompare(right.name) : left.dir ? -1 : 1));
	return rows;
}

export function apply(api) {
	/**
	 * 三颗「系统动作」按钮真正的出口。
	 *
	 * 路径校验**不在这里**：这里只报工作区相对路径，绝对路径由内核拼、由它 `realpath`
	 * 复判、由它判软链接和「只收文件」。插件这一层只负责「有没有这个权限」的报错说清楚
	 * （内核抛的那句已经是人话，原样往上递）。
	 *
	 * 「打开文件所在位置」原先做不了 —— 插件拿不到绝对路径，也没有调 shell 的口子。
	 * 现在能了，但**不是插件拿到了路径**：它把相对路径交给内核，内核去开。
	 */
	api.route({
		method: "POST",
		pattern: "/api/p/files/system",
		async handle(request) {
			const body = request.body ?? {};
			const channelId = typeof body.channel === "string" ? body.channel : "";
			const action = body.action;
			const path = typeof body.path === "string" ? body.path : "";
			if (action === "copy") {
				if (path === "") return { kind: "error", error: "要复制什么？" };
				try {
					await api.system.act({ action: "system.copyText", channelId, text: path });
					return { kind: "ok", note: "已复制" };
				} catch (error) {
					return { kind: "error", error: errorText(error) };
				}
			}
			if (action !== "reveal" && action !== "open") {
				return { kind: "error", error: "不认识的动作" };
			}
			if (path === "") return { kind: "error", error: "要哪个文件？" };
			try {
				await api.system.act({
					action: action === "reveal" ? "system.reveal" : "system.open",
					channelId,
					path,
				});
				return { kind: "ok", note: action === "reveal" ? "已在访达里显示" : "已交给系统打开" };
			} catch (error) {
				return { kind: "error", error: errorText(error) };
			}
		},
	});

	api.route({
		method: "GET",
		pattern: "/api/p/files/tree",
		async handle(request) {
			const scope = await api.scope(request.query.channel ?? "");
			if (scope === undefined) return { kind: "none", label: "", entries: [] };
			try {
				const { base } = await inside(scope.root, "");
				return {
					kind: "tree",
					label: scope.label,
					// 界面上的路径行要显示「这是哪个目录」：给根，别让前端猜。
					root: scope.root,
					entries: await childrenOf(base, base, "", 1),
				};
			} catch (error) {
				// 工作区目录还没建（新招的人还没干过活）：空树，不是错误。
				return { kind: "tree", label: scope.label, root: scope.root, entries: [], note: errorText(error) };
			}
		},
	});

	api.route({
		method: "GET",
		pattern: "/api/p/files/preview",
		async handle(request) {
			const scope = await api.scope(request.query.channel ?? "");
			if (scope === undefined) return { kind: "none" };
			const path = request.query.path ?? "";
			if (path === "") return { kind: "error", text: "没有指定文件" };
			try {
				const name = path.split("/").pop() ?? path;
				const { real, size, mtime } = await inspect(scope.root, path);
				const meta = { name, path, size, mtime };
				// 图片 / PDF / 音视频不在这里读字节：给个类型，内容由 `/raw` 按需搬。
				// 一兆以上的媒体更不该塞进 JSON —— 这里是「告诉界面怎么画」，不是「搬文件」。
				if (IMAGE.test(name)) {
					if (size > MAX_IMAGE_BYTES) {
						return { kind: "binary", ...meta, note: `图片太大（${bytesText(size)}，上限 8 MB），用默认程序打开。` };
					}
					return { kind: "image", ...meta, mime: mimeOf(name) };
				}
				if (PDF.test(name)) {
					if (size > MAX_MEDIA_BYTES) {
						return { kind: "binary", ...meta, note: `PDF 太大（${bytesText(size)}，上限 32 MB），用默认程序打开。` };
					}
					return { kind: "pdf", ...meta, mime: "application/pdf" };
				}
				if (AUDIO.test(name)) {
					if (size > MAX_MEDIA_BYTES) {
						return { kind: "binary", ...meta, note: `音频太大（${bytesText(size)}，上限 32 MB），用默认程序打开。` };
					}
					return { kind: "audio", ...meta, mime: mimeOf(name) };
				}
				if (VIDEO.test(name)) {
					if (size > MAX_MEDIA_BYTES) {
						return { kind: "binary", ...meta, note: `视频太大（${bytesText(size)}，上限 32 MB），用默认程序打开。` };
					}
					return { kind: "video", ...meta, mime: mimeOf(name) };
				}
				if (size > MAX_BYTES) {
					return { kind: "error", text: `文件太大（${String(size)} 字节，上限 1 MB）` };
				}
				const bytes = await readFile(real);
				// 非文本一律不猜：给一句人话，别把二进制塞进 JSON。
				// 没有扩展名的文件（`LICENSE`、`Makefile`）按文本读。
				const known = HTML.test(name) || MARKDOWN.test(name) || TEXT.test(name);
				if (!known && /\./.test(name)) return { kind: "binary", ...meta };
				const text = bytes.toString("utf8");
				if (HTML.test(name)) return { kind: "html", ...meta, text };
				if (MARKDOWN.test(name)) return { kind: "markdown", ...meta, mime: "text/markdown", text };
				return { kind: "text", ...meta, mime: "text/plain", text };
			} catch (error) {
				return { kind: "error", text: errorText(error) };
			}
		},
	});

	/**
	 * 把文件搬成 data URL：`<img src>`、`<video src>`、`<iframe src>` 都吃它。
	 *
	 * 为什么不是一条真发字节的路由：插件路由的返回值只有 JSON（`api.route` 的契约），
	 * 发不出 `Content-Type` 与原始字节。data URL 是同一条守卫下的等价物 —— 浏览器拿到
	 * 的还是原始字节，播放器还是它自带的那个，不多一行渲染代码。
	 *
	 * 默认只搬「认得的媒体」（图片 / PDF / 音视频）；`kind=text` 才搬 HTML 原文
	 * （给 `sandbox=""` 的 iframe 用）。别的一概不搬：文本已经在 `/preview` 里了。
	 */
	api.route({
		method: "GET",
		pattern: "/api/p/files/raw",
		async handle(request) {
			const scope = await api.scope(request.query.channel ?? "");
			if (scope === undefined) return { kind: "none" };
			const paths = (request.query.paths ?? request.query.path ?? "")
				.split("\n")
				.map((item) => item.trim())
				.filter((item) => item !== "");
			const wantText = request.query.kind === "text";
			if (paths.length === 0) return { kind: "error", text: "没有指定文件" };
			if (paths.length > MAX_RAW_BATCH) return { kind: "error", text: `一次最多取 ${String(MAX_RAW_BATCH)} 个` };
			const items = [];
			for (const path of paths) {
				const name = path.split("/").pop() ?? path;
				try {
					const { real, size } = await inspect(scope.root, path);
					const media = IMAGE.test(name) || PDF.test(name) || AUDIO.test(name) || VIDEO.test(name);
					const playable = wantText ? HTML.test(name) : media;
					if (!playable) {
						items.push({ path, kind: "skip", note: "这个格式不走这条路" });
						continue;
					}
					const limit = wantText || !IMAGE.test(name) ? MAX_MEDIA_BYTES : MAX_IMAGE_BYTES;
					if (size > limit) {
						items.push({ path, kind: "skip", note: `太大（${bytesText(size)}）` });
						continue;
					}
					const bytes = await readFile(real);
					const mime = wantText ? "text/html;charset=utf-8" : mimeOf(name);
					items.push({ path, name, size, mime, kind: "ok", dataUrl: `data:${mime};base64,${bytes.toString("base64")}` });
				} catch (error) {
					items.push({ path, kind: "skip", note: errorText(error) });
				}
			}
			return { kind: "raw", items };
		},
	});
}

function bytesText(size) {
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
