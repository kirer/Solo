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
const CHECKED_DIRS = ["src/company", "src/tui", "src/server"];

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

const violations = [];

for (const dir of CHECKED_DIRS) {
	for await (const file of walk(join(ROOT, dir))) {
		const source = await readFile(file, "utf8");
		for (const spec of importSpecifiers(source)) {
			if (ALLOWED.has(spec)) continue;
			const offending = RUNTIME_ONLY.find((pkg) => spec === pkg || spec.startsWith(`${pkg}/`));
			if (offending !== undefined) {
				violations.push({
					file: relative(ROOT, file),
					spec,
					reason: `${offending} 只能由 src/runtime 导入`,
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
