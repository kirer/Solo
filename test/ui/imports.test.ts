/**
 * 前端模块之间的具名导入必须对得上。
 *
 * 为什么要有这一条：`ui/web/` 没有构建步骤，浏览器直接拿 ES module 去链接。
 * 一旦 `app.js` 写了 `import { markGroupDone } from "./rows.js"` 而 `rows.js` 没导出它，
 * 浏览器会在**链接阶段**抛 `Uncaught SyntaxError: The requested module './rows.js'
 * does not provide an export named 'markGroupDone'` —— 整页白屏，一个功能都点不开。
 * 这类错 `tsc --noEmit` 看不见（`ui/web` 是 `.js`，不在 tsconfig 的 include 里），
 * 单测也看不见（没人 import 出错的组合），只有真浏览器会炸。
 *
 * 2026-10-30 就这么白过一次屏：成员改了 `app.js` 和 `rows.js`，只补了一边。
 * 所以在这里静态扫一遍：所有 `import { … } from "./x.js"` 的名字，`x.js` 必须导出。
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../../ui/web/js/", import.meta.url));

/** 一个模块导出了哪些名字（`export function/const/let/class` + `export { a, b as c }`）。 */
function exportsOf(source: string): Set<string> {
	const names = new Set<string>();
	for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
		names.add(match[1] ?? "");
	}
	for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
		for (const part of (match[1] ?? "").split(",")) {
			const name = part.trim().split(/\s+as\s+/).pop()?.trim();
			if (name) names.add(name);
		}
	}
	if (/^export\s+default\s/m.test(source)) names.add("default");
	return names;
}

/** 一个模块 import 了哪些 `{ … }` 名字，来自哪个相对路径。 */
function importsOf(source: string): { from: string; names: string[] }[] {
	const out: { from: string; names: string[] }[] = [];
	for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.\/[^"']+)["']/g)) {
		const names = (match[1] ?? "")
			.split(",")
			.map((part) => part.trim().split(/\s+as\s+/)[0]?.trim() ?? "")
			.filter((name) => name !== "");
		out.push({ from: match[2] ?? "", names });
	}
	return out;
}

const files = readdirSync(dir).filter((name) => name.endsWith(".js"));
const sources = new Map(files.map((name) => [name, readFileSync(dir + name, "utf8")]));

describe("前端模块的具名导入", () => {
	it("扫到的模块不止一两个（别让 glob 失效让这条静默通过）", () => {
		expect(files.length).toBeGreaterThan(10);
	});

	it("每个 import 的名字都在目标模块里导出", () => {
		const problems: string[] = [];
		for (const [name, source] of sources) {
			for (const { from, names } of importsOf(source)) {
				const target = from.replace(/^\.\//, "");
				const exported = sources.get(target);
				if (exported === undefined) {
					problems.push(`${name} → ${target}：文件不存在`);
					continue;
				}
				const have = exportsOf(exported);
				for (const want of names) {
					if (!have.has(want)) problems.push(`${name} → ${target}：没有导出 ${want}`);
				}
			}
		}
		expect(problems).toEqual([]);
	});
});
