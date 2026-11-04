#!/usr/bin/env node
/**
 * `npm run prompt:check` —— V3 提示词的黄金渲染。
 *
 * 它回答五个问题，全部「不通过就退出码 1」：
 *
 * 1. `seed/prompt/` 能读、能排、段名不重复（文件名前缀定序，一个文件一段）。
 * 2. 同一组文件渲染**两次逐字节相同** —— 打穿 prompt cache 的那个 bug 就在这里拦。
 * 3. **未知插槽 0 个**：模板里写了 `{{x}}`，样例表里没有 x，就是代码与文案脱节。
 * 4. 每段正文 ≤ 12 行（契约 §1 的上限：一段超过 12 行，模型就开始跳着读）。
 * 5. 模板正文里**不出现工具名**：工具名只能走 `{{tool:xxx}}`，别的一律自然语言。
 *    这一条是启发式的（只查反引号里的单个标识符），真正的守门是 `test/` 里的检查。
 *
 * 用法：`npm run prompt:check`，加 `--print` 顺便把渲染结果打出来。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFsx } from "../src/core/fsx.ts";
import { parseCatalog } from "../src/core/md/catalog.ts";
import { renderSlots, slotsIn } from "../src/core/md/text.ts";
import { loadTemplates, renderPrompt, PROMPT_DIR } from "../src/core/md/prompt.ts";
import { SAMPLE_SLOTS } from "./prompt-fixture.ts";

/** V2 与 V3 用过的工具名。模板里出现它们 = 文案绑死了实现。 */
const TOOL_NAMES = new Set([
	"say",
	"chats",
	"hire",
	"me",
	"skills",
	"teams",
	"write_team",
	"remember",
	"read_history",
	"run",
	"file",
	"think",
	"mention",
]);

const MAX_LINES = 12;

const root = fileURLToPath(new URL("..", import.meta.url));
const fsx = createFsx(root);
const failures: string[] = [];

function fail(message: string): void {
	failures.push(message);
}

/** 正文里的非空行数。空行是排版，不算内容。 */
function contentLines(body: string): number {
	return body.split("\n").filter((line) => line.trim() !== "").length;
}

/** 反引号里的单个标识符：`` `say` `` / `` `say(...)` ``。路径（`skills/x/SKILL.md`）不算。 */
function backtickedTools(body: string): string[] {
	const found: string[] = [];
	for (const match of body.replace(/\{\{[^}]*\}\}/g, "").matchAll(/`([a-z][a-z0-9_]*)(?:\([^`]*\))?`/g)) {
		const name = match[1];
		if (name !== undefined && TOOL_NAMES.has(name)) found.push(name);
	}
	return found;
}

/** 出厂模板在 `seed/prompt/`；运行时是 `workspace/prompt/`（播种时拷过去）。 */
const SEED_PROMPT_DIR = `seed/${PROMPT_DIR}`;

const templates = await loadTemplates(fsx, SEED_PROMPT_DIR);

if (templates.length === 0) fail(`没读到任何模板：${SEED_PROMPT_DIR}/`);

for (const template of templates) {
	if (contentLines(template.body) > MAX_LINES) {
		fail(`${template.file} 正文 ${contentLines(template.body)} 行，上限 ${MAX_LINES} 行`);
	}
	const tools = backtickedTools(template.body);
	if (tools.length > 0) fail(`${template.file} 硬编码了工具名：${[...new Set(tools)].join("、")}（改成 {{tool:…}} 或自然语言）`);
}

const first = renderPrompt(templates, SAMPLE_SLOTS);
const second = renderPrompt(templates, SAMPLE_SLOTS);

if (first.text !== second.text) fail("两次渲染的提示词不一致（确定性被破坏）");
if (JSON.stringify(first.segments) !== JSON.stringify(second.segments)) fail("两次渲染的段落不一致");
if (JSON.stringify(first.delivery) !== JSON.stringify(second.delivery)) fail("两次渲染的投递段不一致");

for (const issue of first.issues) {
	fail(`填不上的插槽 {{${issue.slot}}}（${issue.reason}）：模板用了，样例表没给`);
}

const rows = templates.map((template) => ({
	order: template.order,
	segment: template.segment,
	use: template.use,
	file: template.file,
	skip: template.skipEmpty ?? "-",
	lines: contentLines(template.body),
}));

console.log("模板：");
for (const row of rows) {
	console.log(
		`  ${String(row.order).padStart(2, "0")} ${row.segment.padEnd(12)} ${row.use.padEnd(8)} skip-empty=${String(row.skip).padEnd(10)} ${String(row.lines).padStart(2)} 行  ${row.file}`,
	);
}
console.log(
	`\n段：${first.segments.length} 段进系统提示词、${Object.keys(first.delivery).length} 段投递用；` +
		`正文 ${first.text.length} 字符；填不上的插槽 ${first.issues.length}`,
);

if (process.argv.includes("--print")) {
	console.log("\n──── 渲染结果 ────\n");
	console.log(first.text);
	for (const [name, text] of Object.entries(first.delivery)) console.log(`\n──── ${name} ────\n\n${text}`);
}

if (failures.length > 0) {
	console.error("\n✗ prompt:check 失败：");
	for (const message of failures) console.error(`  - ${message}`);
	process.exit(1);
}

// ── 文案目录（seed/text/*.md）────────────────────────────────────────────
// 代码里只留键名。这里守三件事：代码引用的键都真的存在；每条文案的插槽都填得上；
// 同一份输入渲染两遍逐字节相同（文案进提示词，确定性同样不能破）。

/** 文案键的第一段。只有这些前缀才当成「代码引用了一个文案键」。 */
const TEXT_NAMESPACES = new Set([
	"say",
	"chats",
	"history",
	"remember",
	"hire",
	"run",
	"file",
	"channel",
	"recall",
	"org",
	"tool",
	"delivery",
	"attachments",
	"unanswered",
	"post",
	"sections",
]);

const textKeys = new Map<string, string>();
for (const name of readdirSync(join(root, "seed/text")).filter((file) => file.endsWith(".md")).sort()) {
	for (const [key, body] of parseCatalog(name, readFileSync(join(root, "seed/text", name), "utf8"))) {
		if (textKeys.has(key)) fail(`文案键重复：${key}（${name}）`);
		textKeys.set(key, body);
	}
}
if (textKeys.size === 0) fail("没读到任何文案：seed/text/*.md");

/** 递归列出 `src/core` 的 ts 文件。 */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
		const rel = `${dir}/${entry.name}`;
		if (entry.isDirectory()) out.push(...sourceFiles(rel));
		else if (entry.name.endsWith(".ts")) out.push(rel);
	}
	return out;
}

const KEY_REF = /"([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+)"/g;
const referenced = new Map<string, string>();
for (const file of sourceFiles("src/core")) {
	const source = readFileSync(join(root, file), "utf8");
	for (const match of source.matchAll(KEY_REF)) {
		const key = match[1];
		if (key === undefined) continue;
		if (!TEXT_NAMESPACES.has(key.split(".")[0] ?? "")) continue;
		if (!referenced.has(key)) referenced.set(key, file);
	}
}
for (const [key, file] of referenced) {
	if (!textKeys.has(key)) fail(`${file} 引用了不存在的文案键：${key}`);
}

for (const [key, body] of textKeys) {
	const slots = Object.fromEntries(slotsIn(body).map((name) => [name, "x"]));
	const once = renderSlots(body, slots).text;
	const twice = renderSlots(body, slots).text;
	if (once !== twice) fail(`文案 ${key} 两次渲染不一致（确定性被破坏）`);
	if (once.includes("（未设置）")) fail(`文案 ${key} 的插槽填不上：${slotsIn(body).join("、")}`);
}

console.log(`\n文案：${textKeys.size} 条（代码引用 ${referenced.size} 条）`);

console.log("\n✓ prompt:check 通过（确定性、插槽、行数、工具名、文案键）");
