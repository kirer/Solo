/**
 * `search`：在工作区里找东西（按内容 grep / 按文件名 glob）。
 *
 * 为什么不是「用 `run` 里的 grep」：Windows 上没有 `grep`，`rg` 也不一定有；而模型
 * 一旦发现命令不存在，就会换成 `findstr` / `Select-String` 一路试下去 —— 一轮的
 * token 全花在猜本机装了什么上。这里用 Node 自己走目录，哪个平台都一样。
 *
 * 也不做成 `file` 的 action：`file` 的主语是一个文件（`path` 必填），而搜索的主语
 * 是一段目录和一条模式，参数对不上。
 */
import { isAbsolute as pathIsAbsolute, join as pathJoin } from "node:path";
import { Type, defineTool } from "../../runtime/index.ts";
import { listDirSorted, readTextOrUndefined } from "../../runtime/io.ts";
import { fill } from "../../documents/base/catalog.ts";
import { actionOf, text, type CoreToolDeps } from "./context.ts";
import { clip, hasDotDot, isProtectedName, MODEL_LIMIT, resolveToolPath } from "./guards.ts";

/**
 * 命中行的显示路径。两种起点两种口径：绝对起点（额外工作目录）就是盘上真路径，按平台分隔符拼；
 * 相对起点给的是「回到工作区的相对路径」，固定 `/`，Windows 上也不出反斜杠。
 *
 * 这里把路径函数做成参数，是为了能在 mac 上用 `path.win32` 把 Windows 那一侧真跑一遍：
 * 这台机器跑不出 Windows，只有把最后这一步拼替换掉才验得到。
 */
export function displayPath(
	base: string,
	entryRel: string,
	p: { join: (...parts: string[]) => string; isAbsolute: (value: string) => boolean } = {
		join: pathJoin,
		isAbsolute: pathIsAbsolute,
	},
): string {
	if (base === "") return entryRel;
	return p.isAbsolute(base) ? p.join(base, entryRel) : `${base}/${entryRel}`;
}

/** 不进搜索的目录：依赖、版本库、日志、附件、模型缓存。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "logs", "uploads", "voice", "orb", "im", "release"]);

/** 多大的文件不读：工作区里的文档都是几 KB，超过这个数多半是二进制或数据。 */
const MAX_FILE_BYTES = 256 * 1024;

/** 最多走多少个文件。防止有人在根目录上搜一次把整块盘扫一遍。 */
const MAX_FILES = 2_000;

/** 深度上限。`members/x/workspace/a/b/...` 再深就不是文档了。 */
const MAX_DEPTH = 8;

/** `*.md` → 正则。`**` 跨目录，`*` 不跨，`?` 一个字符。 */
function globToRegExp(glob: string): RegExp {
	const escape = (char: string): string => (/[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char);
	let source = "";
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index] ?? "";
		if (char === "*") {
			if (glob[index + 1] === "*") {
				source += ".*";
				index += 1;
				if (glob[index + 1] === "/") index += 1;
			} else source += "[^/]*";
		} else if (char === "?") source += "[^/]";
		else source += escape(char);
	}
	return new RegExp(`^${source}$`, "iu");
}

/** 一条命中的形状。`line` 只在 grep 时有。 */
type Hit = { readonly path: string; readonly line?: number; readonly body?: string };

export function createSearchTool(deps: CoreToolDeps) {
	const t = (key: string, slots: Record<string, string | number | undefined> = {}): string =>
		fill(deps.text, key, slots);

	const tool = defineTool({
		name: "search",
		description: t("search.description"),
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: t("search.param.action") })),
			pattern: Type.String({ description: t("search.param.pattern") }),
			path: Type.Optional(Type.String({ description: t("search.param.path") })),
			limit: Type.Optional(Type.Number({ description: t("search.param.limit") })),
		}),
		execute: async (args) => {
			const action = actionOf(args.action, ["grep", "glob"], "grep", "action", deps.text);
			if (typeof action !== "string") return text(action);
			const limit = Math.min(Math.max(Math.trunc(args.limit ?? 40), 1), 200);
			const pattern = args.pattern;

			// 不给路径就搜整个组织目录：要用的东西（身份、团队说明、技能、记忆）散在
			// `members/` `teams/` `skills/` 里，只搜自己的工作目录多半一个都找不到。
			const start = args.path === undefined || args.path.trim() === "" ? "." : args.path.trim();
			const resolved = resolveToolPath(deps.layout, start, deps.workDirs?.() ?? []);
			if (resolved.kind === "protected") return text(t("search.refuse.secret"));
			if (resolved.kind === "outside") {
				const unconfigured = resolved.absolute && !hasDotDot(start);
				return text(unconfigured ? t("search.refuse.unconfigured", { path: start }) : t("search.outside", { path: start }));
			}
			const root = resolved.path;
			// 展示用：相对起点的命中给工作区相对路径；绝对起点（额外目录）给绝对路径 ——
			// 一眼能看出这一条不在组织里，也不会被当成工作区相对路径去读。
			const base = start === "." || start === "./" ? "" : start.replace(/[\\/]+$/, "");

			let matcher: RegExp | ((line: string) => boolean);
			if (action === "glob") matcher = globToRegExp(pattern);
			else {
				try {
					matcher = new RegExp(pattern, "iu");
				} catch {
					// 正则写错不该让这一轮失败：按字面量找，模型照样拿到结果。
					matcher = (line: string) => line.toLowerCase().includes(pattern.toLowerCase());
				}
			}
			const test = (value: string): boolean => (matcher instanceof RegExp ? matcher.test(value) : matcher(value));

			const hits: Hit[] = [];
			let files = 0;
			let exhausted = false;

			const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
				if (exhausted || depth > MAX_DEPTH) return;
				for (const entry of await listDirSorted(abs)) {
					if (exhausted) return;
					// 密钥、库、配置对工具不存在（`file` 也是这个口径）：读出来等于把 key 装进上下文，
					// 而 `settings.json` 里除了 apiKey 还有 `workDirs` 本身。起点被拒是一条路，
					// 「从一个宽目录搜下来」是另一条 —— 这里直接跳过，不报错（黑名单文件不该让整次搜索失败）。
					if (isProtectedName(entry.name)) continue;
					const entryAbs = pathJoin(abs, entry.name);
					const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
					const shown = displayPath(base, entryRel);
					if (entry.kind === "dir") {
						if (SKIP_DIRS.has(entry.name)) continue;
						await walk(entryAbs, entryRel, depth + 1);
						continue;
					}
					if (entry.kind !== "file") continue;
					files += 1;
					if (files > MAX_FILES) {
						exhausted = true;
						return;
					}
					if (action === "glob") {
						// 通配符既匹配整条相对路径，也匹配文件名本身：`*.md` 不该要求写全路径。
						const name = entry.name;
						if (test(entryRel) || test(name)) hits.push({ path: shown });
					} else {
						const body = await readTextOrUndefined(entryAbs);
						// 二进制（含 NUL）与超大文件跳过：读进来只会是一堆乱码。
						if (body === undefined || body.length > MAX_FILE_BYTES || body.includes("\u0000")) continue;
						const lines = body.split("\n");
						for (let index = 0; index < lines.length; index += 1) {
							const line = lines[index] ?? "";
							if (!test(line)) continue;
							hits.push({
								path: shown,
								line: index + 1,
								body: line.length > 240 ? `${line.slice(0, 240)}…` : line.trim(),
							});
							if (hits.length > limit) {
								exhausted = true;
								return;
							}
						}
					}
					if (hits.length > limit) {
						exhausted = true;
						return;
					}
				}
			};

			await walk(root, "", 0);
			if (hits.length === 0) return text(t("search.empty", { pattern }));
			const shown = hits.slice(0, limit);
			const lines = shown.map((hit) => (hit.line === undefined ? hit.path : `${hit.path}:${hit.line}: ${hit.body ?? ""}`));
			const more = exhausted || hits.length > limit ? `\n${t("search.more", { files })}` : "";
			return text(clip(`${lines.join("\n")}${more}`, MODEL_LIMIT, deps.text));
		},
	});
	return tool;
}
