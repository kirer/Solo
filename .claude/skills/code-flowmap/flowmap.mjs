#!/usr/bin/env node
/**
 * 通用代码流程图生成器（多语言，零依赖）。
 *
 * 扫仓库 → 抽 文件 / 类 / 函数 / 方法 / 调用 → 生成一张左→右、零交叉的树形图，
 * 同时给出「流程」视图：从入口函数出发的调用树，带静态条件、外部依赖和回环标记。
 * 输出一个自包含 HTML（内嵌数据，双击可看）。
 *
 * 用法：
 *   node flowmap.mjs                       # 生成到仓库根 code-flow.html
 *   node flowmap.mjs --root /path/to/repo  # 指定仓库
 *   node flowmap.mjs --stats               # 只打印统计
 *   node flowmap.mjs --base <sha>          # 标出自 base 以来的新增/修改
 *   node flowmap.mjs --no-diff             # 不做 git 对比
 *   node flowmap.mjs --out /tmp/x.html
 *   node flowmap.mjs --config .flowmap.json
 *   node flowmap.mjs --langs               # 列出支持的语言
 *
 * 配置文件（自动找 <root>/.flowmap.json 或 <root>/flowmap.config.json）：
 *   {
 *     "title": "项目名",
 *     "include": ["src/**"], "exclude": ["vendor/**"],
 *     "groupDepth": 2,
 *     "groups": [{ "id": "core", "title": "核心", "color": "#c2410c", "dirs": ["src/core"] }],
 *     "entries": [{ "file": "src/main.py", "name": "main", "title": "启动" }],
 *     "docMap": "docs/CODE.md",
 *     "maxFlowDepth": 7, "maxFlowNodes": 700, "maxFlows": 12
 *   }
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, basename } from "node:path";
import { profileFor, supportedExtensions, analyzeSource, conditionMap, isTestPath, shortOf } from "./languages.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CWD = process.cwd();
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

const ROOT = resolve(valueOf("--root") ?? CWD);
const OUT = resolve(valueOf("--out") ?? join(ROOT, "code-flow.html"));

const SKIP_DIRS = new Set([
	".git", ".hg", ".svn", "node_modules", "bower_components", "vendor", "dist", "build", "out", "target",
	"bin", "obj", "coverage", "__pycache__", ".venv", "venv", "env", ".tox", ".mypy_cache", ".pytest_cache",
	".ruff_cache", ".gradle", ".mvn", ".idea", ".vscode", ".next", ".nuxt", ".svelte-kit", ".cache",
	".terraform", "Pods", "DerivedData", "release", "feed", "dist-electron", ".solo-app", "workspace",
	"uploads", "logs", ".turbo", ".parcel-cache", ".yarn", ".pnpm-store",
]);

const SKIP_FILE = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock)$|\.min\.[cm]?js$|\.d\.ts$/;

const PALETTE = [
	"#c2410c", "#0f766e", "#1d4ed8", "#7c3aed", "#be123c", "#a16207", "#0e7490", "#4d7c0f",
	"#57534e", "#334155", "#b91c1c", "#047857", "#6d28d9", "#a21caf", "#0f766e", "#92400e",
];

const STRONG_ENTRY_NAMES = new Set(["main", "cli", "entry", "launch", "program"]);
const WEAK_ENTRY_NAMES = new Set([
	"start", "serve", "listen", "run", "bootstrap", "init", "setup", "handler", "execute",
	"createapp", "createserver", "lambda_handler", "handle_request", "startserver", "startapp",
	"bootstrapapp", "app", "handle",
]);
const ENTRY_FILES = new Set(["main", "index", "server", "cli", "__main__", "manage", "wsgi", "asgi", "program", "program.cs", "main.java"]);
const ENTRY_TITLES = {
	main: "启动", start: "启动", run: "运行", bootstrap: "启动", init: "初始化", setup: "初始化",
	serve: "开服务", listen: "监听", handler: "处理请求", cli: "命令行", entry: "入口", execute: "执行",
	launch: "启动", createapp: "创建应用", createserver: "创建服务", app: "应用入口", program: "程序入口",
	lambda_handler: "处理请求", handle_request: "处理请求", handle: "处理", startserver: "开服务", startapp: "启动",
};

const BUILTIN_CALLS = new Set([
	"console", "log", "print", "println", "printf", "fprintf", "sprintf", "fmt", "len", "range", "str", "int",
	"float", "bool", "list", "dict", "set", "tuple", "open", "close", "read", "write", "append", "format",
	"join", "split", "strip", "replace", "lower", "upper", "keys", "values", "items", "get", "has", "add",
	"remove", "push", "pop", "map", "filter", "reduce", "foreach", "then", "catch", "finally", "await",
	"promise", "json", "object", "array", "string", "number", "math", "date", "error", "require", "import",
	"super", "this", "self", "typeof", "sizeof", "new", "delete", "malloc", "free", "make", "panic", "recover",
	"os", "sys", "time", "datetime", "random", "re", "math", "strconv", "strings", "errors", "context",
	"http", "filepath", "path", "io", "ioutil", "bufio", "sort", "sync", "atomic", "runtime", "testing",
	"assert", "expect", "describe", "it", "test", "beforeeach", "aftereach", "beforeall", "afterall",
	"tostring", "tojson", "toisostring", "replaceall", "trim", "trimstart", "trimend", "startswith",
	"endswith", "tolowercase", "touppercase", "padstart", "padend", "match", "matchall", "exec", "on",
	"once", "emit", "off", "end", "pipe", "resume", "pause", "destroy", "appendchild", "removechild",
	"queryselector", "queryselectorall", "getelementbyid", "addeventlistener", "removeeventlistener",
	"preventdefault", "stoppropagation", "focus", "blur", "scrollto", "scrollintoview", "setattribute",
	"getattribute", "removeattribute", "classlist", "click", "submit", "reset", "load", "save", "send",
	"abort", "parseint", "parsefloat", "isnan", "settimeout", "setinterval", "cleartimeout", "clearinterval",
	"fetch", "url", "urlsearchparams", "buffer", "process", "structuredclone", "crypto", "textencoder",
	"textdecoder", "intl", "regexp", "symbol", "bigint", "reflect", "proxy", "queuemicrotask",
	"encodeuricomponent", "decodeuricomponent", "atob", "btoa", "sleep", "wait", "exit", "args",
]);

/* ────────────────────────────── 配置 / 参数 ────────────────────────────── */

function loadConfig() {
	const explicit = valueOf("--config");
	const candidates = explicit ? [resolve(CWD, explicit)] : [join(ROOT, ".flowmap.json"), join(ROOT, "flowmap.config.json")];
	let raw = {};
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		try {
			raw = JSON.parse(readFileSync(p, "utf8"));
			break;
		} catch (err) {
			console.error(`配置文件解析失败：${p}\n${err.message}`);
			process.exit(1);
		}
	}
	return {
		title: raw.title ?? "",
		include: raw.include ?? [],
		exclude: raw.exclude ?? [],
		groupDepth: raw.groupDepth ?? 0,
		groups: raw.groups ?? null,
		entries: raw.entries ?? null,
		docMap: raw.docMap ?? "",
		maxFlowDepth: raw.maxFlowDepth ?? 7,
		maxFlowNodes: raw.maxFlowNodes ?? 700,
		maxFlows: raw.maxFlows ?? 12,
		maxFileBytes: raw.maxFileBytes ?? 2 * 1024 * 1024,
		configPath: candidates.find((p) => existsSync(p)) ?? "",
	};
}

const config = loadConfig();

function globRe(glob) {
	let s = glob.replace(/^\.\//, "").replace(/\\/g, "/");
	let re = "^";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "*" && s[i + 1] === "*") { re += ".*"; i++; }
		else if (ch === "*") re += "[^/]*";
		else if (ch === "?") re += "[^/]";
		else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`${re}$`);
}
const includeRes = config.include.map(globRe);
const excludeRes = config.exclude.map(globRe);

/* ────────────────────────────── 扫文件 ────────────────────────────── */

function walkFiles() {
	const out = [];
	const walk = (dir) => {
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (e.name.startsWith(".") && e.name !== ".") continue;
			if (e.isSymbolicLink()) continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (SKIP_DIRS.has(e.name)) continue;
				walk(full);
				continue;
			}
			if (!e.isFile()) continue;
			const rel = relative(ROOT, full).replace(/\\/g, "/");
			if (SKIP_FILE.test(rel)) continue;
			if (excludeRes.some((re) => re.test(rel))) continue;
			if (includeRes.length && !includeRes.some((re) => re.test(rel))) continue;
			if (!profileFor(rel)) continue;
			try {
				if (statSync(full).size > config.maxFileBytes) continue;
			} catch { continue; }
			out.push({ path: rel, full });
		}
	};
	walk(ROOT);
	out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return out;
}

/* ────────────────────────────── 文档表 ────────────────────────────── */

function loadDocMap() {
	if (!config.docMap) return { map: new Map(), byBase: new Map() };
	const p = resolve(ROOT, config.docMap);
	if (!existsSync(p)) return { map: new Map(), byBase: new Map() };
	const map = new Map();
	const byBase = new Map();
	for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
		if (!line.trim().startsWith("|")) continue;
		const cells = line.split("|").slice(1, -1).map((c) => c.trim());
		if (cells.length < 2) continue;
		const key = cells[0].replace(/`/g, "").trim();
		if (!key || /^-+$/.test(key) || /^(文件|file|路径|path)$/i.test(key)) continue;
		const summary = cells[1].replace(/\*\*/g, "").trim();
		if (!summary || /^-+$/.test(summary)) continue;
		if (key.includes("/") || key.includes(".")) {
			map.set(key.replace(/^\.\//, ""), summary);
			byBase.set(key.split("/").pop(), summary);
		}
	}
	return { map, byBase };
}
const docTable = loadDocMap();

/* ────────────────────────────── 建结构 ────────────────────────────── */

let idSeq = 0;
const nextId = (prefix) => `${prefix}${++idSeq}`;

function groupKey(path) {
	const segs = dirname(path).split("/").filter((s) => s && s !== ".");
	if (!segs.length) return "根目录";
	if (config.groupDepth > 0) return segs.slice(0, config.groupDepth).join("/");
	if (segs[0] === "packages" || segs[0] === "apps") return segs.slice(0, 2).join("/");
	if (segs[0] === "src" || segs[0] === "lib") {
		if (segs.length >= 3 && ["core", "app", "pkg", "internal", "modules"].includes(segs[1])) return segs.slice(0, 3).join("/");
		return segs.slice(0, 2).join("/");
	}
	if (["test", "tests", "ui", "desktop"].includes(segs[0])) return segs.slice(0, 2).join("/");
	return segs[0];
}

function buildGroups(files) {
	if (config.groups?.length) {
		const groups = config.groups.map((g, i) => ({
			id: g.id || `g${i}`,
			title: g.title || g.id || `模块 ${i + 1}`,
			summary: g.summary || g.desc || "",
			color: g.color || PALETTE[i % PALETTE.length],
			dirs: (g.dirs ?? []).map((d) => d.replace(/\/+$/, "")),
			fileList: g.files ?? [],
			order: i,
			files: [],
		}));
		const other = { id: "other", title: "其他", summary: "没有归进配置分组的文件", color: PALETTE[groups.length % PALETTE.length], dirs: [], fileList: [], order: 9999, files: [] };
		for (const f of files) {
			const g = groups.find((x) => x.fileList.includes(f.path) || x.dirs.some((d) => f.path === d || f.path.startsWith(`${d}/`)));
			(g ?? other).files.push(f);
		}
		const out = groups.filter((g) => g.files.length);
		if (other.files.length) out.push(other);
		return out;
	}
	const map = new Map();
	for (const f of files) {
		const key = groupKey(f.path);
		if (!map.has(key)) map.set(key, []);
		map.get(key).push(f);
	}
	const keys = [...map.keys()].sort((a, b) => (a === "根目录" ? -1 : b === "根目录" ? 1 : a < b ? -1 : a > b ? 1 : 0));
	const counts = new Map();
	for (const k of keys) {
		const last = k.split("/").pop();
		counts.set(last, (counts.get(last) ?? 0) + 1);
	}
	return keys.map((key, i) => {
		const last = key.split("/").pop();
		const title = counts.get(last) > 1 ? key.replace(/\//g, " · ") : last;
		return {
			id: `g${i + 1}`,
			title,
			summary: `${map.get(key).length} 个文件`,
			color: PALETTE[i % PALETTE.length],
			order: i,
			files: map.get(key),
		};
	});
}

function buildTree(files, analyses) {
	const groups = buildGroups(files);
	const groupById = new Map(groups.map((g) => [g.id, g]));
	for (const f of files) {
		f.group = groups.find((g) => g.files.includes(f))?.id ?? groups[0]?.id;
	}
	const fileNodes = new Map();
	const root = {
		id: "root",
		kind: "root",
		name: config.title || detectRepoName(),
		summary: "",
		sub: "",
		children: [],
	};
	const symbolTotal = { n: 0, methods: 0, languages: new Set() };
	for (const g of groups) {
		const gnode = {
			id: g.id,
			kind: "group",
			name: g.title,
			group: g.id,
			color: g.color,
			summary: g.summary || `${g.files.length} 个文件`,
			sub: g.files.length > 1 ? `${g.files.length} 个文件` : "",
			children: [],
		};
		for (const f of g.files) {
			const a = analyses.get(f.path);
			const docFromTable = docTable.map.get(f.path) ?? docTable.byBase.get(basename(f.path)) ?? "";
			const header = a.headerDoc;
			const summary = shortOf(docFromTable) || shortOf(header) || `${a.profile.title} 文件 · ${a.symbols.length} 个声明`;
			const doc = [docFromTable, docFromTable && header ? "" : "", header].filter(Boolean).join("\n\n");
			const fnode = {
				id: nextId("f"),
				kind: "file",
				name: basename(f.path),
				path: f.path,
				dir: dirname(f.path) === "." ? "" : dirname(f.path),
				group: g.id,
				summary,
				doc,
				line: 1,
				endLine: a.lineCount,
				imports: [],
				importedBy: [],
				children: a.symbols,
			};
			const assign = (s) => {
				s.id = nextId("s");
				s._parentSym = null;
				s._ownerId = null;
				s._file = f.path;
				s._group = g.id;
				s._test = isTestPath(f.path);
				symbolTotal.n++;
				if (s.kind === "method" || s.kind === "constructor") symbolTotal.methods++;
				for (const c of s.children ?? []) assign(c);
			};
			for (const s of a.symbols) assign(s);
			symbolTotal.languages.add(a.profile.id);
			gnode.children.push(fnode);
			fileNodes.set(f.path, fnode);
		}
		root.children.push(gnode);
	}
	root.summary = `${files.length} 个文件 · ${symbolTotal.n} 个声明 · ${symbolTotal.languages.size} 种语言`;
	root.sub = `${groups.length} 个模块 · 左→右按目录阅读`;
	return { root, fileNodes, groups, counts: { files: files.length, symbols: symbolTotal.n, methods: symbolTotal.methods, groups: groups.length, languages: symbolTotal.languages.size } };
}

function detectRepoName() {
	const pkg = join(ROOT, "package.json");
	if (existsSync(pkg)) {
		try { const n = JSON.parse(readFileSync(pkg, "utf8")).name; if (n) return n; } catch { /* ignore */ }
	}
	for (const [file, re] of [["pyproject.toml", /^\s*name\s*=\s*["']([^"']+)["']/m], ["Cargo.toml", /^\s*name\s*=\s*["']([^"']+)["']/m], ["go.mod", /^module\s+(\S+)/m]]) {
		const p = join(ROOT, file);
		if (!existsSync(p)) continue;
		const m = re.exec(readFileSync(p, "utf8"));
		if (m) return m[1].split("/").pop();
	}
	return basename(ROOT) || "代码";
}

/* ────────────────────────────── 导入 / 索引 ────────────────────────────── */

function buildFileLookup(files) {
	const set = new Set(files.map((f) => f.path));
	const byBase = new Map();
	const dirs = new Set();
	for (const f of files) {
		const base = basename(f.path).replace(/\.[^.]+$/, "");
		if (!byBase.has(base)) byBase.set(base, []);
		byBase.get(base).push(f.path);
		dirs.add(dirname(f.path));
	}
	return { set, byBase, dirs };
}

function resolveSpec(fromPath, spec, profile, lookup) {
	if (!spec) return undefined;
	const dir = dirname(fromPath);
	const clean = spec.replace(/^\.\//, "").replace(/\\/g, "/");
	const tryPath = (p) => {
		const norm = p.replace(/\\/g, "/").replace(/\/\.\//g, "/");
		const noLead = norm.replace(/^\.\//, "");
		if (lookup.set.has(noLead)) return noLead;
		for (const ext of profile?.exts ?? supportedExtensions()) {
			if (lookup.set.has(noLead + ext)) return noLead + ext;
		}
		for (const ext of profile?.exts ?? supportedExtensions()) {
			const idx = `${noLead.replace(/\/$/, "")}/index${ext}`;
			if (lookup.set.has(idx)) return idx;
		}
		return undefined;
	};

	if (profile?.id === "python") {
		const dots = /^(\.+)/.exec(spec)?.[1].length ?? 0;
		if (dots) {
			let base = dir;
			for (let i = 1; i < dots; i++) base = dirname(base);
			const rest = spec.slice(dots).replace(/\./g, "/");
			const p = rest ? join(base, rest) : base;
			const hit = tryPath(p) ?? tryPath(join(p, "__init__"));
			if (hit) return hit;
		} else {
			const p = spec.replace(/\./g, "/");
			const hit = tryPath(p) ?? tryPath(join(p, "__init__"));
			if (hit) return hit;
		}
	}
	if (spec.startsWith(".") || spec.startsWith("/")) {
		const hit = tryPath(join(dir, spec)) ?? tryPath(spec.replace(/^\//, ""));
		if (hit) return hit;
	}
	if (profile?.id === "cpp" || profile?.id === "c" || profile?.id === "shell" || profile?.id === "r") {
		const hit = tryPath(join(dir, clean)) ?? tryPath(clean);
		if (hit) return hit;
	}
	const target = clean.replace(/^crate::/, "").replace(/^super::/, "").replace(/::/g, "/").replace(/\./g, "/");
	for (const p of lookup.set) {
		if (p === target || p.endsWith(`/${target}`)) return p;
	}
	const base = clean.split(/[/.:\\]/).filter(Boolean).pop() ?? "";
	if (lookup.byBase.get(base)?.length === 1) return lookup.byBase.get(base)[0];
	const hits = lookup.byBase.get(base) ?? [];
	if (hits.length > 1) {
		const segs = target.split("/").filter(Boolean);
		const best = hits.find((p) => segs.every((s) => p.includes(`/${s}`)));
		if (best) return best;
		const sameDir = hits.find((p) => dirname(p) === dir);
		if (sameDir) return sameDir;
	}
	return undefined;
}

function resolveImports(files, analyses) {
	const lookup = buildFileLookup(files);
	for (const f of files) {
		const a = analyses.get(f.path);
		const fnode = a._fileNode;
		const resolved = new Map();
		for (const [local, { spec, imported }] of a.importMap) {
			const target = resolveSpec(f.path, spec, a.profile, lookup);
			if (target) resolved.set(local, { path: target, imported });
		}
		a._resolvedImports = resolved;
		fnode.imports = [...new Set([...resolved.values()].map((x) => x.path))];
	}
	const byPath = new Map(files.map((f) => [f.path, analyses.get(f.path)._fileNode]));
	for (const f of files) {
		for (const target of byPath.get(f.path).imports) {
			const tn = byPath.get(target);
			if (tn && !tn.importedBy.includes(f.path)) tn.importedBy.push(f.path);
		}
	}
	return lookup;
}

function buildIndexes(files, analyses) {
	const byId = new Map();
	const byName = new Map();
	const byFile = new Map();
	const byFileAll = new Map();
	const byDir = new Map();
	const methods = new Map();
	const add = (name, sym) => {
		if (!byName.has(name)) byName.set(name, []);
		byName.get(name).push(sym);
	};
	for (const f of files) {
		const a = analyses.get(f.path);
		const top = new Map();
		const all = new Map();
		const visit = (s, parent) => {
			byId.set(s.id, s);
			add(s.name, s);
			if (!all.has(s.name)) all.set(s.name, []);
			all.get(s.name).push(s);
			if (s._class) methods.set(`${s._class}.${s.name}`, s);
			if (!parent) top.set(s.name, s);
			for (const c of s.children ?? []) visit(c, s);
		};
		for (const s of a.symbols) visit(s, null);
		byFile.set(f.path, top);
		byFileAll.set(f.path, all);
		const dir = dirname(f.path);
		if (!byDir.has(dir)) byDir.set(dir, new Map());
		for (const [name, s] of top) if (!byDir.get(dir).has(name)) byDir.get(dir).set(name, s);
	}
	return { byId, byName, byFile, byFileAll, byDir, methods };
}

function lookupInFile(indexes, path, name) {
	const direct = indexes.byFileAll.get(path)?.get(name);
	if (!direct?.length) return undefined;
	return direct.find((s) => s.kind !== "type" && s.kind !== "interface") ?? direct[0];
}

function lookupImported(indexes, analysis, target, imported, fallback) {
	const all = indexes.byFileAll.get(target);
	if (!all) return undefined;
	if (imported === "*") return lookupInFile(indexes, target, fallback);
	if (imported && imported !== "default") return all.get(imported)?.find((s) => s.kind !== "type") ?? lookupInFile(indexes, target, fallback);
	const base = basename(target).replace(/\.[^.]+$/, "");
	const guess = all.get(base)?.find((s) => s.kind !== "type");
	if (guess) return guess;
	return lookupInFile(indexes, target, fallback);
}

/* ────────────────────────────── 调用点 ────────────────────────────── */

const METHOD_CALL = /([A-Za-z_$][\w$]*)\s*(?:\.|->|::)\s*([A-Za-z_$][\w$]*)\s*\(/g;
const BARE_CALL = /(?<![\w$.:>])([A-Za-z_$][\w$]*)\s*\(/g;
const CHAIN_CALL = /\)\s*(?:\.|->|::)\s*([A-Za-z_$][\w$]*)\s*\(/g;

function resolveCallee(name, receiver, sym, analysis, indexes) {
	if (receiver === "this" || receiver === "self" || receiver === "super") {
		if (sym._class) {
			const m = indexes.methods.get(`${sym._class}.${name}`);
			if (m) return m;
		}
		return lookupInFile(indexes, analysis.path, name);
	}
	if (receiver) {
		const local = indexes.byFile.get(analysis.path)?.get(receiver) ?? indexes.byFileAll.get(analysis.path)?.get(receiver)?.find((s) => s.kind === "object" || s.kind === "class");
		if (local) {
			const child = (local.children ?? []).find((c) => c.name === name);
			if (child) return child;
			return undefined;
		}
		const imp = analysis._resolvedImports?.get(receiver);
		if (imp) return lookupImported(indexes, analysis, imp.path, imp.imported, name);
		const cls = (indexes.byName.get(receiver) ?? []).filter((s) => ["class", "object", "struct", "impl"].includes(s.kind) && !s._test);
		if (cls.length === 1) return (cls[0].children ?? []).find((c) => c.name === name);
		// 接收者是普通局部变量时拿不到类型；同名方法全仓库唯一才敢连。
		const meths = (indexes.byName.get(name) ?? []).filter((s) => s.kind === "method" && !s._test);
		if (meths.length === 1) return meths[0];
		return undefined;
	}
	const local = lookupInFile(indexes, analysis.path, name);
	if (local) return local;
	const imp = analysis._resolvedImports?.get(name);
	if (imp) return lookupImported(indexes, analysis, imp.path, imp.imported, name);
	const sameDir = indexes.byDir.get(dirname(analysis.path))?.get(name);
	if (sameDir) return sameDir;
	const all = (indexes.byName.get(name) ?? []).filter((s) => !s._test && ["function", "method", "class", "constructor"].includes(s.kind));
	if (all.length === 1) return all[0];
	return undefined;
}

function collectSites(sym, analysis, indexes) {
	const sites = [];
	const seen = new Set();
	const start = Math.max(0, sym._bodyStart);
	const end = Math.min(analysis.codeLines.length - 1, sym._bodyEnd);
	if (start > end) return sites;
	const conds = conditionMap(analysis.codeLines, start, end);
	const params = new Set();
	const record = (name, receiver, lineIdx, col) => {
		if (!name) return;
		if (start === lineIdx && col < sym._bodyCol) return;
		const callee = resolveCallee(name, receiver, sym, analysis, indexes);
		if (!callee && BUILTIN_CALLS.has(name.toLowerCase())) return;
		const key = callee ? callee.id : `?${receiver ? `${receiver}.` : ""}${name}`;
		if (seen.has(key)) return;
		seen.add(key);
		sites.push({
			name: receiver ? `${receiver}.${name}` : name,
			calleeId: callee?.id,
			line: lineIdx + 1,
			condition: conds.get(lineIdx) ?? "",
			order: sites.length + 1,
		});
	};
	for (let i = start; i <= end; i++) {
		let line = analysis.codeLines[i] ?? "";
		if (i === start && sym._bodyCol > 0) line = " ".repeat(sym._bodyCol) + line.slice(sym._bodyCol);
		for (const m of line.matchAll(METHOD_CALL)) record(m[2], m[1], i, m.index);
		for (const m of line.matchAll(BARE_CALL)) {
			record(m[1], undefined, i, m.index);
		}
		for (const m of line.matchAll(CHAIN_CALL)) {
			record(m[1], undefined, i, m.index);
		}
		if (analysis.profile.id === "ruby") {
			for (const m of line.matchAll(/\)\s*\.\s*([A-Za-z_]\w*)/g)) record(m[1], undefined, i, m.index);
			for (const m of line.matchAll(/^\s*([a-z_]\w*)\s*$/g)) record(m[1], undefined, i, m.index);
		}
	}
	return sites;
}

function fileSites(analysis, indexes) {
	const sites = [];
	const seen = new Set();
	const covered = new Array(analysis.codeLines.length).fill(false);
	const mark = (s) => {
		for (let i = s.startLine - 1; i <= s.endLine - 1 && i < covered.length; i++) covered[i] = true;
		for (const c of s.children ?? []) mark(c);
	};
	for (const s of analysis.symbols) mark(s);
	const conds = conditionMap(analysis.codeLines, 0, analysis.codeLines.length - 1);
	const pseudo = { _class: undefined };
	const record = (name, receiver, i, col) => {
		if (!name) return;
		const callee = resolveCallee(name, receiver, pseudo, analysis, indexes);
		if (!callee && BUILTIN_CALLS.has(name.toLowerCase())) return;
		const key = callee ? callee.id : `?${receiver ? `${receiver}.` : ""}${name}`;
		if (seen.has(key)) return;
		seen.add(key);
		sites.push({ name: receiver ? `${receiver}.${name}` : name, calleeId: callee?.id, line: i + 1, condition: conds.get(i) ?? "", order: sites.length + 1 });
	};
	for (let i = 0; i < analysis.codeLines.length; i++) {
		if (covered[i]) continue;
		const line = analysis.codeLines[i] ?? "";
		if (/^\s*(?:import|export\s+\{|from|require|include|use|using)\b/.test(line)) continue;
		for (const m of line.matchAll(METHOD_CALL)) record(m[2], m[1], i, m.index);
		for (const m of line.matchAll(BARE_CALL)) record(m[1], undefined, i, m.index);
		for (const m of line.matchAll(CHAIN_CALL)) record(m[1], undefined, i, m.index);
		if (analysis.profile.id === "ruby") {
			for (const m of line.matchAll(/\)\s*\.\s*([A-Za-z_]\w*)/g)) record(m[1], undefined, i, m.index);
			for (const m of line.matchAll(/^\s*([a-z_]\w*)\s*$/g)) record(m[1], undefined, i, m.index);
		}
		if (sites.length > 400) break;
	}
	return sites;
}

function buildSites(files, analyses, indexes) {
	for (const f of files) {
		const a = analyses.get(f.path);
		const visit = (s) => {
			if (!["class", "object", "interface", "struct", "trait", "impl", "enum", "module", "type", "namespace"].includes(s.kind)) {
				s._sites = collectSites(s, a, indexes);
				s.calls = [...new Set(s._sites.map((x) => x.name))].slice(0, 30);
			}
			for (const c of s.children ?? []) visit(c);
		};
		for (const s of a.symbols) visit(s);
		a._fileSites = fileSites(a, indexes);
	}
}

/* ────────────────────────────── 流程 ────────────────────────────── */

let flowSeq = 0;
const nextFlowId = () => `k${++flowSeq}`;

function countFlow(node) {
	let n = 1;
	for (const c of node.children ?? []) n += countFlow(c);
	return n;
}

function expandSites(node, sites, stack, depth, budget, indexes) {
	if (depth >= config.maxFlowDepth) {
		if (sites.some((s) => s.calleeId)) node.note = "更深的调用已省略";
		return;
	}
	const seen = new Set();
	for (const site of sites) {
		if (!site.calleeId) {
			const key = `?${site.name}`;
			if (seen.has(key)) continue;
			seen.add(key);
			if (budget.n <= 0) { node.note = "已到节点上限，后续省略"; return; }
			budget.n--;
			node.children.push({
				id: nextFlowId(), kind: "step", name: site.name, file: "", group: node.group,
				summary: `未解析的调用：${site.name}（注入依赖 / 外部模块）`, doc: "", sig: "",
				step: site.order, condition: site.condition, external: true,
				note: "未解析（注入依赖 / 外部模块）", children: [],
			});
			continue;
		}
		const callee = indexes.byId.get(site.calleeId);
		if (!callee || seen.has(callee.id)) continue;
		seen.add(callee.id);
		const repeat = stack.has(callee.id);
		if (budget.n <= 0) { node.note = "已到节点上限，后续省略"; return; }
		budget.n--;
		const child = {
			id: nextFlowId(), kind: "step", symbolId: callee.id, name: callee.name, file: callee._file,
			line: callee.line, group: callee._group, summary: callee.summary, doc: callee.doc,
			sig: callee.sig, step: site.order, condition: site.condition, repeat,
			note: repeat ? "已在上游展开（递归 / 回环）" : "", calls: callee.calls, children: [],
		};
		node.children.push(child);
		if (!repeat) expandSites(child, callee._sites ?? [], new Set([...stack, callee.id]), depth + 1, budget, indexes);
	}
}

function flowTitleFor(name) {
	return ENTRY_TITLES[name.toLowerCase()] ?? name;
}

function detectEntries(files, analyses, indexes) {
	const picked = [];
	const seen = new Set();
	const push = (file, sym, score, title) => {
		const key = sym ? sym.id : `file:${file}`;
		if (seen.has(key)) return;
		seen.add(key);
		picked.push({ file, sym, score, title });
	};
	if (config.entries?.length) {
		for (const e of config.entries) {
			const file = e.file.replace(/^\.\//, "");
			if (!analyses.has(file)) continue;
			const a = analyses.get(file);
			let sym;
			if (e.name) {
				sym = indexes.byFile.get(file)?.get(e.name) ?? indexes.byFileAll.get(file)?.get(e.name)?.find((s) => s.kind !== "type");
				if (!sym) continue;
			}
			picked.push({ file, sym, score: 1000 - picked.length, title: e.title || (sym ? flowTitleFor(sym.name) : `${basename(file)} 顶层`), desc: e.desc });
		}
		return picked;
	}
	for (const f of files) {
		if (isTestPath(f.path)) continue;
		const a = analyses.get(f.path);
		const base = basename(f.path).replace(/\.[^.]+$/, "").toLowerCase();
		const entryFile = ENTRY_FILES.has(base);
		const allFns = [];
		const walkFns = (s) => {
			if (["function", "method", "constructor"].includes(s.kind)) allFns.push(s);
			for (const c of s.children ?? []) walkFns(c);
		};
		for (const s of a.symbols) walkFns(s);
		const mainFn = allFns.find((s) => s.name.toLowerCase() === "main");
		const strong = mainFn ?? allFns.find((s) => STRONG_ENTRY_NAMES.has(s.name.toLowerCase()));
		const weak = entryFile ? allFns.find((s) => WEAK_ENTRY_NAMES.has(s.name.toLowerCase())) : undefined;
		const named = strong ?? weak;
		if (named) {
			const score = named.name.toLowerCase() === "main" ? 100 : entryFile ? 80 : 60;
			push(f.path, named, score, flowTitleFor(named.name));
			continue;
		}
		if (entryFile && base !== "index") {
			push(f.path, undefined, 50, `${basename(f.path)} 顶层`);
			continue;
		}
		if (entryFile && a._fileSites.length) {
			push(f.path, undefined, 40, `${basename(f.path)} 顶层`);
		}
	}
	if (!picked.length) {
		const degree = new Map();
		for (const f of files) {
			const a = analyses.get(f.path);
			const visit = (s) => {
				for (const site of s._sites ?? []) if (site.calleeId) degree.set(site.calleeId, (degree.get(site.calleeId) ?? 0) + 1);
				for (const c of s.children ?? []) visit(c);
			};
			for (const s of a.symbols) visit(s);
		}
		const ranked = [...degree.entries()]
			.map(([id, n]) => ({ sym: indexes.byId.get(id), n }))
			.filter((x) => x.sym && !x.sym._test && ["function", "method"].includes(x.sym.kind))
			.sort((a, b) => b.n - a.n || (a.sym._file < b.sym._file ? -1 : 1))
			.slice(0, 6);
		for (const x of ranked) push(x.sym._file, x.sym, x.n, x.sym.name);
	}
	const rank = (file) => {
		const top = file.split("/")[0];
		if (["src", "lib", "app", "pkg", "cmd", "internal"].includes(top)) return 0;
		if (["ui", "desktop", "packages", "apps"].includes(top)) return 1;
		if (["scripts", "tools", "examples", "test", "tests"].includes(top)) return 3;
		return 2;
	};
	return picked
		.sort((a, b) => b.score - a.score || rank(a.file) - rank(b.file) || (a.file < b.file ? -1 : 1))
		.slice(0, config.maxFlows);
}

function buildFlows(files, analyses, indexes) {
	const entries = detectEntries(files, analyses, indexes);
	const flows = [];
	for (const e of entries) {
		const a = analyses.get(e.file);
		if (!a) continue;
		const sym = e.sym;
		const sites = sym?._sites ?? a._fileSites;
		const budget = { n: config.maxFlowNodes };
		const root = {
			id: nextFlowId(),
			kind: "flowroot",
			symbolId: sym?.id ?? `file:${e.file}`,
			name: e.title || (sym ? flowTitleFor(sym.name) : `${basename(e.file)} 顶层`),
			entry: sym ? sym.name : "文件顶层",
			file: e.file,
			line: sym?.line ?? 1,
			group: a._fileNode?.group,
			summary: e.desc || (sym ? `入口 ${sym.name} · ${e.file}` : `文件顶层执行 · ${e.file}`),
			doc: sym?.doc ?? a.headerDoc,
			sig: sym?.sig ?? `${a.lineCount} 行 · 顶层执行`,
			step: 0,
			condition: "",
			calls: sym?.calls ?? [],
			children: [],
		};
		const stack = new Set(sym ? [sym.id] : []);
		expandSites(root, sites, stack, 0, budget, indexes);
		flows.push({ id: `flow-${flows.length + 1}`, title: root.name, desc: root.summary, count: countFlow(root), root });
	}
	return flows;
}

/* ────────────────────────────── git ────────────────────────────── */

function git(argv) {
	try {
		return execFileSync("git", ["-C", ROOT, ...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

function gitInfo() {
	const sha = git(["rev-parse", "HEAD"]);
	if (!sha) return { sha: "", subject: "（不是 git 仓库）", dirty: false };
	const subject = git(["log", "-1", "--format=%s"]);
	const dirty = git(["status", "--porcelain", "--untracked-files=no"]).length > 0;
	return { sha, subject, dirty };
}

function previousPin(outPath) {
	if (!existsSync(outPath)) return "";
	const html = readFileSync(outPath, "utf8");
	return html.match(/<meta name="flowmap-pin" content="([0-9a-f]+)"/)?.[1] ?? "";
}

function markAll(node, status) {
	node.status = status;
	for (const c of node.children ?? []) markAll(c, status);
}

function normalizeSig(s) {
	return (s ?? "").replace(/\s+/g, " ").trim();
}

function applyDiff(fileNodes, base) {
	const empty = { base: "", addedFiles: 0, modifiedFiles: 0, removedFiles: 0, addedSymbols: 0, modifiedSymbols: 0, removedSymbols: 0, removed: [] };
	if (!base) return empty;
	const raw = git(["diff", "--name-status", base, "HEAD"]);
	if (!raw) return empty;
	const stats = { ...empty, base };
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		const status = parts[0][0];
		let path = parts[1];
		if (status === "R" && parts[2]) path = parts[2];
		const node = fileNodes.get(path);
		if (status === "A") {
			stats.addedFiles++;
			if (node) markAll(node, "added");
			continue;
		}
		if (status === "D") {
			stats.removedFiles++;
			stats.removed.push({ file: path, name: basename(path), kind: "file" });
			continue;
		}
		stats.modifiedFiles++;
		if (!node) continue;
		const profile = profileFor(path);
		if (!profile) { node.status = "modified"; continue; }
		const oldText = git(["show", `${base}:${parts[1]}`]);
		if (!oldText) { node.status = "modified"; continue; }
		let oldA;
		try { oldA = analyzeSource(path, oldText, profile); } catch { node.status = "modified"; continue; }
		const oldMap = new Map();
		const visitOld = (s) => {
			oldMap.set(`${s.kind}:${s.name}`, s);
			for (const c of s.children ?? []) visitOld(c);
		};
		for (const s of oldA.symbols) visitOld(s);
		const seenNew = new Set();
		let changed = false;
		const visitNew = (s) => {
			if (!["function", "class", "object", "method", "constructor", "get", "set"].includes(s.kind)) return;
			const key = `${s.kind}:${s.name}`;
			seenNew.add(key);
			const old = oldMap.get(key);
			if (!old) { s.status = "added"; stats.addedSymbols++; changed = true; }
			else if (normalizeSig(old.sig) !== normalizeSig(s.sig) || (old.doc ?? "") !== (s.doc ?? "")) {
				s.status = "modified"; stats.modifiedSymbols++; changed = true;
			}
			for (const c of s.children ?? []) visitNew(c);
		};
		for (const s of node.children) visitNew(s);
		for (const [key, old] of oldMap) {
			if (seenNew.has(key) || !["function", "class", "object", "method", "constructor", "get", "set"].includes(old.kind)) continue;
			stats.removedSymbols++;
			stats.removed.push({ file: path, name: old.name, kind: old.kind });
			changed = true;
		}
		if (changed) node.status = "modified";
	}
	return stats;
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

function build() {
	const files = walkFiles();
	if (!files.length) {
		console.error(`没有找到可分析的源码文件（${ROOT}）。支持：${supportedExtensions().join(" ")}`);
		process.exit(1);
	}
	const analyses = new Map();
	for (const f of files) {
		let text;
		try { text = readFileSync(f.full, "utf8"); } catch { continue; }
		const profile = profileFor(f.path);
		try {
			analyses.set(f.path, analyzeSource(f.path, text, profile));
		} catch (err) {
			console.error(`跳过 ${f.path}：${err.message}`);
		}
	}
	const liveFiles = files.filter((f) => analyses.has(f.path));
	const built = buildTree(liveFiles, analyses);
	for (const [path, node] of built.fileNodes) analyses.get(path)._fileNode = node;
	resolveImports(liveFiles, analyses);
	const indexes = buildIndexes(liveFiles, analyses);
	buildSites(liveFiles, analyses, indexes);
	const flows = buildFlows(liveFiles, analyses, indexes);
	return { ...built, analyses, indexes, flows, files: liveFiles };
}

function main() {
	if (flag("--langs")) {
		console.log(supportedExtensions().join(" "));
		return;
	}
	const built = build();
	if (flag("--stats")) {
		const c = built.counts;
		console.log(`${c.files} 文件 · ${c.symbols} 声明 · ${c.methods} 方法 · ${c.groups} 模块 · ${c.languages} 种语言`);
		console.log(`${built.flows.length} 条流程：`);
		for (const f of built.flows) console.log(`  ${f.title} ${f.count} 步\t${f.root.file}\t${f.root.entry}`);
		if (config.configPath) console.log(`配置：${relative(CWD, config.configPath)}`);
		return;
	}
	if (flag("--sample")) {
		for (const g of built.root.children) {
			for (const f of g.children.slice(0, 3)) console.log(`${f.path}\t${f.summary}`);
		}
		return;
	}
	const pin = gitInfo();
	const baseArg = valueOf("--base");
	const base = flag("--no-diff") ? "" : baseArg || previousPin(OUT);
	const diff = base && pin.sha && base !== pin.sha ? applyDiff(built.fileNodes, base) : { base: "", addedFiles: 0, modifiedFiles: 0, removedFiles: 0, addedSymbols: 0, modifiedSymbols: 0, removedSymbols: 0, removed: [] };
	const payload = {
		root: built.root,
		flows: built.flows,
		groups: built.groups.map(({ id, title, color }) => ({ id, title, color })),
		meta: {
			title: built.root.name,
			pin: pin.sha,
			short: pin.sha ? pin.sha.slice(0, 7) : "—",
			subject: pin.subject,
			dirty: pin.dirty,
			generatedAt: new Date().toISOString().slice(0, 10),
			base: diff.base ? diff.base.slice(0, 7) : "",
			diff,
			counts: built.counts,
		},
	};
	const templatePath = join(HERE, "template.html");
	if (!existsSync(templatePath)) {
		console.error(`缺模板：${templatePath}`);
		process.exit(1);
	}
	const template = readFileSync(templatePath, "utf8");
	const json = JSON.stringify(payload).replace(/</g, "\\u003c");
	const html = template
		.replace("__FLOWMAP_PIN__", () => payload.meta.pin)
		.replace("__PIN__", () => payload.meta.short)
		.replace("__FLOWMAP_JSON__", () => json);
	writeFileSync(OUT, html);
	const c = built.counts;
	console.log(`已生成 ${relative(CWD, OUT) || OUT}`);
	console.log(`  ${pin.sha ? `commit ${payload.meta.short} ${pin.subject}` : "非 git 仓库"}`);
	console.log(`  ${c.files} 文件 · ${c.symbols} 声明 · ${c.methods} 方法 · ${c.groups} 模块 · ${c.languages} 种语言`);
	console.log(`  ${built.flows.length} 条流程：${built.flows.map((f) => `${f.title} ${f.count} 步`).join(" · ") || "（未发现入口）"}`);
	if (diff.base) console.log(`  自 ${diff.base.slice(0, 7)}：+${diff.addedFiles} 文件 ~${diff.modifiedFiles} 文件 -${diff.removedFiles} 文件；+${diff.addedSymbols} / ~${diff.modifiedSymbols} / -${diff.removedSymbols} 声明`);
}

main();
