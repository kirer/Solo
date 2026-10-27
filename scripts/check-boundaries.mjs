#!/usr/bin/env node
/**
 * 边界检查：业务层与界面层不得直接导入底层运行时库。
 *
 * 底层库（@earendil-works/pi-durable、pi-ai、chord）标注为 experimental，
 * 破坏性变更必须只影响 `src/core/runtime/`（唯一防腐层）。
 *
 * 三条规定：
 * 1. `src/core/runtime/` 之外，任何文件不得 import 那三个包。
 * 2. `src/core/agent`、`src/core/project`、`src/core/channel` 是纯规则与纯 IO 层，
 *    不得反向 import `src/core/shell`（外壳依赖内核，内核不依赖外壳）。
 * 3. 服务端路由必须有界面消费者（有界面看不见的接口就是死接口）。
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** 只允许 `src/core/runtime/` 导入的包。 */
const RUNTIME_ONLY = ["@earendil-works/pi-durable", "@earendil-works/pi-ai", "@earendil-works/chord"];

/** 受检查的目录（相对仓库根）。 */
const CHECKED_DIRS = ["src/core"];

async function* walkAll(dir) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) yield* walkAll(full);
		else if (entry.isFile()) yield full;
	}
}

/** 只看 TypeScript 源码。 */
async function* walk(dir) {
	for await (const file of walkAll(dir)) {
		if (file.endsWith(".ts")) yield file;
	}
}

/** 从源码里取出所有静态 import/export-from 的模块说明符。 */
function importSpecifiers(source) {
	const specs = [];
	const patterns = [
		/\bfrom\s+["']([^"']+)["']/g,
		/\bimport\s+["']([^"']+)["']/g,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) specs.push(match[1]);
	}
	return specs;
}

const violations = [];

for (const dir of CHECKED_DIRS) {
	for await (const file of walk(join(ROOT, dir))) {
		const source = await readFile(file, "utf8");
		const rel = relative(ROOT, file);
		const isFacade = rel.startsWith("src/core/runtime/");
		const isShell = rel.startsWith("src/core/shell/");
		for (const spec of importSpecifiers(source)) {
			const offending = RUNTIME_ONLY.find((pkg) => spec === pkg || spec.startsWith(`${pkg}/`));
			if (offending !== undefined && !isFacade) {
				violations.push({ file: rel, spec, reason: `${offending} 只能由 src/core/runtime/ 导入` });
				continue;
			}
			// 内核不得反向依赖外壳：解析后的相对路径里出现 `/shell/` 就是违规
			if (!isShell && /\/shell\//.test(spec)) {
				violations.push({ file: rel, spec, reason: "内核（agent/project/channel）不得 import 外壳（shell）" });
			}
		}
	}
}

// ── 第三类：HTTP 路由零消费者 ──
const ROUTE_FILE = "src/core/shell/serve.ts";
const routes = [
	...new Set(
		[...(await readFile(join(ROOT, ROUTE_FILE), "utf8")).matchAll(/pattern:\s*"(\/api\/[^"]*)"/g)].map(
			(match) => match[1],
		),
	),
];

/** 已知在仓库外消费的路由（界面不调，但别处要用）。每条都要写清是谁。 */
const NO_CONSUMER_ALLOWED = new Map([
	["/api/org", "运维探针：docker-compose.yml 健康检查与外部监控直接打这条"],
]);

let consumerCorpus = "";
for await (const file of walkAll(join(ROOT, "ui/web/js"))) {
	consumerCorpus += await readFile(file, "utf8");
}

/** 路由路径 → 字面前缀（取到第一个参数段之前）。 */
function routePrefix(pattern) {
	const segments = pattern.split("/").filter(Boolean);
	const literal = [];
	for (const segment of segments) {
		if (segment.startsWith(":") || segment.startsWith("*")) return `/${literal.join("/")}/`;
		literal.push(segment);
	}
	return `/${literal.join("/")}`;
}

/** 前缀已是完整路径时要求右边界，否则 `/api/channels` 会命中 `/api/channels/1`。 */
function consumerMatcher(prefix) {
	const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(prefix.endsWith("/") ? escaped : `${escaped}(?![\\w/-])`);
}

for (const route of routes) {
	if (NO_CONSUMER_ALLOWED.has(route)) continue;
	const prefix = routePrefix(route);
	if (consumerMatcher(prefix).test(consumerCorpus)) continue;
	violations.push({
		file: ROUTE_FILE,
		spec: route,
		reason: `该路由在 ui/web/js 里没有消费者（查找前缀 ${prefix}）。接上，或删掉，或写进 NO_CONSUMER_ALLOWED 并注明谁在用`,
	});
}

if (violations.length > 0) {
	console.error(`边界检查失败：${violations.length} 条违规\n`);
	for (const v of violations) {
		console.error(`  ${v.file}`);
		console.error(`    标识: ${v.spec}`);
		console.error(`    原因: ${v.reason}\n`);
	}
	process.exit(1);
}

console.log(
	`边界检查通过：${CHECKED_DIRS.join(", ")} 未越界导入底层库；${routes.length} 条路由路径都有消费者。`,
);
