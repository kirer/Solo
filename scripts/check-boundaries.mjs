#!/usr/bin/env node
/**
 * 边界检查：业务层与界面层不得直接导入底层运行时库。
 *
 * 底层库（@earendil-works/pi-durable、pi-ai、chord）标注为 experimental，
 * 破坏性变更必须只影响 `src/core/runtime/`（唯一防腐层）。
 *
 * 六条规定（前三条规定是原本就有的，后三条是分层重构后加的）：
 *
 * 1. `src/core/runtime/` 之外，任何文件不得 import 那三个包。
 * 2. 内核（`agent|channel|team|runtime`）不得反向 import 外壳（`shell`），
 *    也不得 import 用例层（`app`）、投影层（`view`）、接口层（`interface`）。
 *    依赖方向只有一条：`shell → interface → {app, view} → 领域 → runtime`。
 * 3. 服务端路由必须有界面消费者（有界面看不见的接口就是死接口）。
 *    前端源码在 `ui/app/src`（React + TS，构建到 `ui/web`），所以查那里。
 * 4. `src/core/view/` 是**契约层**：零 IO（不 import 任何 `node:*`）、不碰 `runtime/`。
 *    它只吃 `ChannelState` / 名册 / DTO 类型，吐界面要的 JSON。一条 `await` 都不该有。
 * 5. `src/core/app/` 是**用例层**：不许 import `node:http` —— 传输是接口层的事，
 *    用例要能脱离网络被测试（现在 `test/core/` 里就是这样直接调它们的）。
 * 6. `src/core/interface/` 是**唯一碰 `node:http` 的地方**，但它只许经 `app/` 与 `view/`
 *    说话：不许 import `agent|channel|team|runtime` 的内部实现，否则业务会再次长回 handler 里。
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

/** 按后缀过滤地遍历任意目录（前端是 ts/tsx，服务端是 ts）。 */
async function* walkAny(dir, keep) {
	for await (const file of walkAll(dir)) {
		if (keep(file)) yield file;
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

/**
 * 分层规则：文件在哪个层 → 它不许 import 什么。
 *
 * 判据用**说明符字符串**匹配而不是解析后的真实路径，理由与上面第 2 条一致：
 * 仓库里全是相对路径（`../../app/...`），字面匹配足够，且对 `../` 的层数不敏感。
 * 唯一要小心的是「同一个词出现在别的层名里」，所以每段都带两侧 `/`。
 */
const LAYER_RULES = [
	// 域的四个目录：不许往上够到外壳、接口、用例、投影。
	{
		dirs: ["src/core/agent/", "src/core/channel/", "src/core/team/", "src/core/runtime/"],
		layer: "领域（agent/channel/team/runtime）",
		deny: [
			{ match: /\/shell\//, reason: "内核不得 import 外壳（shell）" },
			{ match: /\/interface\//, reason: "内核不得 import 接口层（interface）" },
			{ match: /\/app\//, reason: "内核不得 import 用例层（app）" },
			{ match: /\/view\//, reason: "内核不得 import 契约层（view）" },
		],
	},
	// 文档流水线：markdown 解析、插槽渲染、提示词排版。它只有机械 IO，不碰任何业务。
	{
		dirs: ["src/core/md/"],
		layer: "文档（md）",
		deny: [
			{ match: /\/agent\//, reason: "文档层不许 import 领域实现（agent）" },
			{ match: /\/channel\//, reason: "文档层不许 import 领域实现（channel）" },
			{ match: /\/team\//, reason: "文档层不许 import 领域实现（team）" },
			{ match: /\/app\//, reason: "文档层不许 import 用例层（app）" },
			{ match: /\/view\//, reason: "文档层不许 import 契约层（view）" },
			{ match: /\/interface\//, reason: "文档层不许 import 接口层（interface）" },
			{ match: /\/shell\//, reason: "文档层不许 import 外壳（shell）" },
		],
	},
	// 插件：只「加东西」（工具 / 提示词 / 路由 / 听消息），不认识用例、投影与传输。
	{
		dirs: ["src/core/plugin/"],
		layer: "插件（plugin）",
		deny: [
			{ match: /\/agent\//, reason: "插件层不许 import 领域实现（agent）—— 工具由装配层并进注册表" },
			{ match: /\/team\//, reason: "插件层不许 import 领域实现（team）" },
			{ match: /\/app\//, reason: "插件层不许 import 用例层（app）" },
			{ match: /\/view\//, reason: "插件层不许 import 契约层（view）" },
			{ match: /\/interface\//, reason: "插件层不许 import 接口层（interface）" },
			{ match: /\/shell\//, reason: "插件层不许 import 外壳（shell）" },
		],
	},
	// 根目录两个原语（工作区路径、名字规则）：谁都能用，但它们不许往上够。
	{
		dirs: ["src/core/fsx.ts", "src/core/naming.ts"],
		layer: "原语（fsx/naming）",
		deny: [
			{ match: /\/app\//, reason: "原语不许 import 用例层（app）" },
			{ match: /\/view\//, reason: "原语不许 import 契约层（view）" },
			{ match: /\/interface\//, reason: "原语不许 import 接口层（interface）" },
			{ match: /\/shell\//, reason: "原语不许 import 外壳（shell）" },
		],
	},
	// 契约层：零 IO、零运行时。它必须能被单测直接喂一个假状态。
	{
		dirs: ["src/core/view/"],
		layer: "契约（view）",
		deny: [
			{ match: /^node:/, reason: "契约层必须零 IO：不许 import 任何 node:* 内置模块" },
			{ match: /\/runtime\//, reason: "投影层不许碰运行时（runtime）" },
		],
	},
	// 用例：只跟传输层划清界限，文件系统还是要用的（记忆、上传、文件树都是 IO）。
	{
		dirs: ["src/core/app/"],
		layer: "用例（app）",
		deny: [{ match: /^node:(http|https)$/, reason: "用例层不许 import node:http —— 传输归 interface/ 管" }],
	},
	// 接口：唯一碰 node:http 的地方，但只许经 app/view 说话。
	{
		dirs: ["src/core/interface/"],
		layer: "接口（interface）",
		deny: [
			{ match: /\/agent\//, reason: "接口层不许直接 import 领域实现（agent）—— 走 app/" },
			{ match: /\/channel\//, reason: "接口层不许直接 import 领域实现（channel）—— 走 app/" },
			{ match: /\/team\//, reason: "接口层不许直接 import 领域实现（team）—— 走 app/" },
			{ match: /\/runtime\//, reason: "接口层不许直接 import 运行时（runtime）—— 走 app/" },
			// 注意：`../app/` 与 `../view/` 里含有 `app/`、`view/` 字样，但本规则只拦域目录，
			// 所以这两条依赖不被误伤。
		],
	},
];

const violations = [];

for (const dir of CHECKED_DIRS) {
	for await (const file of walk(join(ROOT, dir))) {
		const source = await readFile(file, "utf8");
		const rel = relative(ROOT, file);
		const isFacade = rel.startsWith("src/core/runtime/");
		const isShell = rel.startsWith("src/core/shell/");
		const rules = LAYER_RULES.filter((rule) => rule.dirs.some((dir) => rel.startsWith(dir)));
		for (const spec of importSpecifiers(source)) {
			const offending = RUNTIME_ONLY.find((pkg) => spec === pkg || spec.startsWith(`${pkg}/`));
			if (offending !== undefined && !isFacade) {
				violations.push({ file: rel, spec, reason: `${offending} 只能由 src/core/runtime/ 导入` });
				continue;
			}
			// 内核不得反向依赖外壳：解析后的相对路径里出现 `/shell/` 就是违规
			if (!isShell && /\/shell\//.test(spec)) {
				violations.push({ file: rel, spec, reason: "内核（agent/team/channel）不得 import 外壳（shell）" });
				continue;
			}
			for (const rule of rules) {
				const broken = rule.deny.find((item) => item.match.test(spec));
				if (broken === undefined) continue;
				violations.push({ file: rel, spec, reason: `${rule.layer}：${broken.reason}` });
				break;
			}
		}
	}
}

// ── 第三类：HTTP 路由零消费者 ──
//
// **按「方法 + 路径」判，不按路径**：同一路径上 GET 有消费者，不代表 POST 也有。
// 旧写法只抽 `pattern`，于是 `GET /api/channels` 有消费者就把 `POST /api/channels`
// （一个谁都没调过的建频道接口）一起放过去了 —— 它与 GET 恰好同路径，藏了好几个月。
const ROUTE_FILE = "src/core/interface/http/routes.ts";
const routeSource = await readFile(join(ROOT, ROUTE_FILE), "utf8");
const routeEntries = [...routeSource.matchAll(/pattern:\s*"(\/api\/[^"]*)"[\s\S]{0,200}?method:\s*"([A-Z]+)"/g)].map(
	(match) => ({ pattern: match[1], method: match[2] }),
);
const routes = [
	...new Map(routeEntries.map((entry) => [`${entry.method} ${entry.pattern}`, entry])).values(),
];

/** 已知在仓库外消费的路由（界面不调，但别处要用）。每条都要写清是谁。 */
const NO_CONSUMER_ALLOWED = new Map([
	["GET /api/org", "运维探针：docker-compose.yml 健康检查与外部监控直接打这条"],
	[
		"POST /api/people/:slug/dm",
		"私聊入口后端先行（ADR-097）：界面入口下一轮接，现在由脚本 / 宿主直接调用",
	],
]);

let consumerCorpus = "";
for await (const file of walkAny(join(ROOT, "ui/app/src"), (name) => /\.(ts|tsx)$/.test(name))) {
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

/**
 * 有没有消费者。GET 只看路径；其余方法还要求调用点附近出现对应的 `method: "..."`，
 * 否则「同一路径的 GET 在用」会替一个没人调过的 POST 顶包。
 */
function hasConsumer(prefix, method) {
	const matcher = consumerMatcher(prefix);
	if (method === "GET") return matcher.test(consumerCorpus);
	const global = new RegExp(matcher.source, "g");
	for (const match of consumerCorpus.matchAll(global)) {
		const window = consumerCorpus.slice(match.index, match.index + 300);
		if (new RegExp(`method\\s*:\\s*["']${method}["']`).test(window)) return true;
	}
	return false;
}

for (const { method, pattern } of routes) {
	const key = `${method} ${pattern}`;
	if (NO_CONSUMER_ALLOWED.has(key)) continue;
	const prefix = routePrefix(pattern);
	if (hasConsumer(prefix, method)) continue;
	violations.push({
		file: ROUTE_FILE,
		spec: key,
		reason: `该路由在 ui/app/src 里没有消费者（查找前缀 ${prefix}，方法 ${method}）。接上，或删掉，或写进 NO_CONSUMER_ALLOWED 并注明谁在用`,
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
	`边界检查通过：${CHECKED_DIRS.join(", ")} 未越界导入底层库；` +
		`分层规则 ${LAYER_RULES.length} 组（view 契约层零 IO / app 无 http / interface 只经 app·view）；` +
		`${routes.length} 条路由（方法 + 路径）都有消费者。`,
);
