/**
 * 文件树的后端：只读地看一个频道的工作区。
 *
 * 工作区在哪由内核回答（`api.scope`），这里只拿到一个根目录字符串 —— 所以**越界检查
 * 必须在这里做完**：先把根 `realpath`，解析目标后再 `realpath` 一次（挡住指向外面的
 * 软链接），两次都要确认结果仍在根下面。单文件 1 MB 上限、一次最多 400 条、最多 3 层。
 *
 * 写成 `.js`：与「模型管理」同一个理由 —— 单测会把插件原样装进临时目录里跑。
 */
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 400;
const MAX_DEPTH = 3;

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const HTML = /\.html?$/i;
const MARKDOWN = /\.(md|markdown)$/i;
const TEXT =
	/\.(txt|json|jsonl|ts|tsx|js|jsx|mjs|css|yml|yaml|toml|py|sh|sql|log|csv|xml|ini|env)$/i;

/** 先看 `.env` / `.git` 这类名字：名册里不该出现的东西，这里也不该出现。 */
function hidden(name) {
	return name.startsWith(".") || name === "node_modules";
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
					entries: await childrenOf(base, base, "", 1),
				};
			} catch (error) {
				// 工作区目录还没建（新招的人还没干过活）：空树，不是错误。
				return { kind: "tree", label: scope.label, entries: [], note: errorText(error) };
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
				const { real } = await inside(scope.root, path);
				const info = await lstat(real);
				if (info.isSymbolicLink()) return { kind: "error", text: "软链接不预览" };
				if (!info.isFile()) return { kind: "error", text: "不是文件" };
				if (info.size > MAX_BYTES) return { kind: "error", text: `文件太大（${String(info.size)} 字节，上限 1 MB）` };
				const name = path.split("/").pop() ?? path;
				const bytes = await readFile(real);
				if (IMAGE.test(name)) {
					const mime = name.toLowerCase().endsWith(".svg") ? "image/svg+xml" : `image/${(name.split(".").pop() ?? "png").toLowerCase()}`;
					return { kind: "image", name, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` };
				}
				// 非文本一律不猜：给一句人话，别把二进制塞进 JSON。
				// 没有扩展名的文件（`LICENSE`、`Makefile`）按文本读。
				const known = HTML.test(name) || MARKDOWN.test(name) || TEXT.test(name);
				if (!known && /\./.test(name)) return { kind: "binary", name, bytes: info.size };
				const text = bytes.toString("utf8");
				if (HTML.test(name)) return { kind: "html", name, text };
				if (MARKDOWN.test(name)) return { kind: "markdown", name, text };
				return { kind: "text", name, text };
			} catch (error) {
				return { kind: "error", text: errorText(error) };
			}
		},
	});
}
