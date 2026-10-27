#!/usr/bin/env node
/**
 * 边界检查：业务层与界面层不得直接导入底层运行时库。
 *
 * 底层库（@earendil-works/pi-durable、pi-ai、chord）标注为 experimental，
 * 破坏性变更必须只影响 src/runtime/。业务层与界面层通过 src/runtime 间接使用。
 *
 * 例外：pi-tui 是界面渲染库，不属于「运行时」，界面层可以直接用。
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** 只允许 src/runtime 导入的包。 */
const RUNTIME_ONLY = [
	"@earendil-works/pi-durable",
	"@earendil-works/pi-ai",
	"@earendil-works/chord",
];

/** 受检查的目录（相对仓库根）。 */
const CHECKED_DIRS = ["src/domain", "src/company", "src/tui", "src/server"];

/** 允许的子路径例外：类型-only 与纯 UI 包。 */
const ALLOWED = new Set(["@earendil-works/pi-tui"]);

async function* walk(dir) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) yield full;
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

/**
 * 第二类规则：分层方向。
 *
 * 之前这个脚本只守「底层运行时库只能 src/runtime 导入」一条，用户以为它还在守
 * 「domain 不能依赖上层」，实际完全没有。于是：
 * - `src/domain` 反向 import `../company/*` 能通过检查，纯函数层的假设就破了；
 * - `src/server` 直接 import `*Doc` 常量（8 处），绕过 company 层的读写口径。
 *
 * 这里把这两条补上。白名单是显式的：新增例外必须写进代码，不能靠没人发现。
 */
const DOMAIN_FORBIDDEN = [/^\.\.\//, /^src\//, /^@/];

/** server 层不得直接拿 doc token 自己读写（必须走 company 层的读函数）。 */
const DOC_TOKENS = [
	"CompanyDoc",
	"ChannelDoc",
	"PendingDoc",
	"InboxDoc",
	"UsageDoc",
	"AuditDoc",
	"TrailDoc",
	"TaskDoc",
	"BudgetDoc",
	"ProfileDoc",
];

/** server 层允许直接 import doc 的文件（存量，逐步收敛）。 */
const DOC_IMPORT_ALLOWED = new Set(["src/server/http.ts"]);

/** domain 层里允许 import 的「同层」文件（domain 内部互相依赖是合法的）。 */

/**
 * 第三类规则：HTTP 路由零消费者。
 *
 * 路由表里堆着没人调的接口，界面上看不见、测试也不报——只能静态查。
 * **必须读 ui/js 源码而不是 ui/dist**：bundle 会把注释和死代码一起带进去，
 * 查 dist 只会假绿。**也刻意不读 test/**：测试跟着实现走，删路由时测试
 * 一起删，所以「测试里有消费者」不能证明「用户能用上」。
 *
 * 两类豁免，语义不同，不能混：
 * · `NO_CONSUMER_ALLOWED`——消费者在本仓库之外，查不到是正常的，永久成立。
 * · `NO_CONSUMER_PENDING`——界面上确实还没有消费者，但已有处置计划。
 *   这**不是豁免**：每次 check 都会把清单打到 stderr，直到计划被执行。
 *   写成永久豁免等于把缺口藏起来，那还不如没有这条检查。
 */
const NO_CONSUMER_ALLOWED = new Map([
	["/api/im/inbound", "外部 webhook 入口：消费者在别的系统里，仓库内查不到（ui/js/settings.js:227 只生成它的地址）"],
	[
		"/api/org",
		"运维探针消费：docker-compose.yml:37 健康检查与 scripts/ai-company-service.sh:107 主动探测；界面改从 /api/stream/org 首帧取快照",
	],
]);

/**
 * 已确认的界面缺口。**每条都必须有「谁来做、做到什么程度」**。
 * 清单会随每次 check 打印；条目消失说明缺口已关上，那时应当来删这一行。
 */
const NO_CONSUMER_PENDING = new Map([
	// 现在是空的：上一轮的六条缺口都已按 ADR-040 处置完（删路由或删归档分支）。
	// 将来再发现界面接不上但暂时不删的路由，往这里加一行，并写清「谁来做、做到什么程度」。
]);

/** 零消费者检查的搜索域：界面层源码 + TUI 源码。 */
const CONSUMER_DIRS = ["ui/js", "src/tui"];

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

/**
 * 路由路径 → 字面前缀。
 * `/api/feed/:conversationId` → `/api/feed/`（取到第一个参数段之前，且保留分隔符），
 * `/api/pending` → `/api/pending`（无参数，用整条）。
 * 带参数时加尾斜杠，避免 `/api/pending` 误命中 `/api/pending/dispose`（那条另有消费者）。
 */
function routePrefix(pattern) {
	const segments = pattern.split("/").filter(Boolean);
	const literal = [];
	for (const segment of segments) {
		if (segment.startsWith(":") || segment.startsWith("*")) return `/${literal.join("/")}/`;
		literal.push(segment);
	}
	return `/${literal.join("/")}`;
}

/** 前缀已是完整路径时要求右边界，否则 `/api/pending` 会命中 `/api/pending/dispose`。 */
function consumerMatcher(prefix) {
	const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(prefix.endsWith("/") ? escaped : `${escaped}(?![\\w/-])`);
}

const violations = [];

for (const dir of CHECKED_DIRS) {
	for await (const file of walk(join(ROOT, dir))) {
		const source = await readFile(file, "utf8");
		const rel = relative(ROOT, file);
		for (const spec of importSpecifiers(source)) {
			if (ALLOWED.has(spec)) continue;
			const offending = RUNTIME_ONLY.find((pkg) => spec === pkg || spec.startsWith(`${pkg}/`));
			if (offending !== undefined) {
				violations.push({
					file: rel,
					spec,
					reason: `${offending} 只能由 src/runtime 导入`,
				});
				continue;
			}

			// domain 是纯函数层：只能 import 同目录的相对路径
			if (dir === "src/domain" && DOMAIN_FORBIDDEN.some((pattern) => pattern.test(spec))) {
				violations.push({
					file: rel,
					spec,
					reason: "src/domain 是纯函数层，不得 import 上层目录或外部包",
				});
				continue;
			}

			// server 不得自己拿 doc token 读写
			if (dir === "src/server" && !DOC_IMPORT_ALLOWED.has(rel) && DOC_TOKENS.some((token) => new RegExp(`\\b${token}\\b`).test(spec))) {
				violations.push({
					file: rel,
					spec,
					reason: "src/server 不得直接 import doc token，请用 company 层的读函数",
				});
			}
		}
	}
}

// ── 第三类：HTTP 路由零消费者 ──
const routes = [
	...new Set(
		[...(await readFile(join(ROOT, "src/server/http.ts"), "utf8")).matchAll(/pattern:\s*"(\/api\/[^"]*)"/g)].map(
			(match) => match[1],
		),
	),
];

let consumerCorpus = "";
for (const dir of CONSUMER_DIRS) {
	for await (const file of walkAll(join(ROOT, dir))) {
		if (!file.endsWith(".js") && !file.endsWith(".ts")) continue;
		consumerCorpus += await readFile(file, "utf8");
	}
}

const pendingGaps = [];
for (const route of routes) {
	if (NO_CONSUMER_ALLOWED.has(route)) continue;
	const pending = NO_CONSUMER_PENDING.get(route);
	if (pending !== undefined) {
		pendingGaps.push({ route, plan: pending });
		continue;
	}
	const prefix = routePrefix(route);
	if (consumerMatcher(prefix).test(consumerCorpus)) continue;
	violations.push({
		file: "src/server/http.ts",
		spec: route,
		reason: `该路由在 ui/js 与 src/tui 里都没有消费者（查找前缀 ${prefix}）。接上、删掉，或写进 NO_CONSUMER_PENDING 并写清谁来收尾`,
	});
}

if (violations.length > 0) {
	console.error(`边界检查失败：${violations.length} 条违规\n`);
	for (const v of violations) {
		console.error(`  ${v.file}`);
		console.error(`    标识: ${v.spec}`);
		console.error(`    原因: ${v.reason}\n`);
	}
	console.error("第一/二类：通过 src/runtime 暴露的接口使用，并按分层方向 import。");
	console.error("零消费者路由：在 ui/js 或 src/tui 里接上、删掉路由，或写进 NO_CONSUMER_PENDING 并注明谁来收尾。");
	process.exit(1);
}

// 缺口清单走 stderr：stdout 只留给「通过」这一句，测试里是拿它当断言的。
if (pendingGaps.length > 0) {
	console.error(`已知界面缺口 ${pendingGaps.length} 条（不算违规，但不许忘）：`);
	for (const gap of pendingGaps) console.error(`  ${gap.route}\n    ${gap.plan}`);
}

console.log(`边界检查通过：${CHECKED_DIRS.join(", ")} 未直接导入底层运行时库；${routes.length} 条 HTTP 路由都有消费者。`);
