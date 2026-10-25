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
	"RoundtableDoc",
	"TaskDoc",
	"BudgetDoc",
	"ProfileDoc",
];

/** server 层允许直接 import doc 的文件（存量，逐步收敛）。 */
const DOC_IMPORT_ALLOWED = new Set(["src/server/http.ts"]);

/** domain 层里允许 import 的「同层」文件（domain 内部互相依赖是合法的）。 */

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

if (violations.length > 0) {
	console.error("边界检查失败：以下文件直接导入了底层运行时库\n");
	for (const v of violations) {
		console.error(`  ${v.file}`);
		console.error(`    导入: ${v.spec}`);
		console.error(`    原因: ${v.reason}\n`);
	}
	console.error("请改为通过 src/runtime 暴露的接口使用。");
	process.exit(1);
}

console.log(`边界检查通过：${CHECKED_DIRS.join(", ")} 未直接导入底层运行时库。`);
