/**
 * 多语言源码档案。
 *
 * 这里不依赖任何第三方解析器：每种语言给一组「声明 / 调用 / 注释」正则，
 * 再用括号、缩进或 `end` 找块的范围。目标不是编译器级精确，而是把
 * 「文件 → 类 / 函数 / 方法」和「函数里调了谁、在什么条件下调」画出来。
 *
 * 新增一种语言：在 PROFILES 里加一项，声明正则必须把名字放在第 1 个捕获组。
 */

const RESERVED = new Set([
	"if", "else", "elif", "elsif", "elseif", "for", "foreach", "while", "do", "switch", "match", "case", "when",
	"try", "catch", "except", "rescue", "finally", "ensure", "return", "throw", "raise", "yield", "await",
	"function", "func", "fn", "fun", "def", "defp", "defmodule", "class", "struct", "interface", "trait",
	"enum", "impl", "module", "namespace", "package", "import", "export", "from", "use", "using", "require",
	"include", "delete", "sizeof", "typeof", "instanceof", "in", "of", "is", "as", "with", "super",
	"this", "self", "constructor", "static", "public", "private", "protected", "internal", "open", "final",
	"abstract", "override", "virtual", "async", "await", "let", "const", "var", "type", "typedef", "void",
	"int", "char", "float", "double", "bool", "boolean", "string", "long", "short", "byte", "unsigned",
	"signed", "auto", "template", "typename", "operator", "lambda", "where", "select", "and", "or", "not",
	"begin", "end", "then", "unless", "until", "loop", "break", "continue", "pass", "goto", "extern",
]);

const CONTROL = [
	{ re: /^(?:else\s+if|elif|elsif|elseif)\b\s*(.*)$/i, kind: "elif" },
	{ re: /^else\b/i, kind: "else" },
	{ re: /^(?:if|unless)\b\s*(.*)$/i, kind: "if" },
	{ re: /^(?:switch|match)\b\s*(.*)$/i, kind: "switch" },
	{ re: /^(?:case|when)\b\s*(.*)$/i, kind: "case" },
	{ re: /^(?:catch|except|rescue)\b\s*(.*)$/i, kind: "catch" },
	{ re: /^(?:finally|ensure)\b/i, kind: "finally" },
	{ re: /^(?:for|foreach|while|until|loop)\b\s*(.*)$/i, kind: "loop" },
];

/* ────────────────────────────── 语言档案 ────────────────────────────── */

const js = {
	id: "javascript", title: "JavaScript", exts: [".js", ".jsx", ".mjs", ".cjs"],
	block: "brace", lineComments: ["//"], blockComments: [["/*", "*/"]], quotes: ['"', "'", "`"],
	classes: [{ re: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" }],
	types: [
		{ re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
		{ re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: "type" },
		{ re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
	],
	objects: [{ re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{/, kind: "object" }],
	functions: [
		{ re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, kind: "function" },
		{ re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: "function" },
		{ re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function\b/, kind: "function" },
	],
	methods: [{ re: /^\s*(?:(?:public|private|protected|static|async|readonly|get|set|override|abstract)\s+)*([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?::[^{]+)?\{/, kind: "method" }],
};

const ts = {
	...js, id: "typescript", title: "TypeScript", exts: [".ts", ".tsx", ".mts", ".cts"],
};

const python = {
	id: "python", title: "Python", exts: [".py", ".pyw"],
	block: "indent", lineComments: ["#"], blockComments: [['"""', '"""'], ["'''", "'''"]], quotes: ['"', "'"], docstring: true,
	classes: [{ re: /^\s*class\s+([A-Za-z_]\w*)\s*[(:]/, kind: "class" }],
	functions: [{ re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, kind: "function" }],
	methods: [],
};

const go = {
	id: "go", title: "Go", exts: [".go"],
	block: "brace", lineComments: ["//"], blockComments: [["/*", "*/"]], quotes: ['"', "`"],
	classes: [],
	types: [{ re: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, kind: "struct" }],
	functions: [{ re: /^\s*func\s+(?:\(([^)]*)\)\s*)?([A-Za-z_]\w*)\s*\(/, kind: "function", nameGroup: 2, receiverGroup: 1 }],
	methods: [],
};

const rust = {
	id: "rust", title: "Rust", exts: [".rs"],
	block: "brace", lineComments: ["//"], blockComments: [["/*", "*/"]], quotes: ['"'],
	classes: [
		{ re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?impl(?:<[^>]*>)?\s+(?:[A-Za-z_]\w*\s+for\s+)?([A-Za-z_]\w*)/, kind: "impl" },
	],
	types: [
		{ re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
		{ re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
		{ re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: "trait" },
	],
	functions: [{ re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" }],
	methods: [],
};

const java = {
	id: "java", title: "Java", exts: [".java"],
	block: "brace", lineComments: ["//"], blockComments: [["/*", "*/"]], quotes: ['"', "'"],
	classes: [{ re: /^\s*(?:(?:public|private|protected|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, kind: "class" }],
	types: [],
	functions: [],
	methods: [{ re: /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)+(?:<[^>]+>\s*)?[\w.$<>\[\],?]+\s+([A-Za-z_]\w*)\s*\(/, kind: "method" }],
};

const kotlin = {
	id: "kotlin", title: "Kotlin", exts: [".kt", ".kts"],
	block: "brace", lineComments: ["//"], blockComments: [["/*", "*/"]], quotes: ['"'],
	classes: [{ re: /^\s*(?:(?:public|private|protected|internal|open|abstract|sealed|data|enum|annotation|value|inline)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/, kind: "class" }],
	functions: [{ re: /^\s*(?:(?:public|private|protected|internal|open|override|suspend|inline|operator|infix|tailrec|external|actual|expect)\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/, kind: "function" }],
	methods: [],
};

const csharp = {
	id: "csharp", title: "C#", exts: [".cs"],
	block: "brace", lineComments: ["//"], blockComments: [["/*", "*/"]], quotes: ['"', "'"],
	classes: [{ re: /^\s*(?:(?:public|private|protected|internal|abstract|sealed|static|partial|readonly)\s+)*(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/, kind: "class" }],
	functions: [],
	methods: [{ re: /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|new|partial)\s+)+(?:[\w<>\[\],.?]+\s+)?([A-Za-z_]\w*)\s*\(/, kind: "method" }],
};

const cpp = {
	id: "cpp", title: "C / C++", exts: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
	block: "brace", lineComments: ["//"], blockComments: [["/*", "*/"]], quotes: ['"', "'"],
	classes: [{ re: /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|union|enum)\s+([A-Za-z_]\w*)/, kind: "class" }],
	functions: [{ re: /^\s*(?!(?:if|for|while|switch|catch|return|else|do|sizeof|new|delete|case)\b)(?:[\w:*&<>,\s]+?)\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:\{.*)?$/, kind: "function" }],
	methods: [{ re: /^\s*(?:virtual\s+|static\s+|inline\s+|explicit\s+|constexpr\s+)*(?:[\w:*&<>,\s]+?)\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:\{.*)?$/, kind: "method" }],
};

const ruby = {
	id: "ruby", title: "Ruby", exts: [".rb", ".rake"],
	block: "indent", lineComments: ["#"], blockComments: [["=begin", "=end"]], quotes: ['"', "'"],
	classes: [
		{ re: /^\s*(?:class|module)\s+([A-Z]\w*(?:::\w+)*)/, kind: "class" },
	],
	functions: [{ re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, kind: "function" }],
	methods: [],
};

const php = {
	id: "php", title: "PHP", exts: [".php"],
	block: "brace", lineComments: ["//", "#"], blockComments: [["/*", "*/"]], quotes: ['"', "'"],
	classes: [{ re: /^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, kind: "class" }],
	functions: [{ re: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*\(/, kind: "function" }],
	methods: [],
};

const swift = {
	id: "swift", title: "Swift", exts: [".swift"],
	block: "brace", lineComments: ["//"], blockComments: [["/*", "*/"]], quotes: ['"'],
	classes: [{ re: /^\s*(?:(?:public|private|internal|fileprivate|open|final)\s+)*(?:class|struct|enum|protocol|extension)\s+([A-Za-z_]\w*)/, kind: "class" }],
	functions: [{ re: /^\s*(?:(?:public|private|internal|fileprivate|open|static|class|override|mutating|nonmutating|@\w+)\s+)*func\s+([A-Za-z_]\w*)/, kind: "function" }],
	methods: [{ re: /^\s*(?:(?:public|private|internal|fileprivate|open|override|convenience|required)\s+)*(init|deinit)\s*\(/, kind: "method" }],
};

const dart = {
	id: "dart", title: "Dart", exts: [".dart"],
	block: "brace", lineComments: ["//"], blockComments: [["/*", "*/"]], quotes: ['"', "'"],
	classes: [{ re: /^\s*(?:abstract\s+|sealed\s+|base\s+|final\s+)*class\s+([A-Za-z_]\w*)/, kind: "class" }],
	functions: [{ re: /^\s*(?:[\w<>?,\s]+\s+)?([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:async\s*)?(?:=>\s*[^;]+|\{)/, kind: "function" }],
	methods: [{ re: /^\s*(?:const\s+|factory\s+)?([A-Z]\w*)\s*\([^;{}]*\)\s*(?::\s*\w+\s*)?(?:=>\s*[^;]+|\{)/, kind: "method" }],
};

const lua = {
	id: "lua", title: "Lua", exts: [".lua"],
	block: "indent", lineComments: ["--"], blockComments: [["--[[", "]]"]], quotes: ['"', "'"],
	classes: [],
	functions: [{ re: /^\s*(?:local\s+)?function\s+([A-Za-z_][\w.:]*)/, kind: "function" }],
	methods: [],
};

const shell = {
	id: "shell", title: "Shell", exts: [".sh", ".bash", ".zsh"],
	block: "brace", lineComments: ["#"], blockComments: [], quotes: ['"', "'"],
	classes: [],
	functions: [{ re: /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/, kind: "function" }],
	methods: [],
};

const r = {
	id: "r", title: "R", exts: [".r", ".R"],
	block: "brace", lineComments: ["#"], blockComments: [], quotes: ['"', "'"],
	classes: [],
	functions: [{ re: /^\s*([A-Za-z_.][\w.]*)\s*<-\s*function\s*\(/, kind: "function" }],
	methods: [],
};

const elixir = {
	id: "elixir", title: "Elixir", exts: [".ex", ".exs"],
	block: "indent", lineComments: ["#"], blockComments: [], quotes: ['"'],
	classes: [{ re: /^\s*defmodule\s+([\w.]+)/, kind: "module" }],
	functions: [{ re: /^\s*defp?\s+([a-z_]\w*[?!]?)/, kind: "function" }],
	methods: [],
};

export const PROFILES = [js, ts, python, go, rust, java, kotlin, csharp, cpp, ruby, php, swift, dart, lua, shell, r, elixir];

const BY_EXT = new Map();
for (const p of PROFILES) for (const ext of p.exts) if (!BY_EXT.has(ext.toLowerCase())) BY_EXT.set(ext.toLowerCase(), p);

export function profileFor(path) {
	const i = path.lastIndexOf(".");
	return i < 0 ? undefined : BY_EXT.get(path.slice(i).toLowerCase());
}

export function supportedExtensions() {
	return [...BY_EXT.keys()].sort();
}

export function isTestPath(path) {
	return /(^|\/)(tests?|__tests__|spec|specs)\//i.test(path) ||
		/\.(test|spec)\.[^.]+$/i.test(path) ||
		/_test\.[^.]+$/i.test(path) ||
		/(Test|Tests|Spec)\.[A-Za-z]+$/.test(path);
}

/* ────────────────────────────── 注释 / 字符串 ────────────────────────────── */

export function stripSource(text, profile) {
	const out = text.split("");
	const n = text.length;
	const quotes = profile.quotes ?? ['"', "'"];
	const triple = profile.blockComments?.filter(([a, b]) => a === b && a.length === 3) ?? [];
	const blocks = profile.blockComments?.filter(([a, b]) => a !== b || a.length !== 3) ?? [];
	let i = 0;
	while (i < n) {
		let hit = false;
		for (const [open, close] of triple) {
			if (text.startsWith(open, i)) {
				const end = text.indexOf(close, i + open.length);
				const stop = end === -1 ? n : end + close.length;
				for (let j = i; j < stop; j++) if (out[j] !== "\n") out[j] = " ";
				i = stop;
				hit = true;
				break;
			}
		}
		if (hit) continue;
		for (const [open, close] of blocks) {
			if (text.startsWith(open, i)) {
				const end = text.indexOf(close, i + open.length);
				const stop = end === -1 ? n : end + close.length;
				for (let j = i; j < stop; j++) if (out[j] !== "\n") out[j] = " ";
				i = stop;
				hit = true;
				break;
			}
		}
		if (hit) continue;
		for (const lc of profile.lineComments ?? []) {
			if (text.startsWith(lc, i)) {
				let end = text.indexOf("\n", i);
				if (end === -1) end = n;
				for (let j = i; j < end; j++) out[j] = " ";
				i = end;
				hit = true;
				break;
			}
		}
		if (hit) continue;
		const ch = text[i];
		if (quotes.includes(ch)) {
			let j = i + 1;
			while (j < n) {
				if (text[j] === "\\") { if (out[j] !== "\n") out[j] = " "; j += 2; continue; }
				if (text[j] === ch) break;
				if (text[j] !== "\n") out[j] = " ";
				j++;
			}
			i = j + 1;
			continue;
		}
		i++;
	}
	return out.join("");
}

export function indentOf(line) {
	let n = 0;
	for (const ch of line) {
		if (ch === " ") n++;
		else if (ch === "\t") n += 4;
		else break;
	}
	return n;
}

function braceEnd(codeLines, start) {
	let depth = 0;
	let seen = false;
	for (let i = start; i < codeLines.length && i < start + 4000; i++) {
		for (const ch of codeLines[i]) {
			if (ch === "{") { depth++; seen = true; }
			else if (ch === "}") { depth--; if (seen && depth <= 0) return i; }
		}
		if (!seen && i > start && /;\s*$/.test(codeLines[i])) return i;
	}
	return Math.min(codeLines.length - 1, start);
}

function indentEnd(lines, start) {
	const base = indentOf(lines[start]);
	let end = start;
	for (let i = start + 1; i < lines.length; i++) {
		if (!lines[i].trim()) continue;
		if (indentOf(lines[i]) <= base) break;
		end = i;
	}
	return end;
}

function blockEnd(profile, lines, codeLines, start) {
	if (profile.block === "brace") {
		// 单行表达式体（=> expr）没有花括号
		const line = codeLines[start] ?? "";
		if (!line.includes("{") && line.includes("=>")) return start;
		return braceEnd(codeLines, start);
	}
	return indentEnd(lines, start);
}

function bodyInfo(profile, lines, codeLines, start, end) {
	const raw = codeLines[start] ?? "";
	const orig = lines[start] ?? "";
	if (profile.block === "brace") {
		const arrow = raw.indexOf("=>");
		const brace = raw.indexOf("{");
		if (arrow >= 0 && (brace < 0 || arrow < brace)) return { startLine: start, startCol: arrow + 2 };
		if (brace >= 0) return { startLine: start, startCol: brace + 1 };
		if (/;\s*$/.test(raw)) return { startLine: end + 1, startCol: 0 };
		return { startLine: start + 1, startCol: 0 };
	}
	// Python / Ruby / Elixir：冒号后还有内容就是单行体
	const colon = orig.lastIndexOf(":");
	if (colon >= 0 && orig.slice(colon + 1).trim() && !/^\s*#/.test(orig.slice(colon + 1))) {
		return { startLine: start, startCol: colon + 1 };
	}
	return { startLine: start + 1, startCol: 0 };
}

/* ────────────────────────────── 注释 → 摘要 ────────────────────────────── */

const COMMENT_LINE = /^(?:\/\/+|#+|--+|;;+|\*+|%+|<!--|<#)\s?/;

function cleanComment(text) {
	return text
		.replace(/^\s*\/\*\*?/, "")
		.replace(/\*\/\s*$/, "")
		.replace(/^\s*<!--/, "")
		.replace(/-->\s*$/, "")
		.replace(/^\s*\/\/\/?/, "")
		.replace(/^\s*#+/, "")
		.replace(/^\s*--+/, "")
		.replace(/^\s*;+/, "")
		.replace(/^\s*\*+\s?/, "")
		.replace(/^\s*%+/, "")
		.replace(/\s+$/g, "");
}

function leadingDoc(lines, idx, profile) {
	let i = idx - 1;
	// 跳过注解 / 装饰器
	while (i >= 0 && /^\s*@/.test(lines[i])) i--;
	if (i < 0) return "";
	const prev = lines[i] ?? "";
	// 块注释
	if (/\*\/\s*$/.test(prev) || /-->\s*$/.test(prev)) {
		const startTok = prev.includes("-->") ? "<!--" : "/*";
		const endTok = prev.includes("-->") ? "-->" : "*/";
		const out = [];
		let j = i;
		while (j >= 0) {
			const t = lines[j];
			out.unshift(cleanComment(t));
			if (t.includes(startTok)) break;
			j--;
		}
		return out.join("\n").replace(new RegExp(`^\\s*${endTok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "").trim();
	}
	const out = [];
	while (i >= 0) {
		const t = lines[i].trim();
		if (!COMMENT_LINE.test(t)) break;
		out.unshift(cleanComment(lines[i]));
		i--;
	}
	return out.join("\n").trim();
}

function pythonDocstring(lines, idx) {
	for (let j = idx + 1; j < lines.length && j < idx + 12; j++) {
		const t = lines[j].trim();
		if (!t) continue;
		const q = t.startsWith('"""') ? '"""' : t.startsWith("'''") ? "'''" : "";
		if (!q) return "";
		let body = t.slice(3);
		const same = body.indexOf(q);
		if (same >= 0) return body.slice(0, same).trim();
		const out = [body];
		for (let k = j + 1; k < lines.length; k++) {
			const e = lines[k].indexOf(q);
			if (e >= 0) { out.push(lines[k].slice(0, e)); break; }
			out.push(lines[k]);
		}
		return out.join("\n").trim();
	}
	return "";
}

export function shortOf(doc, max = 72) {
	const line = (doc ?? "").split("\n").map((s) => s.trim()).find(Boolean);
	if (!line) return "";
	const clean = line.replace(/^[-*•\d.)、\s]+/, "").replace(/\s+/g, " ").trim();
	if (!clean) return "";
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function sigOf(lines, idx, profile) {
	let s = (lines[idx] ?? "").trim();
	let j = idx;
	while (j < lines.length - 1 && j < idx + 6 && /[,(]\s*$/.test(s)) {
		j++;
		s += ` ${lines[j].trim()}`;
	}
	s = s.replace(/\s*\{.*$/, "").replace(/\s*=>.*$/, "").replace(/\s+/g, " ").trim();
	return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

/* ────────────────────────────── 声明 ────────────────────────────── */

function matchDecl(patterns, line) {
	for (const p of patterns ?? []) {
		const m = p.re.exec(line);
		if (m) {
			const name = m[p.nameGroup ?? 1];
			if (name && !RESERVED.has(name.toLowerCase())) return { name, kind: p.kind, receiver: p.receiverGroup ? m[p.receiverGroup] : undefined };
		}
	}
	return undefined;
}

export function analyzeSource(path, text, profile) {
	const lines = text.split(/\r?\n/);
	const codeLines = stripSource(text, profile).split(/\r?\n/);
	const decls = [];
	const seenStart = new Set();

	const add = (lineIdx, kind, name, extra = {}) => {
		if (seenStart.has(lineIdx) || !name) return undefined;
		seenStart.add(lineIdx);
		const endLine = blockEnd(profile, lines, codeLines, lineIdx);
		const body = bodyInfo(profile, lines, codeLines, lineIdx, endLine);
		const doc = (profile.docstring ? pythonDocstring(lines, lineIdx) : "") || leadingDoc(lines, lineIdx, profile);
		const d = {
			kind,
			name,
			startLine: lineIdx + 1,
			endLine: endLine + 1,
			line: lineIdx + 1,
			indent: indentOf(lines[lineIdx]),
			doc,
			summary: shortOf(doc),
			sig: sigOf(lines, lineIdx, profile),
			children: [],
			calls: [],
			types: [],
			receiver: extra.receiver,
			_bodyStart: body.startLine,
			_bodyEnd: endLine,
			_bodyCol: body.startCol,
		};
		decls.push(d);
		return d;
	};

	for (let i = 0; i < lines.length; i++) {
		const raw = codeLines[i] ?? "";
		if (!raw.trim()) continue;
		const c = matchDecl(profile.classes, raw);
		if (c) { add(i, c.kind, c.name); continue; }
		const t = matchDecl(profile.types, raw);
		if (t) { add(i, t.kind, t.name); continue; }
		const o = matchDecl(profile.objects, raw);
		if (o) { add(i, o.kind, o.name); continue; }
		const f = matchDecl(profile.functions, raw);
		if (f) { add(i, f.kind, f.name, { receiver: f.receiver }); continue; }
	}

	// 类 / 对象体里的方法（Java、C#、JS class 等没有 function 关键字）
	const classLike = new Set(["class", "interface", "struct", "trait", "impl", "object", "enum", "module"]);
	const classDecls = decls.filter((d) => classLike.has(d.kind));
	if (profile.methods?.length && classDecls.length) {
		for (let i = 0; i < lines.length; i++) {
			const raw = codeLines[i] ?? "";
			if (!raw.trim()) continue;
			const owners = classDecls.filter((d) => i + 1 >= d.startLine && i + 1 <= d.endLine);
			if (!owners.length) continue;
			const owner = owners.sort((a, b) => b.startLine - a.startLine)[0];
			let m = matchDecl(profile.methods, raw);
			if (!m && classLike.has(owner.kind)) {
				// Java / C# / Kotlin 的构造器没有返回类型：`public App(...)`。
				const ctor = new RegExp(`^\\s*(?:(?:public|private|protected|internal|static|final|abstract)\\s+)*${owner.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`).exec(raw);
				if (ctor) m = { name: owner.name };
			}
			if (!m) continue;
			const kind = m.name === owner.name ? "constructor" : "method";
			const d = add(i, kind, m.name);
			if (d) d._ownerId = owner;
		}
	}

	// 嵌套：按行范围套成树（方法、内部类、嵌套函数都靠这一步）
	const all = decls.slice().sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
	const roots = [];
	const stack = [];
	for (const d of all) {
		while (stack.length && d.startLine > stack[stack.length - 1].endLine) stack.pop();
		const parent = stack[stack.length - 1];
		if (parent && d.startLine >= parent.startLine && d.endLine <= parent.endLine) {
			parent.children.push(d);
			d._parentSym = parent;
		} else {
			roots.push(d);
		}
		stack.push(d);
	}

	const classOf = (sym) => {
		let p = sym._parentSym;
		while (p) {
			if (classLike.has(p.kind)) return p;
			p = p._parentSym;
		}
		return undefined;
	};
	const visit = (sym) => {
		const cls = classOf(sym);
		if (cls) sym._class = cls.name;
		if (sym.kind === "function" && cls) sym.kind = sym.name === cls.name ? "constructor" : "method";
		if (sym.receiver) sym.kind = "method";
		for (const c of sym.children) visit(c);
	};
	for (const r of roots) visit(r);

	const imports = parseImports(path, lines, profile);
	return { path, profile, lines, codeLines, symbols: roots, imports: imports.specs, importMap: imports.map, headerDoc: fileHeaderDoc(lines), lineCount: lines.length };
}

/** 文件头注释：跳过 shebang / 空行，收第一段注释。 */
function fileHeaderDoc(lines) {
	let i = 0;
	while (i < lines.length && (!lines[i].trim() || /^#!/.test(lines[i]))) i++;
	if (i >= lines.length) return "";
	const t = lines[i].trim();
	if (!COMMENT_LINE.test(t) && !/^\/\*/.test(t) && !/^<!--/.test(t)) return "";
	if (/^\/\*/.test(t) || /^<!--/.test(t)) {
		const close = t.startsWith("<!--") ? "-->" : "*/";
		const out = [];
		for (let j = i; j < lines.length && j < i + 40; j++) {
			out.push(cleanComment(lines[j]));
			if (lines[j].includes(close)) break;
		}
		return out.join("\n").trim();
	}
	const out = [];
	for (let j = i; j < lines.length && j < i + 40; j++) {
		if (!COMMENT_LINE.test(lines[j].trim())) break;
		out.push(cleanComment(lines[j]));
	}
	return out.join("\n").trim();
}

/* ────────────────────────────── 导入 ────────────────────────────── */

function addImport(map, specs, local, spec, imported) {
	if (!spec) return;
	if (!specs.includes(spec)) specs.push(spec);
	if (local) map.set(local, { spec, imported: imported || local });
}

function splitNamed(list) {
	return list.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
		const m = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(s);
		return m ? { imported: m[1], local: m[2] ?? m[1] } : undefined;
	}).filter(Boolean);
}

export function parseImports(path, lines, profile) {
	const specs = [];
	const map = new Map();
	for (const line of lines) {
		const t = line.trim();
		if (!t) continue;
		if (profile.id === "javascript" || profile.id === "typescript" || profile.id === "dart") {
			let m = /^import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/.exec(t);
			if (m) {
				const clause = m[1].trim();
				const spec = m[2];
				const def = /^([A-Za-z_$][\w$]*)/.exec(clause);
				if (def) addImport(map, specs, def[1], spec, "default");
				const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
				if (ns) addImport(map, specs, ns[1], spec, "*");
				const named = /\{([^}]*)\}/.exec(clause);
				if (named) for (const n of splitNamed(named[1])) addImport(map, specs, n.local, spec, n.imported);
				continue;
			}
			m = /^import\s+['"]([^'"]+)['"]/.exec(t);
			if (m) { addImport(map, specs, undefined, m[1]); continue; }
			m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/.exec(t);
			if (m) { addImport(map, specs, m[1], m[2], "default"); continue; }
			m = /export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/.exec(t);
			if (m) addImport(map, specs, undefined, m[1]);
			continue;
		}
		if (profile.id === "python") {
			let m = /^from\s+([.\w]+)\s+import\s+(.+)$/.exec(t);
			if (m) {
				for (const n of splitNamed(m[2].replace(/[()]/g, ""))) addImport(map, specs, n.local, m[1], n.imported);
				continue;
			}
			m = /^import\s+([.\w]+)(?:\s+as\s+(\w+))?/.exec(t);
			if (m) {
				const local = m[2] ?? m[1].split(".").pop();
				addImport(map, specs, local, m[1], m[1].split(".").pop());
			}
			continue;
		}
		if (profile.id === "go") {
			const m = /^(?:import\s+)?(?:(\w+|\.|_)\s+)?["`]([^"`]+)["`]/.exec(t);
			if (m && (t.startsWith("import") || /^["`]/.test(t) || /^\w+\s+["`]/.test(t))) {
				const local = m[1] && m[1] !== "_" && m[1] !== "." ? m[1] : m[2].split("/").pop();
				addImport(map, specs, local, m[2], local);
			}
			continue;
		}
		if (profile.id === "rust") {
			const m = /^use\s+([^;]+);/.exec(t);
			if (m) {
				const parts = m[1].replace(/[{}]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
				for (const p of parts) {
					const seg = p.split("::").filter(Boolean);
					const local = seg[seg.length - 1];
					if (local && local !== "self" && local !== "super" && local !== "crate") addImport(map, specs, local, m[1].trim(), local);
				}
			}
			continue;
		}
		if (profile.id === "java" || profile.id === "kotlin" || profile.id === "csharp" || profile.id === "scala") {
			let m = /^import\s+(?:static\s+)?([\w.]+)(?:\.\*)?;?/.exec(t);
			if (m) { const local = m[1].split(".").pop(); addImport(map, specs, local, m[1], local); continue; }
			m = /^using\s+(?:static\s+)?([\w.]+);?/.exec(t);
			if (m) { const local = m[1].split(".").pop(); addImport(map, specs, local, m[1], local); }
			continue;
		}
		if (profile.id === "ruby") {
			const m = /^require(?:_relative)?\s*['"]([^'"]+)['"]/.exec(t);
			if (m) addImport(map, specs, undefined, m[1]);
			continue;
		}
		if (profile.id === "php") {
			let m = /^(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/.exec(t);
			if (m) { addImport(map, specs, undefined, m[1]); continue; }
			m = /^use\s+([\w\\]+)(?:\s+as\s+(\w+))?/.exec(t);
			if (m) { const local = m[2] ?? m[1].split("\\").pop(); addImport(map, specs, local, m[1], local); }
			continue;
		}
		if (profile.id === "cpp") {
			const m = /^#\s*include\s*[<"]([^>"]+)[>"]/.exec(t);
			if (m) addImport(map, specs, undefined, m[1]);
			continue;
		}
		if (profile.id === "swift" || profile.id === "elixir") {
			const m = /^(?:import|alias|require)\s+([\w.]+)/.exec(t);
			if (m) { const local = m[1].split(".").pop(); addImport(map, specs, local, m[1], local); }
			continue;
		}
		if (profile.id === "lua") {
			const m = /require\s*\(?\s*['"]([^'"]+)['"]/.exec(t);
			if (m) addImport(map, specs, undefined, m[1]);
			continue;
		}
		if (profile.id === "shell" || profile.id === "r") {
			const m = /^(?:source|\.|sys\.source)\s*\(?\s*['"]?([^'")\s]+)['"]?/.exec(t);
			if (m) addImport(map, specs, undefined, m[1]);
			continue;
		}
	}
	return { specs, map };
}

/* ────────────────────────────── 条件 ────────────────────────────── */

function controlOf(line, profile) {
	const clean = line.replace(/^\s*\}\s*/, "").replace(/^\s*\{/, "").trim();
	for (const c of CONTROL) {
		const m = c.re.exec(clean);
		if (!m) continue;
		const expr = (m[1] ?? "").replace(/[)\s{]+$/, "").trim();
		if (c.kind === "if") return `当 ${clip(expr)}`;
		if (c.kind === "elif") return `否则 · 当 ${clip(expr)}`;
		if (c.kind === "else") return "否则";
		if (c.kind === "switch") return `switch ${clip(expr)}`;
		if (c.kind === "case") return `case ${clip(expr)}`;
		if (c.kind === "catch") return "出错时";
		if (c.kind === "finally") return "收尾";
		if (c.kind === "loop") return "循环";
	}
	return "";
}

function clip(text, max = 44) {
	const s = text.replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 按缩进维护条件栈，返回「行号 → 该行所处的条件」。
 * 不是运行时求值，只是把 if / else / switch / catch 的静态位置标出来。
 */
export function conditionMap(codeLines, start, end) {
	const out = new Map();
	const stack = [];
	for (let i = start; i <= end && i < codeLines.length; i++) {
		const raw = codeLines[i] ?? "";
		const line = raw.trim();
		if (!line) continue;
		const ind = indentOf(raw);
		const isElse = /^(?:\}\s*)?(?:else\b|elif\b|elsif\b|elseif\b|catch\b|except\b|rescue\b|finally\b|ensure\b)/i.test(line);
		while (stack.length && (ind <= stack[stack.length - 1].indent || (isElse && ind === stack[stack.length - 1].indent))) stack.pop();
		out.set(i, stack.map((s) => s.cond).join(" · "));
		const cond = controlOf(line);
		if (cond) stack.push({ indent: ind, cond });
	}
	return out;
}
