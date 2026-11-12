/**
 * 「CSS 读的属性，必须真的有人写」。
 *
 * 来由（Solo 2026-11-12）：悬浮球插件的 `app.entry` 从 2.9.11 起没有 `data-tip`，而
 * `ui/app/src/styles/shell.css` 里 `.set-tools .app-entry::after { content: attr(data-tip) }`
 * 一直读它 —— 设置页那一行入口只剩一个图标，没有文字，四个版本没人发现。删 CSS 的人以为
 * 「全仓没有 CSS 读它」，删属性的人以为「没人用」，两边都在自证清白。
 *
 * 两条钉子：
 * 1. 每个插件的 `app.entry` 都必须同时写 `data-tip` 和 `aria-label`，且文案一字不差
 *    （前者给眼睛看、后者给读屏，缺一个就缺一半人）。
 * 2. 样式表里每个 `attr(<名字>)` 读的属性，必须在「插件和界面真正写出去的属性」集合里，
 *    并且 `data-tip` 这条契约要还活着（读的那一侧被删掉，这条断言也得跟着可见地改）。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** 出厂插件（`seed/`）和首次联网下载的插件（`plugins-src/`）都算。 */
const PLUGIN_ROOTS = ["seed/plugins", "plugins-src"];
const UI_SRC = "ui/app/src";

/** 插件目录里的客户端脚本（都是手写 JS）。 */
async function pluginScripts(): Promise<{ rel: string; text: string }[]> {
	const out: { rel: string; text: string }[] = [];
	for (const root of PLUGIN_ROOTS) {
		// `seed/plugins/` 现在整个不存在（五个出厂插件都在 `plugins-src/`，不随包发）；
		// 目录在才扫，别为了这个 ENOENT。
		const dirs = await readdir(join(ROOT, root)).catch(() => [] as string[]);
		for (const name of dirs) {
			for (const file of await readdir(join(ROOT, root, name))) {
				if (!/\.(js|mjs)$/.test(file)) continue;
				const rel = `${root}/${name}/${file}`;
				out.push({ rel, text: await readFile(join(ROOT, rel), "utf8") });
			}
		}
	}
	return out;
}

/** 目录下所有文件（递归），只留给的后缀。 */
async function walk(rel: string, suffixes: readonly string[]): Promise<string[]> {
	const out: string[] = [];
	for (const item of await readdir(join(ROOT, rel), { withFileTypes: true })) {
		const child = `${rel}/${item.name}`;
		if (item.isDirectory()) out.push(...(await walk(child, suffixes)));
		else if (suffixes.some((one) => item.name.endsWith(one))) out.push(child);
	}
	return out;
}

/**
 * 每个 `className: "app-entry"` 背后那个 props 对象。
 *
 * 从命中处往前找最近的 `{`（就是 props 对象的开头），再往后配平括号 —— 比按行切窗口稳，
 * 属性顺序换了也不受影响；真配不平就直接抛，宁可红也别悄悄放过。
 */
function appEntryProps(rel: string, source: string): string[] {
	const needle = "className: \"app-entry\"";
	const out: string[] = [];
	let from = 0;
	for (;;) {
		const at = source.indexOf(needle, from);
		if (at === -1) break;
		from = at + needle.length;
		const open = source.lastIndexOf("{", at);
		let depth = 0;
		let end = -1;
		for (let i = open; i < source.length; i += 1) {
			const char = source[i];
			if (char === "{") depth += 1;
			else if (char === "}") {
				depth -= 1;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		if (end === -1) throw new Error(`${rel}：app-entry 的 props 对象括号没配平`);
		out.push(source.slice(open, end + 1));
	}
	return out;
}

/** props 里某个字符串属性的值（只认字面量，`active ? … : …` 这种不算）。 */
function propValue(props: string, name: string): string | undefined {
	// 键可带引号可不带（`id: "x"` 与 `"data-tip": "x"` 都见过）。
	return new RegExp(`["]?${name}["]?\\s*:\\s*"([^"]*)"`).exec(props)?.[1];
}

describe("插件的 app.entry", () => {
	it("每个入口都写了 data-tip 和 aria-label，而且文案一字不差", async () => {
		const problems: string[] = [];
		let found = 0;
		for (const { rel, text } of await pluginScripts()) {
			const entries = appEntryProps(rel, text);
			// 注册了 app.entry 的插件，必须真能找到一个入口 —— 只改类名的话这里当场红。
			if (text.includes("register(\"app.entry\"") && entries.length === 0) {
				problems.push(`${rel}：注册了 app.entry，却没有 className: "app-entry" 的入口`);
			}
			for (const props of entries) {
				found += 1;
				const tip = propValue(props, "data-tip");
				const label = propValue(props, "aria-label");
				const id = propValue(props, "id") ?? "（没有 id）";
				if (tip === undefined || tip.trim() === "") {
					problems.push(`${rel} / ${id}：没有 data-tip（CSS 拿 attr(data-tip) 当文字）`);
				}
				if (label === undefined || label.trim() === "") {
					problems.push(`${rel} / ${id}：没有 aria-label（读屏念不出这一行）`);
				}
				if (tip !== undefined && label !== undefined && tip !== label) {
					problems.push(`${rel} / ${id}：data-tip「${tip}」和 aria-label「${label}」不一致`);
				}
			}
		}
		// 一个都扫不到 = 这套检查失效了（类名改了 / 目录挪了），别让它空过。
		expect(found, "一个 app.entry 都没扫到，检查本身失效了").toBeGreaterThanOrEqual(3);
		expect(problems).toEqual([]);
	});
});

describe("样式表读的属性", () => {
	it("每个 attr(<名字>) 读的属性都有人写，data-tip 这条契约还活着", async () => {
		// 读的一侧：`ui/app/src/styles/*.css` 里所有 `attr(…)`。
		const read = new Map<string, string[]>();
		for (const rel of await walk(`${UI_SRC}/styles`, [".css"])) {
			const text = await readFile(join(ROOT, rel), "utf8");
			for (const match of text.matchAll(/attr\(\s*["\u0027]?([a-zA-Z-]+)["\u0027]?\s*\)/g)) {
				const name = match[1] ?? "";
				read.set(name, [...(read.get(name) ?? []), rel]);
			}
		}

		// 写的一侧：插件脚本里的 `"data-x":` 加界面（TS/TSX）里的 `data-x=` 与 `"data-x":`。
		const written = new Set<string>();
		const collect = (text: string): void => {
			for (const match of text.matchAll(/"(data-[a-z-]+)"\s*[:,]/g)) written.add(match[1] ?? "");
			for (const match of text.matchAll(/\s(data-[a-z-]+)=/g)) written.add(match[1] ?? "");
		};
		for (const { text } of await pluginScripts()) collect(text);
		for (const rel of await walk(UI_SRC, [".ts", ".tsx"])) collect(await readFile(join(ROOT, rel), "utf8"));

		const orphan = [...read]
			.filter(([name]) => !written.has(name))
			.map(([name, files]) => `${name}（${files.join("、")} 在读）`);
		expect(orphan, "样式表读了一个没人写的属性").toEqual([]);
		expect([...read.keys()], "shell.css 的 .app-entry::after 不再读 data-tip 了？那这条契约要跟着改").toContain("data-tip");
	});
});
