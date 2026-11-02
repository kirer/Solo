#!/usr/bin/env node
/**
 * Solo 代码流程图生成器。
 *
 * 读 TypeScript 源码 → 提取 文件 / 类 / 函数 / 方法 → 生成一张左→右、零交叉的树形流程图。
 * 输出一个自包含 HTML（内嵌数据，双击可看）。
 *
 * 用法：
 *   node .claude/skills/code-flowmap/flowmap.mjs                 # 生成到仓库根 code-flow.html
 *   node .claude/skills/code-flowmap/flowmap.mjs --stats         # 只打印统计
 *   node .claude/skills/code-flowmap/flowmap.mjs --base <sha>    # 标出自 base 以来的新增/修改
 *   node .claude/skills/code-flowmap/flowmap.mjs --no-diff       # 不做 git 对比
 *   node .claude/skills/code-flowmap/flowmap.mjs --out /tmp/x.html
 *
 * 默认的对比基线 = 上一次生成的 HTML 里记录的 commit（没有就不对比）。
 */
import ts from "typescript";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const DEFAULT_OUT = join(ROOT, "code-flow.html");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

/* ────────────────────────────── 源码范围与分组 ────────────────────────────── */

const GROUPS = [
	{ id: "boot", title: "启动与装配", sub: "进程入口 · 装配依赖 · listen · 播种", color: "#c2410c", order: 0,
		desc: "启动进程、装配依赖、listen 与播种。",
		dirs: ["src/shell"] },
	{ id: "http", title: "HTTP 接口", sub: "唯一碰 node:http 的层：路由 / 来源闸 / SSE / 静态资源", color: "#0f766e", order: 1,
		desc: "唯一碰 node:http 的层：路由、来源闸、SSE、静态资源。",
		dirs: ["src/interface/http"] },
	{ id: "app", title: "用例层 app", sub: "读快照 · 说话 · 上传 · 后台命令 · 看门狗", color: "#1d4ed8", order: 2,
		desc: "用例层：读快照、说话、上传、后台命令、看门狗。",
		dirs: ["src/app"] },
	{ id: "channel", title: "频道 channel", sub: "落盘 · 投递 · 唤醒 · 7 个工具", color: "#7c3aed", order: 3,
		desc: "消息落盘、投递、唤醒与 7 个工具。",
		dirs: ["src/core/channel"] },
	{ id: "agent", title: "一个人 agent", sub: "身份 · 提示词 · 记忆 · 技能 · 名册", color: "#be123c", order: 4,
		desc: "一个人：身份、提示词、记忆、技能、名册。",
		dirs: ["src/core/agent"] },
	{ id: "team", title: "一个团队 team", sub: "README · 团队记忆 · 自动沉淀", color: "#a16207", order: 5,
		desc: "一个团队：README、团队记忆、自动沉淀。",
		dirs: ["src/core/team"] },
	{ id: "plugin", title: "插件 plugin", sub: "清单 · 四动作 API · 加载与隔离", color: "#0e7490", order: 6,
		desc: "插件清单、四动作 API、加载与隔离。",
		dirs: ["src/core/plugin"] },
	{ id: "runtime", title: "防腐 runtime", sub: "唯一 import pi-durable / pi-ai 的地方", color: "#4d7c0f", order: 7,
		desc: "防腐层：唯一 import pi-durable / pi-ai 的地方。",
		dirs: ["src/core/runtime"] },
	{ id: "md", title: "文档流水线 md", sub: "markdown + frontmatter · 插槽 · 提示词拼段", color: "#57534e", order: 8,
		desc: "Markdown 与提示词流水线。",
		dirs: ["src/core/md"] },
	{ id: "prim", title: "根原语", sub: "两个根 · 工作区路径闸 · 名字规则", color: "#334155", order: 9,
		desc: "根原语：两个根的路径、工作区路径闸、名字规则。",
		files: ["src/core/layout.ts", "src/core/fsx.ts", "src/core/naming.ts"] },
	{ id: "view", title: "契约 view", sub: "只有 dto.ts，零 import", color: "#6d28d9", order: 10,
		desc: "契约层：只有 DTO，零 import。",
		dirs: ["src/view"] },
	{ id: "ui", title: "界面 ui", sub: "React + TypeScript，构建到 ui/web", color: "#0369a1", order: 11,
		desc: "React 界面源码。",
		dirs: ["ui/app/src"], files: ["ui/app/vite.config.ts"] },
	{ id: "desktop", title: "桌面壳 desktop", sub: "Electron：拉起后端 · 开窗 · 更新", color: "#9a3412", order: 12,
		desc: "Electron 壳：拉后端、开窗、更新。",
		dirs: ["desktop/src"] },
	{ id: "scripts", title: "脚本", sub: "边界检查 · 真模型冒烟 · 更新源与签名", color: "#52525b", order: 13,
		desc: "开发与发布脚本。",
		files: [
			"scripts/check-boundaries.mjs", "scripts/core-live.ts", "scripts/live-support.ts",
			"scripts/prompt-check.ts", "scripts/prompt-fixture.ts", "scripts/repair.ts",
			"scripts/scenario-live.ts", "scripts/update-key.ts", "scripts/update-manifest.ts",
			"scripts/update-server.ts",
		] },
	{ id: "tests", title: "测试", sub: "80 文件 / 765 例：纯函数 · 装配 · 界面源码约定", color: "#475569", order: 14,
		desc: "测试：纯函数、装配、界面源码约定。用例名在文件详情里。",
		dirs: ["test"], files: ["vitest.config.ts"] },
	{ id: "seed", title: "出厂插件 seed", sub: "随安装播种的插件后端与前端", color: "#15803d", order: 15,
		desc: "出厂插件（随安装播种）。",
		files: [
			"seed/plugins/示范/plugin.ts", "seed/plugins/示范/client.js",
			"seed/plugins/模型管理/plugin.js", "seed/plugins/模型管理/client.js",
			"seed/plugins/文件树/plugin.js", "seed/plugins/文件树/client.js",
		] },
];

/** 组内阅读顺序：先入口、再主链。不在表里的按文件名排。 */
const FILE_ORDER = {
	boot: ["src/shell/main.ts", "src/shell/serve.ts", "src/shell/assemble.ts", "src/shell/seed.ts"],
	http: [
		"src/interface/http/routes.ts", "src/interface/http/route-match.ts",
		"src/interface/http/respond.ts", "src/interface/http/origin-guard.ts",
		"src/interface/http/sse.ts", "src/interface/http/static-assets.ts",
		"src/interface/http/network.ts",
	],
	app: [
		"src/app/index.ts", "src/app/snapshot.ts", "src/app/read.ts", "src/app/project.ts",
		"src/app/trace.ts", "src/app/people.ts", "src/app/teams.ts", "src/app/chat.ts",
		"src/app/uploads.ts", "src/app/runs.ts", "src/app/watch.ts", "src/app/diag.ts",
		"src/app/models.ts", "src/app/plugins.ts", "src/app/audit.ts", "src/app/avatar.ts",
		"src/app/errors.ts", "src/app/types.ts",
	],
	channel: [
		"src/core/channel/types.ts", "src/core/channel/rules.ts", "src/core/channel/mentions.ts",
		"src/core/channel/write.ts", "src/core/channel/post.ts", "src/core/channel/dispatch.ts",
		"src/core/channel/wake.ts", "src/core/channel/queue.ts", "src/core/channel/turn/record.ts",
		"src/core/channel/turn/finish.ts", "src/core/channel/turn/index.ts", "src/core/channel/delivery.ts",
		"src/core/channel/unanswered.ts", "src/core/channel/wiring.ts", "src/core/channel/membership.ts",
		"src/core/channel/attachments.ts", "src/core/channel/jobs.ts", "src/core/channel/tools/index.ts",
		"src/core/channel/tools/context.ts", "src/core/channel/tools/say.ts", "src/core/channel/tools/chats.ts",
		"src/core/channel/tools/history.ts", "src/core/channel/tools/remember.ts", "src/core/channel/tools/hire.ts",
		"src/core/channel/tools/run.ts", "src/core/channel/tools/file.ts", "src/core/channel/tools/guards.ts",
		"src/core/channel/tools/channel-choice.ts", "src/core/channel/tools/recall.ts",
	],
	agent: [
		"src/core/agent/identity.ts", "src/core/agent/sections.ts", "src/core/agent/rules.ts",
		"src/core/agent/memory.ts", "src/core/agent/journal.ts", "src/core/agent/secrets.ts",
		"src/core/agent/skills.ts", "src/core/agent/roster.ts",
	],
	team: ["src/core/team/doc.ts", "src/core/team/memory.ts", "src/core/team/settle.ts"],
	plugin: ["src/core/plugin/manifest.ts", "src/core/plugin/api.ts", "src/core/plugin/load.ts", "src/core/plugin/index.ts"],
	runtime: ["src/core/runtime/index.ts", "src/core/runtime/open.ts", "src/core/runtime/io.ts", "src/core/runtime/models.ts", "src/core/runtime/serialize.ts"],
	md: ["src/core/md/doc.ts", "src/core/md/text.ts", "src/core/md/prompt.ts", "src/core/md/oneline.ts"],
	prim: ["src/core/layout.ts", "src/core/fsx.ts", "src/core/naming.ts"],
	view: ["src/view/dto.ts"],
	ui: [
		"ui/app/src/main.tsx", "ui/app/src/App.tsx", "ui/app/src/state/store.ts", "ui/app/src/state/useStore.ts",
		"ui/app/src/api/client.ts", "ui/app/src/api/types.ts", "ui/app/src/rows.ts",
		"ui/app/src/stream/model.ts", "ui/app/src/stream/Stream.tsx", "ui/app/src/stream/RunBlock.tsx",
		"ui/app/src/stream/AttachmentPreview.tsx", "ui/app/src/sidebar/Sidebar.tsx",
		"ui/app/src/composer/Composer.tsx", "ui/app/src/composer/choice.ts",
		"ui/app/src/panels/RightPanel.tsx", "ui/app/src/panels/Overlays.tsx",
		"ui/app/src/plugin/registry.ts", "ui/app/src/plugin/Slot.tsx",
		"ui/app/src/hooks/useStreams.ts", "ui/app/src/hooks/useToasts.ts",
		"ui/app/src/lib/avatar.ts", "ui/app/src/lib/markdown.ts", "ui/app/src/lib/format.ts",
		"ui/app/src/lib/copy-code.ts", "ui/app/src/lib/jank.ts",
	],
	desktop: [
		"desktop/src/main.ts", "desktop/src/backend.ts", "desktop/src/ready-line.ts",
		"desktop/src/updates.ts", "desktop/src/manifest.ts", "desktop/src/install.ts",
		"desktop/src/feed.ts", "desktop/src/update-key.ts", "desktop/src/menu.ts",
	],
	scripts: [
		"scripts/check-boundaries.mjs", "scripts/core-live.ts", "scripts/live-support.ts",
		"scripts/prompt-check.ts", "scripts/prompt-fixture.ts", "scripts/repair.ts",
		"scripts/scenario-live.ts", "scripts/update-key.ts", "scripts/update-manifest.ts",
		"scripts/update-server.ts",
	],
	seed: [
		"seed/plugins/示范/plugin.ts", "seed/plugins/示范/client.js",
		"seed/plugins/模型管理/plugin.js", "seed/plugins/模型管理/client.js",
		"seed/plugins/文件树/plugin.js", "seed/plugins/文件树/client.js",
	],
};

/** 目录 → 组。 */
function groupOf(path) {
	for (const g of GROUPS) {
		if (g.files?.includes(path)) return g;
		if (g.dirs?.some((d) => path.startsWith(d + "/"))) return g;
	}
	return undefined;
}

function collectFiles() {
	const all = [];
	for (const g of GROUPS) {
		let files = [];
		for (const dir of g.dirs ?? []) {
			files.push(
				...ts.sys
					.readDirectory(join(ROOT, dir), [".ts", ".tsx", ".js", ".mjs"], undefined, ["**/*"])
					.filter((abs) => (!/\.(test|spec)\./.test(abs) || g.id === "tests") && !abs.includes("node_modules"))
					.map((abs) => relative(ROOT, abs).split("\\").join("/")),
			);
		}
		files.push(...(g.files ?? []));
		files = [...new Set(files)];
		const order = FILE_ORDER[g.id] ?? [];
		const rank = (p) => {
			const i = order.indexOf(p);
			return i < 0 ? 1000 : i;
		};
		files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
		for (const f of files) {
			const abs = join(ROOT, f);
			if (existsSync(abs)) all.push({ path: f, group: g });
		}
	}
	return all;
}

/* ────────────────────────────── 文档（CODE.md）摘要 ────────────────────────────── */

function loadCodeDoc() {
	const map = new Map();
	const byBase = new Map();
	const file = join(ROOT, "docs/CODE.md");
	if (!existsSync(file)) return { map, byBase };
	const lines = readFileSync(file, "utf8").split("\n");
	for (const line of lines) {
		if (!line.startsWith("| `")) continue;
		const cells = line.split("|").map((c) => c.trim());
		if (cells.length < 4) continue;
		const first = cells[1];
		const names = [...first.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
		if (!names.length) continue;
		const desc = (cells.length >= 5 ? cells.slice(3, -1).join(" | ") : cells[2]).trim();
		if (!desc || desc === "—") continue;
		let lastDir = "src/core";
		for (const name of names) {
			let path;
			if (name.includes("/")) {
				path = name.startsWith("src/") || name.startsWith("ui/") || name.startsWith("desktop/")
					? name
					: `src/core/${name}`;
				lastDir = dirname(path);
			} else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
				path = `${lastDir}/${name}`;
			} else {
				continue;
			}
			map.set(path, desc);
			byBase.set(path.split("/").pop(), desc);
		}
	}
	return { map, byBase };
}

/* ────────────────────────────── 源码解析 ────────────────────────────── */

const printer = ts.createPrinter({ removeComments: true });
const clean = (s) => s.replace(/\r\n/g, "\n").replace(/\s+$/g, "").trim();
const stripInlineComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
const oneLine = (s) => stripInlineComments(s).replace(/\s+/g, " ").trim();

function stripComment(raw) {
	return clean(
		raw
			.replace(/^\s*\/\*\*?/, "")
			.replace(/\*\/\s*$/, "")
			.split("\n")
			.map((l) => l.replace(/^\s*\*\s?/, ""))
			.join("\n"),
	);
}

function leadingComment(sf, pos) {
	const ranges = ts.getLeadingCommentRanges(sf.text, pos) ?? [];
	if (!ranges.length) return "";
	return clean(ranges.map((r) => stripComment(sf.text.slice(r.pos, r.end))).join("\n"));
}

function jsdocOf(node) {
	const docs = ts.getJSDocCommentsAndTags(node).filter((d) => ts.isJSDoc(d));
	const text = docs
		.map((d) => (typeof d.comment === "string" ? d.comment : (d.comment ?? []).map((c) => c.text).join("")))
		.join("\n");
	return clean(text);
}

function docOf(node, sf) {
	const own = jsdocOf(node);
	if (own) return own;
	// 注释通常挂在 export / 语句上，而不是声明本身。
	const stmt = node.parent && ts.isVariableDeclaration(node) ? node.parent.parent : node;
	return leadingComment(sf, stmt.getFullStart());
}

function fileDoc(sf) {
	return leadingComment(sf, 0);
}

function shortOf(text) {
	if (!text) return "";
	const flat = text.replace(/\s+/g, " ").replace(/`/g, "").replace(/\*\*/g, "").trim();
	const stop = flat.indexOf("。");
	let s = stop >= 0 && stop <= 72 ? flat.slice(0, stop + 1) : flat;
	if (s.length > 72) s = s.slice(0, 71) + "…";
	return s;
}

function typeText(node, sf) {
	return node ? oneLine(node.getText(sf)) : "";
}

function signatureOf(node, sf) {
	const cut = (start, end) => oneLine(sf.text.slice(start, end)).replace(/\s*\{\s*$/, "");
	if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) {
		const name = node.name ? node.name.getText(sf) : "";
		const params = (node.parameters ?? []).map((p) => oneLine(p.getText(sf))).join(", ");
		const ret = typeText(node.type, sf);
		const fn = ts.isFunctionDeclaration(node) ? "function " : "";
		return `${fn}${name}(${params})${ret ? `: ${ret}` : ""}`.trim();
	}
	if (ts.isArrowFunction(node)) {
		const params = node.parameters.map((p) => oneLine(p.getText(sf))).join(", ");
		const ret = typeText(node.type, sf);
		return `(${params})${ret ? `: ${ret}` : ""} => …`;
	}
	if (ts.isClassDeclaration(node)) {
		return `class ${node.name?.getText(sf) ?? "(anonymous)"}`;
	}
	if (ts.isConstructorDeclaration(node)) {
		const params = (node.parameters ?? []).map((p) => oneLine(p.getText(sf))).join(", ");
		return `constructor(${params})`;
	}
	if (ts.isVariableDeclaration(node)) {
		return signatureOf(node.initializer, sf);
	}
	if (ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) {
		const init = node.initializer;
		return init ? signatureOf(init, sf) : "";
	}
	return oneLine(node.getText(sf)).slice(0, 120);
}

function callsOf(node, sf) {
	const names = new Set();
	const visit = (n) => {
		if (ts.isCallExpression(n)) {
			const e = n.expression;
			if (ts.isIdentifier(e)) names.add(e.text);
			else if (ts.isPropertyAccessExpression(e)) names.add(e.name.text);
		}
		ts.forEachChild(n, visit);
	};
	if (node.body) ts.forEachChild(node.body, visit);
	return [...names].filter((n) => !["if", "for", "while", "switch", "catch", "return", "require"].includes(n)).slice(0, 24);
}

const kindLabel = { function: "函数", class: "类", method: "方法", constructor: "构造", get: "getter", set: "setter", object: "常量对象", file: "文件", group: "模块", root: "根" };

let idSeq = 0;
const nextId = (prefix) => `${prefix}${(++idSeq).toString(36)}`;

function lineOf(sf, node) {
	return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function symbolNode(node, sf, filePath, kind, opts = {}) {
	const name = opts.name ?? (node.name ? node.name.getText(sf) : kind === "constructor" ? "constructor" : "(匿名)");
	const doc = opts.doc ?? docOf(node, sf);
	const sig = opts.sig ?? signatureOf(node, sf);
	const line = lineOf(sf, node);
	const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
	const sym = {
		id: nextId("n"),
		kind,
		name,
		summary: shortOf(doc) || fallbackSummary(kind, node, sf, opts),
		doc,
		sig,
		line,
		endLine: end,
		calls: opts.calls ?? callsOf(node, sf),
		children: [],
	};
	Object.defineProperties(sym, {
		_ast: { value: node, enumerable: false },
		_sf: { value: sf, enumerable: false },
		_file: { value: filePath, enumerable: false },
	});
	return sym;
}

function fallbackSummary(kind, node, sf, opts) {
	if (kind === "function") {
		const async = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
		const ret = typeText(node.type, sf);
		return `${async ? "异步" : ""}函数${ret ? `，返回 ${ret}` : ""}（源码无注释）`;
	}
	if (kind === "class") return `类${opts.methodCount ? `，${opts.methodCount} 个成员` : ""}（源码无注释）`;
	if (kind === "method") return `类方法（源码无注释）`;
	if (kind === "constructor") return "构造函数（源码无注释）";
	if (kind === "object") return `常量对象，${opts.methodCount ?? 0} 个方法（源码无注释）`;
	return "（源码无注释）";
}

function analyzeFile(filePath, text) {
	const kind = filePath.endsWith(".tsx")
		? ts.ScriptKind.TSX
		: filePath.endsWith(".js") || filePath.endsWith(".mjs")
			? ts.ScriptKind.JS
			: ts.ScriptKind.TS;
	const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, kind);
	const doc = fileDoc(sf);
	const symbols = [];
	const types = [];
	const imports = [];
	const cases = [];
	const importMap = new Map(); // 本地名 → { path, imported }
	const nsImports = new Map(); // 命名空间别名 → path
	const reexports = new Map(); // 导出名 → { path, imported } | { path, star: true }

	const addImports = (stmt) => {
		if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
			const spec = stmt.moduleSpecifier.text;
			if (!spec.startsWith(".")) return;
			const target = resolveImport(filePath, spec);
			if (!target) return;
			imports.push(target);
			const bindings = stmt.importClause?.namedBindings;
			if (bindings && ts.isNamedImports(bindings)) {
				for (const b of bindings.elements) {
					const local = b.name.text;
					const imported = b.propertyName?.text ?? local;
					importMap.set(local, { path: target, imported });
				}
			} else if (bindings && ts.isNamespaceImport(bindings)) {
				nsImports.set(bindings.name.text, target);
			}
			return;
		}
		if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
			const spec = stmt.moduleSpecifier.text;
			if (!spec.startsWith(".")) return;
			const target = resolveImport(filePath, spec);
			if (!target) return;
			imports.push(target);
			if (!stmt.exportClause) {
				reexports.set("*", { path: target, star: true });
			} else if (ts.isNamedExports(stmt.exportClause)) {
				for (const e of stmt.exportClause.elements) {
					reexports.set(e.name.text, { path: target, imported: e.propertyName?.text ?? e.name.text });
				}
			}
		}
	};

	for (const stmt of sf.statements) {
		addImports(stmt);
		if (ts.isFunctionDeclaration(stmt) && stmt.name) {
			symbols.push(symbolNode(stmt, sf, filePath, "function"));
			continue;
		}
		if (ts.isClassDeclaration(stmt) && stmt.name) {
			const cls = symbolNode(stmt, sf, filePath, "class", { sig: `class ${stmt.name.getText(sf)}` });
			cls.doc = docOf(stmt, sf);
			cls.summary = shortOf(cls.doc) || fallbackSummary("class", stmt, sf, { methodCount: stmt.members.length });
			const className = stmt.name.getText(sf);
			for (const m of stmt.members) {
				if (ts.isMethodDeclaration(m)) {
					const memberKind = m.modifiers?.some((x) => x.kind === ts.SyntaxKind.GetKeyword)
						? "get"
						: m.modifiers?.some((x) => x.kind === ts.SyntaxKind.SetKeyword)
							? "set"
							: "method";
					const child = symbolNode(m, sf, filePath, memberKind);
					Object.defineProperty(child, "_class", { value: className, enumerable: false });
					cls.children.push(child);
				} else if (ts.isConstructorDeclaration(m)) {
					const child = symbolNode(m, sf, filePath, "constructor");
					Object.defineProperty(child, "_class", { value: className, enumerable: false });
					cls.children.push(child);
				}
			}
			symbols.push(cls);
			continue;
		}
		if (ts.isVariableStatement(stmt)) {
			for (const decl of stmt.declarationList.declarations) {
				if (!decl.name || !ts.isIdentifier(decl.name)) continue;
				const init = decl.initializer;
				if (!init) continue;
				if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
					const fn = symbolNode(init, sf, filePath, "function", {
						name: decl.name.getText(sf),
						doc: docOf(decl, sf),
						sig: `const ${decl.name.getText(sf)} = ${signatureOf(init, sf)}`,
					});
					fn.line = lineOf(sf, decl);
					fn.endLine = sf.getLineAndCharacterOfPosition(decl.getEnd()).line + 1;
					symbols.push(fn);
				} else if (ts.isObjectLiteralExpression(init)) {
					const methods = [];
					for (const prop of init.properties) {
						if (ts.isMethodDeclaration(prop) && prop.name) {
							methods.push(symbolNode(prop, sf, filePath, "method"));
						} else if (ts.isPropertyAssignment(prop) && prop.name && (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer))) {
							const m = symbolNode(prop.initializer, sf, filePath, "method", {
								name: prop.name.getText(sf),
								doc: docOf(prop, sf),
								sig: `${prop.name.getText(sf)} = ${signatureOf(prop.initializer, sf)}`,
							});
							m.line = lineOf(sf, prop);
							methods.push(m);
						}
					}
					if (methods.length) {
						const obj = symbolNode(decl, sf, filePath, "object", {
							name: decl.name.getText(sf),
							doc: docOf(decl, sf),
							sig: `const ${decl.name.getText(sf)} = { … ${methods.length} 个方法 }`,
							methodCount: methods.length,
							calls: [],
						});
						obj.line = lineOf(sf, decl);
						obj.children = methods;
						obj.summary = shortOf(obj.doc) || fallbackSummary("object", decl, sf, { methodCount: methods.length });
						symbols.push(obj);
					}
				}
			}
			continue;
		}
		if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
			types.push({ name: stmt.name.getText(sf), kind: ts.SyntaxKind[stmt.kind].replace("Declaration", ""), line: lineOf(sf, stmt), doc: shortOf(docOf(stmt, sf)) });
		}
	}

	// 测试用例名：it / test 的第一个字符串参数（describe 只当分组，不单独列）。
	const visitTests = (n) => {
		if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === "it" || n.expression.text === "test")) {
			const a = n.arguments[0];
			if (a && ts.isStringLiteralLike(a)) {
				cases.push({ name: a.text, line: lineOf(sf, n) });
			}
		}
		ts.forEachChild(n, visitTests);
	};
	for (const stmt of sf.statements) visitTests(stmt);

	return {
		path: filePath,
		sf,
		doc,
		symbols,
		types,
		cases,
		importMap,
		nsImports,
		reexports,
		imports: [...new Set(imports)],
		lines: text.split("\n").length,
	};
}

function resolveImport(from, spec) {
	const base = resolve(ROOT, dirname(from), spec);
	const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}/index.ts`];
	for (const c of candidates) {
		const rel = relative(ROOT, c);
		if (existsSync(c) && !rel.startsWith("..")) return rel;
	}
	return undefined;
}

/* ────────────────────────────── 调用流程 ────────────────────────────── */

const FLOWS = [
	{ id: "boot", title: "启动进程", desc: "main → 读两个根 → 播种 → 装配 → 开服务", file: "src/shell/main.ts", name: "main" },
	{ id: "assemble", title: "装配", desc: "扫文件夹 → 装插件 → 开会话 → 绑名册 → 播种全员频道", file: "src/shell/assemble.ts", name: "assembleCore" },
	{ id: "http", title: "HTTP 请求", desc: "来源闸 → 匹配路由 → 用例 → 响应 / SSE", file: "src/shell/serve.ts", name: "serveCore" },
	{ id: "owner", title: "我发一条消息", desc: "ownerSpeak → postMessage → 落盘 → 投递 → 叫醒", file: "src/shell/assemble.ts", name: "ownerSpeak" },
	{ id: "post", title: "写一条 + 叫醒", desc: "appendToChannel → deliver → wake → 收尾", file: "src/core/channel/post.ts", name: "postMessage" },
	{ id: "wake", title: "叫醒一个人", desc: "合并排队项 → 记两层 wake → 提交 → 结算收尾", file: "src/core/channel/wake.ts", name: "wake" },
	{ id: "deliver", title: "投递到会话", desc: "逐条投递、合并唤醒、失败通报", file: "src/core/channel/dispatch.ts", name: "deliver" },
	{ id: "say", title: "模型用 say", desc: "选频道 → 落 kind/options → postMessage", file: "src/core/channel/tools/say.ts", name: "createSayTool" },
	{ id: "settle", title: "团队沉淀", desc: "取候选 → 问模型 → 写团队记忆", file: "src/core/team/settle.ts", name: "settleTeam" },
	{ id: "ui", title: "界面启动", desc: "main.tsx 顶层：装样式 → bootstrap → 装插件 → 挂 App", file: "ui/app/src/main.tsx" },
	{ id: "desktop", title: "桌面启动", desc: "main.ts 顶层：定两个根 → 单实例锁 → 拉后端 → 开窗 → 更新", file: "desktop/src/main.ts" },
];

const MAX_FLOW_DEPTH = 7;
const MAX_FLOW_NODES = 700;

let stepSeq = 0;
const nextStepId = () => `s${(++stepSeq).toString(36)}`;

const BUILTINS = new Set([
	"console", "JSON", "Object", "Array", "String", "Number", "Boolean", "Math", "Date", "Promise", "Set", "Map",
	"WeakMap", "Error", "parseInt", "parseFloat", "isNaN", "setTimeout", "setInterval", "clearTimeout",
	"clearInterval", "fetch", "URL", "URLSearchParams", "Buffer", "process", "require", "structuredClone",
	"crypto", "TextEncoder", "TextDecoder", "Intl", "RegExp", "Symbol", "BigInt", "Reflect", "Proxy",
	"queueMicrotask", "encodeURIComponent", "decodeURIComponent", "atob", "btoa", "if", "for", "while",
	"switch", "catch", "return", "throw", "super", "import",
]);

function clipCond(node, sf, max = 44) {
	const text = oneLine(node.getText(sf));
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildIndexes(analyses) {
	const byFile = new Map();
	const byName = new Map();
	const byId = new Map();
	const methods = new Map();
	const addName = (name, sym) => {
		if (!byName.has(name)) byName.set(name, []);
		byName.get(name).push(sym);
	};
	for (const [path, a] of analyses) {
		const local = new Map();
		for (const s of a.symbols) {
			local.set(s.name, s);
			byId.set(s.id, s);
			addName(s.name, s);
			for (const c of s.children ?? []) {
				byId.set(c.id, c);
				addName(c.name, c);
				if (s.kind === "class") methods.set(`${s.name}.${c.name}`, c);
			}
		}
		byFile.set(path, local);
	}
	return { byFile, byName, byId, methods };
}

function lookupInFile(analyses, byFile, path, name, seen = new Set()) {
	if (!path || !name) return undefined;
	const key = `${path}:${name}`;
	if (seen.has(key)) return undefined;
	seen.add(key);
	const direct = byFile.get(path)?.get(name);
	if (direct) return direct;
	const a = analyses.get(path);
	const re = a?.reexports.get(name);
	if (re) {
		if (re.star) return undefined;
		return lookupInFile(analyses, byFile, re.path, re.imported, seen);
	}
	const star = a?.reexports.get("*");
	if (star) return lookupInFile(analyses, byFile, star.path, name, seen);
	return undefined;
}

function resolveCallee(desc, sym, analysis, indexes, analyses) {
	const local = indexes.byFile.get(analysis.path) ?? new Map();
	if (desc.thisCall && sym._class) return indexes.methods.get(`${sym._class}.${desc.name}`);
	if (desc.receiver) {
		const ns = analysis.nsImports.get(desc.receiver);
		if (ns) return lookupInFile(analyses, indexes.byFile, ns, desc.name);
		const obj = local.get(desc.receiver);
		if (obj?.kind === "object") return (obj.children ?? []).find((c) => c.name === desc.name);
		if (obj) return undefined;
	} else {
		const own = local.get(desc.name);
		if (own) return own;
		const imp = analysis.importMap.get(desc.name);
		if (imp) return lookupInFile(analyses, indexes.byFile, imp.path, imp.imported);
	}
	// 只回退到「同一个文件里唯一同名」；不做全局同名猜测（会连到测试文件里的同名函数）。
	const localMatches = [...local.values()].filter((s) => s.name === desc.name);
	return localMatches.length === 1 ? localMatches[0] : undefined;
}

// 这些名字是集合 / 字符串 / Promise / DOM 的方法，不是仓库里的流程节点。
const METHOD_NOISE = new Set([
	"push", "pop", "shift", "unshift", "map", "filter", "reduce", "reduceRight", "forEach", "find", "findIndex",
	"some", "every", "includes", "indexOf", "lastIndexOf", "join", "split", "slice", "splice", "sort", "reverse",
	"concat", "flat", "flatMap", "fill", "keys", "values", "entries", "has", "get", "set", "add", "delete",
	"clear", "then", "catch", "finally", "toString", "toJSON", "toISOString", "replace", "replaceAll", "trim",
	"trimStart", "trimEnd", "startsWith", "endsWith", "toLowerCase", "toUpperCase", "padStart", "padEnd",
	"match", "matchAll", "test", "exec", "on", "once", "emit", "off", "end", "pipe", "resume", "pause",
	"write", "read", "close", "destroy", "appendChild", "removeChild", "querySelector", "querySelectorAll",
	"getElementById", "addEventListener", "removeEventListener", "preventDefault", "stopPropagation", "focus",
	"blur", "scrollTo", "scrollIntoView", "setAttribute", "getAttribute", "removeAttribute", "classList",
	"click", "submit", "reset", "load", "save", "send", "json", "text", "arrayBuffer", "abort", "log",
]);

function collectSites(root, sf, analysis, symLike, indexes, analyses, opts = {}) {
	const sites = [];
	const seen = new Set();
	const params = new Set(
		(symLike._ast?.parameters ?? [])
			.map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : undefined))
			.filter(Boolean),
	);
	const record = (call, conds) => {
		const expr = call.expression;
		let desc;
		if (ts.isIdentifier(expr)) desc = { name: expr.text, receiver: undefined, thisCall: false };
		else if (ts.isPropertyAccessExpression(expr)) {
			desc = {
				name: expr.name.text,
				receiver: ts.isIdentifier(expr.expression) ? expr.expression.text : undefined,
				thisCall: expr.expression.kind === ts.SyntaxKind.ThisKeyword,
			};
		} else return;
		if (BUILTINS.has(desc.name) || METHOD_NOISE.has(desc.name)) return;
		const callee = resolveCallee(desc, symLike, analysis, indexes, analyses);
		// 没解析出来时只留两类：函数参数上的注入依赖（deps.foo），以及外部导入的函数（foo）。
		const external = !callee && (desc.receiver ? params.has(desc.receiver) || desc.thisCall : true);
		if (!callee && !external) return;
		const key = callee ? callee.id : `?${desc.name}`;
		if (seen.has(key)) return;
		seen.add(key);
		sites.push({
			name: desc.name,
			calleeId: callee?.id,
			line: lineOf(sf, call),
			condition: conds.join(" · "),
			order: sites.length + 1,
		});
	};
	const visit = (n, conds) => {
		if (opts.shallow && (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n))) return;
		if (ts.isCallExpression(n)) record(n, conds);
		if (ts.isIfStatement(n)) {
			visit(n.expression, conds);
			visit(n.thenStatement, [...conds, `当 ${clipCond(n.expression, sf)}`]);
			if (n.elseStatement) visit(n.elseStatement, [...conds, "否则"]);
			return;
		}
		if (ts.isConditionalExpression(n)) {
			visit(n.condition, conds);
			visit(n.whenTrue, [...conds, `当 ${clipCond(n.condition, sf)}`]);
			visit(n.whenFalse, [...conds, "否则"]);
			return;
		}
		if (ts.isSwitchStatement(n)) {
			visit(n.expression, conds);
			for (const c of n.caseBlock.clauses) {
				const label = ts.isCaseClause(c) ? `case ${clipCond(c.expression, sf)}` : "default";
				visit(c, [...conds, label]);
			}
			return;
		}
		if (ts.isCatchClause(n)) {
			if (n.variable) visit(n.variable, conds);
			visit(n.block, [...conds, "出错时"]);
			return;
		}
		if (ts.isTryStatement(n)) {
			visit(n.tryBlock, conds);
			if (n.catchClause) visit(n.catchClause, conds);
			if (n.finallyBlock) visit(n.finallyBlock, [...conds, "收尾"]);
			return;
		}
		ts.forEachChild(n, (c) => visit(c, conds));
	};
	visit(root, []);
	return sites;
}

function callSitesOf(sym, analysis, indexes, analyses) {
	const ast = sym._ast;
	const body = ast?.body;
	if (!body) return [];
	return collectSites(body, sym._sf, analysis, sym, indexes, analyses);
}

function fileCallSites(analysis, indexes, analyses) {
	return collectSites(analysis.sf, analysis.sf, analysis, { _ast: analysis.sf, _file: analysis.path }, indexes, analyses, { shallow: true });
}

function buildFlows(analyses) {
	const indexes = buildIndexes(analyses);
	for (const a of analyses.values()) {
		for (const s of a.symbols) {
			for (const sym of [s, ...(s.children ?? [])]) {
				if (sym.kind === "class" || sym.kind === "object") continue;
				Object.defineProperty(sym, "_sites", { value: callSitesOf(sym, a, indexes, analyses), enumerable: false });
			}
		}
	}

	const flows = [];
	for (const def of FLOWS) {
		const analysis = analyses.get(def.file);
		if (!analysis) continue;
		let sym;
		let sites;
		let entryName;
		let line = 1;
		let doc = analysis.doc;
		let sig = `${analysis.lines} 行 · 顶层执行`;
		let calls = [];
		if (def.name) {
			sym = lookupInFile(analyses, indexes.byFile, def.file, def.name);
			if (!sym) continue;
			sites = sym._sites ?? [];
			entryName = sym.name;
			line = sym.line;
			doc = sym.doc;
			sig = sym.sig;
			calls = sym.calls;
		} else {
			sites = fileCallSites(analysis, indexes, analyses);
			entryName = "文件顶层";
		}
		const budget = { n: MAX_FLOW_NODES };
		const root = {
			id: nextStepId(),
			kind: "flowroot",
			symbolId: sym?.id ?? `file:${def.file}`,
			name: def.title,
			entry: entryName,
			file: def.file,
			line,
			group: groupOf(def.file)?.id,
			summary: def.desc,
			doc,
			sig,
			step: 0,
			condition: "",
			calls,
			children: [],
		};
		const stack = new Set(sym ? [sym.id] : []);
		expandSites(root, sites, stack, 0, budget, indexes);
		flows.push({ id: def.id, title: def.title, desc: def.desc, count: countFlow(root), root });
	}
	return flows;
}

function expandSites(node, sites, stack, depth, budget, indexes) {
	if (depth >= MAX_FLOW_DEPTH) {
		if (sites.some((s) => s.calleeId)) node.note = "更深的调用已省略";
		return;
	}
	const seen = new Set();
	for (const site of sites) {
		if (!site.calleeId) {
			const key = `?${site.name}`;
			if (seen.has(key)) continue;
			seen.add(key);
			if (budget.n <= 0) {
				node.note = "已到节点上限，后续省略";
				return;
			}
			budget.n--;
			node.children.push({
				id: nextStepId(),
				kind: "step",
				name: site.name,
				file: "",
				group: node.group,
				summary: `未解析的调用：${site.name}（注入依赖 / 外部模块）`,
				doc: "",
				sig: "",
				step: site.order,
				condition: site.condition,
				external: true,
				note: "未解析（注入依赖 / 外部模块）",
				children: [],
			});
			continue;
		}
		const callee = indexes.byId.get(site.calleeId);
		if (!callee || seen.has(callee.id)) continue;
		seen.add(callee.id);
		const repeat = stack.has(callee.id);
		if (budget.n <= 0) {
			node.note = "已到节点上限，后续省略";
			return;
		}
		budget.n--;
		const child = {
			id: nextStepId(),
			kind: "step",
			symbolId: callee.id,
			name: callee.name,
			file: callee._file,
			line: callee.line,
			group: groupOf(callee._file)?.id,
			summary: callee.summary,
			doc: callee.doc,
			sig: callee.sig,
			step: site.order,
			condition: site.condition,
			repeat,
			note: repeat ? "已在上游展开（递归 / 回环）" : "",
			calls: callee.calls,
			children: [],
		};
		node.children.push(child);
		if (!repeat) expandSites(child, callee._sites ?? [], new Set([...stack, callee.id]), depth + 1, budget, indexes);
	}
}

function countFlow(node) {
	let n = 1;
	for (const c of node.children ?? []) n += countFlow(c);
	return n;
}

/* ────────────────────────────── 建树 ────────────────────────────── */

function build() {
	const { map: codeDoc, byBase: docByBase } = loadCodeDoc();
	const files = collectFiles();
	const fileNodes = new Map();
	const analyses = new Map();
	const allFiles = new Set(files.map((f) => f.path));

	for (const { path, group } of files) {
		const text = readFileSync(join(ROOT, path), "utf8");
		const a = analyzeFile(path, text);
		analyses.set(path, a);
		const docFromTable = codeDoc.get(path) ?? docByBase.get(path.split("/").pop()) ?? "";
		const caseHint = a.cases.length ? `测试文件，${a.cases.length} 个用例。` : "";
		const summary = shortOf(docFromTable) || caseHint || shortOf(a.doc) || `${group.desc}`;
		const detail = [docFromTable, docFromTable && a.doc ? "" : "", a.doc].filter(Boolean).join("\n\n");
		const node = {
			id: nextId("f"),
			kind: "file",
			name: path.split("/").pop(),
			path,
			dir: dirname(path).replace(/^src\/core\//, "").replace(/^src\//, ""),
			group: group.id,
			summary,
			doc: detail,
			sig: `${a.lines} 行 · ${a.symbols.length} 个顶层声明 · ${a.types.length} 个类型`,
			line: 1,
			imports: a.imports.filter((p) => allFiles.has(p)),
			types: a.types,
			cases: a.cases,
			children: a.symbols,
		};
		fileNodes.set(path, node);
	}

	// 被依赖（反向）
	const importedBy = new Map();
	for (const node of fileNodes.values()) {
		for (const imp of node.imports) {
			if (!importedBy.has(imp)) importedBy.set(imp, []);
			importedBy.get(imp).push(node.path);
		}
	}
	for (const node of fileNodes.values()) node.importedBy = importedBy.get(node.path) ?? [];

	const groups = GROUPS.map((g) => {
		const kids = files.filter((f) => f.group.id === g.id).map((f) => fileNodes.get(f.path));
		return {
			id: `g-${g.id}`,
			kind: "group",
			name: g.title,
			group: g.id,
			sub: g.sub,
			summary: g.desc,
			doc: g.desc,
			color: g.color,
			children: kids,
		};
	}).filter((g) => g.children.length);

	const root = {
		id: "root",
		kind: "root",
		name: "Solo",
		sub: "我 + 一个 AI 团队的多人 agent 运行时",
		summary: "从进程入口到落盘：启动 → 接口 → 用例 → 领域 → 原语；右侧是界面、桌面、脚本与出厂插件。",
		doc: "",
		children: groups,
	};

	const flows = buildFlows(analyses);
	return { root, fileNodes, flows };
}

function countNodes(node, acc = { files: 0, symbols: 0, methods: 0, groups: 0 }) {
	if (node.kind === "file") acc.files++;
	else if (node.kind === "group") acc.groups++;
	else if (node.kind === "function" || node.kind === "class" || node.kind === "object") acc.symbols++;
	else if (["method", "constructor", "get", "set"].includes(node.kind)) acc.methods++;
	for (const c of node.children ?? []) countNodes(c, acc);
	return acc;
}

/* ────────────────────────────── git 与增量 ────────────────────────────── */

function git(cmdArgs) {
	try {
		return execFileSync("git", cmdArgs, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

function gitInfo() {
	const sha = git(["rev-parse", "HEAD"]);
	const subject = git(["log", "-1", "--format=%s"]);
	const dirty = git(["status", "--porcelain", "--", "src", "ui/app", "desktop/src", "scripts", "seed"]).length > 0;
	return { sha, subject, dirty };
}

function previousPin(outPath) {
	if (!existsSync(outPath)) return "";
	const html = readFileSync(outPath, "utf8");
	return html.match(/<meta name="flowmap-pin" content="([0-9a-f]+)"/)?.[1] ?? "";
}

function applyDiff(root, fileNodes, base) {
	if (!base) return { base: "", addedFiles: 0, modifiedFiles: 0, removedFiles: 0, addedSymbols: 0, modifiedSymbols: 0, removedSymbols: 0, removed: [] };
	const changed = git(["diff", "--name-status", base, "HEAD", "--", "src", "ui/app", "desktop/src", "scripts", "seed"])
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t"));
	const stats = { base, addedFiles: 0, modifiedFiles: 0, removedFiles: 0, addedSymbols: 0, modifiedSymbols: 0, removedSymbols: 0, removed: [] };
	for (const [status, path] of changed) {
		const node = fileNodes.get(path);
		if (status === "A") {
			stats.addedFiles++;
			if (node) {
				node.status = "added";
				markAll(node, "added");
			}
		} else if (status === "D") {
			stats.removedFiles++;
			stats.removed.push({ file: path, name: path.split("/").pop(), kind: "file" });
		} else if (status === "M" || status.startsWith("R")) {
			stats.modifiedFiles++;
			if (!node) continue;
			const oldText = git(["show", `${base}:${path}`]);
			if (!oldText) { node.status = "modified"; continue; }
			const oldA = analyzeFile(path, oldText);
			const oldMap = new Map();
			for (const s of oldA.symbols) {
				oldMap.set(`${s.kind}:${s.name}`, s);
				for (const c of s.children ?? []) oldMap.set(`${s.kind}:${s.name}:${c.name}`, c);
			}
			let changedAny = false;
			const visit = (n, parent) => {
				if (!["function", "class", "object", "method", "constructor", "get", "set"].includes(n.kind)) return;
				const key = `${n.kind}:${n.name}`;
				const old = oldMap.get(key);
				if (!old) {
					n.status = "added";
					stats.addedSymbols++;
					changedAny = true;
				} else if (normalizeSig(old.sig) !== normalizeSig(n.sig) || (old.doc ?? "") !== (n.doc ?? "")) {
					n.status = "modified";
					stats.modifiedSymbols++;
					changedAny = true;
				}
				for (const c of n.children ?? []) visit(c, n);
			};
			for (const s of node.children) visit(s, node);
			// 删掉的符号
			const nowKeys = new Set();
			for (const s of node.children) {
				nowKeys.add(`${s.kind}:${s.name}`);
				for (const c of s.children ?? []) nowKeys.add(`${s.kind}:${s.name}:${c.name}`);
			}
			for (const [key, s] of oldMap) {
				if (!nowKeys.has(key)) {
					stats.removedSymbols++;
					stats.removed.push({ file: path, name: s.name, kind: s.kind });
				}
			}
			node.status = changedAny ? "modified" : node.status;
		}
	}
	return stats;
}

const normalizeSig = (s) => (s ?? "").replace(/\s+/g, "");

function markAll(node, status) {
	for (const c of node.children ?? []) {
		c.status = status;
		markAll(c, status);
	}
}

/* ────────────────────────────── 输出 ────────────────────────────── */

function main() {
	const built = build();
	const counts = countNodes(built.root);
	const pin = gitInfo();
	const outPath = valueOf("--out") ?? DEFAULT_OUT;

	if (flag("--stats")) {
		console.log(JSON.stringify({ ...counts, pin: pin.sha, subject: pin.subject, files: counts.files }, null, 2));
		if (flag("--sample")) {
			for (const g of built.root.children) {
				for (const f of g.children) {
					console.log(`\n## ${f.path} — ${f.summary}`);
					for (const s of f.children) {
						console.log(`  [${s.kind}] ${s.name} — ${s.summary}  (${s.sig})`);
						for (const m of s.children ?? []) console.log(`      [${m.kind}] ${m.name} — ${m.summary}`);
					}
				}
			}
		}
		return;
	}

	let base = "";
	if (!flag("--no-diff")) base = valueOf("--base") ?? previousPin(outPath);
	const diff = base && pin.sha && base !== pin.sha ? applyDiff(built.root, built.fileNodes, base) : { base: "", addedFiles: 0, modifiedFiles: 0, removedFiles: 0, addedSymbols: 0, modifiedSymbols: 0, removedSymbols: 0, removed: [] };

	const payload = {
		root: built.root,
		flows: built.flows,
		groups: GROUPS.map(({ id, title, color }) => ({ id, title, color })),
		meta: {
			pin: pin.sha,
			short: pin.sha.slice(0, 7),
			subject: pin.subject,
			dirty: pin.dirty,
			generatedAt: new Date().toISOString().slice(0, 10),
			base: diff.base ? diff.base.slice(0, 7) : "",
			diff,
			counts,
			repo: "Solo",
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
		.replace("__FLOWMAP_JSON__", () => json);
	writeFileSync(outPath, html);
	console.log(`已生成 ${relative(ROOT, outPath)}`);
	console.log(`  commit ${payload.meta.short} ${payload.meta.subject}`);
	console.log(`  ${counts.files} 文件 · ${counts.symbols} 顶层声明 · ${counts.methods} 方法 · ${counts.groups} 模块`);
	console.log(`  ${built.flows.length} 条流程：${built.flows.map((f) => `${f.title} ${f.count} 步`).join(" · ")}`);
	if (diff.base) console.log(`  自 ${diff.base.slice(0, 7)}：+${diff.addedFiles} 文件 ~${diff.modifiedFiles} 文件 -${diff.removedFiles} 文件；+${diff.addedSymbols} / ~${diff.modifiedSymbols} / -${diff.removedSymbols} 声明`);
}

main();
