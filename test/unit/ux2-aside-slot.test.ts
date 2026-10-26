/**
 * UX-2 回归门禁：设置面板的「开关」与「槽位宽度」必须是同一个开关。
 *
 * 为什么需要这条测试（而不是靠人点一遍）：
 * UX-2 的病因是「代码层全对、用户看不见」——`setSettingsOpen()` 把面板的
 * `aria-hidden`、`inert` 都翻对了，**每一步都对**；但槽位 `.aside-slot` 的
 * **宽度**由另一个开关控制（当时是 `body[data-chat]`），于是整块被祖先压成 0 宽，
 * 用户看到的就是「点了没反应」，而且**不报错**。
 *
 * 现在的实现把两者收敛到唯一真相 `body[data-settings]`：
 *   `ui/css/settings.css`  `body[data-settings="closed"] .aside-slot { width: 0; ... }`
 *   （槽位规则原本在已删除的 `ui/css/chat.css` 里，随右侧对话面板一起搬过来了）
 *   `ui/js/app.js` `setSettingsOpen()` 里 `document.body.dataset.settings = open ? "open" : "closed"`
 * 本用例断言的就是这两条不再分叉——断言「属性翻了」而不是「宽度多少」，因为在
 * DOM 层，`getComputedStyle('.aside-slot').width > 0` 的唯一输入就是这个属性。
 *
 * 手法：从 `ui/js/app.js` 里**抽真实源码**（不复制粘贴重写，避免「测的是副本」），
 * 跑在一棵最小 DOM 桩上。不启服务、不碰库、不读网络。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const APP_SOURCE = readFileSync(join(ROOT, "ui/js/app.js"), "utf8");
const SETTINGS_CSS = readFileSync(join(ROOT, "ui/css/settings.css"), "utf8");

/** 从 app.js 源码里按函数名抽出一段完整函数体（含 `function` 关键字）。 */
function extractFunction(name: string): string {
	const marker = `\nfunction ${name}(`;
	const start = APP_SOURCE.indexOf(marker);
	if (start < 0) throw new Error(`app.js 里找不到函数 ${name}()`);
	const paramsEnd = APP_SOURCE.indexOf(")", start + marker.length);
	const open = APP_SOURCE.indexOf("{", paramsEnd);
	let depth = 0;
	for (let index = open; index < APP_SOURCE.length; index += 1) {
		const char = APP_SOURCE[index];
		if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return APP_SOURCE.slice(start, index + 1).trim();
		}
	}
	throw new Error(`函数 ${name}() 的花括号不平衡`);
}

type Element = {
	id: string;
	dataset: Record<string, string>;
	attrs: Record<string, string>;
	inert: boolean;
	setAttribute(name: string, value: string): void;
	getAttribute(name: string): string | null;
	querySelector(selector: string): { focus(): void } | null;
};

type Harness = {
	call(open: boolean, options?: { focus?: boolean }): void;
	body: { dataset: Record<string, string> };
	settings: Element;
	toggle: Element;
	warnings: string[];
	refreshed: () => number;
};

/**
 * 建一个最小宿主，把 app.js 的两个真实函数装进去。
 *
 * @param initial 初始 body dataset，取自 `ui/index.html` 的 `<body data-settings="closed">`。
 * @param omit 故意缺失的元素 id（用于覆盖「元素缺失」分支）。
 */
function createHarness(initial: Record<string, string>, omit: readonly string[] = []): Harness {
	const makeElement = (id: string): Element => ({
		id,
		dataset: {},
		attrs: {},
		inert: false,
		setAttribute(name: string, value: string) {
			this.attrs[name] = String(value);
		},
		getAttribute(name: string) {
			return this.attrs[name] ?? null;
		},
		querySelector: () => ({ focus() {} }),
	});
	const settings = makeElement("settings");
	const toggle = makeElement("settings-toggle");
	const byId = new Map<string, Element>([
		["settings", settings],
		["settings-toggle", toggle],
	]);
	for (const id of omit) byId.delete(id);

	const warnings: string[] = [];
	let refreshes = 0;
	const body = { dataset: { ...initial } };

	const context = {
		document: { body, getElementById: (id: string) => byId.get(id) ?? null },
		console: { warn: (message: string) => warnings.push(String(message)) },
		settingsPanel: {
			refresh() {
				refreshes += 1;
			},
		},
	};
	vm.createContext(context);
	vm.runInContext(
		[
			`const $ = (id) => document.getElementById(id);`,
			extractFunction("isSettingsOpen"),
			extractFunction("setSettingsOpen"),
		].join("\n"),
		context,
	);

	return {
		body,
		settings,
		toggle,
		warnings,
		refreshed: () => refreshes,
		call(open: boolean, options = { focus: false }) {
			vm.runInContext(`setSettingsOpen(${JSON.stringify(open)}, ${JSON.stringify(options)})`, context);
		},
	};
}

describe("UX-2 设置面板必须与槽位宽度共用一个开关", () => {
	test("打开设置：body[data-settings] 必须翻成 open（否则槽位 0 宽不可见）", () => {
		const host = createHarness({ settings: "closed" });

		host.call(true);

		// 这就是 UX-2 的判据：槽位宽度只认 data-settings（settings.css），它没开 → 用户看不见。
		expect(host.body.dataset.settings).toBe("open");
		expect(host.settings.inert).toBe(false);
		expect(host.toggle.attrs["aria-expanded"]).toBe("true");
		expect(host.toggle.attrs["aria-pressed"]).toBe("true");
	});

	test("关闭设置：属性、inert、aria 三处一起回到关闭态", () => {
		const host = createHarness({ settings: "closed" });
		host.call(true);

		host.call(false);

		expect(host.body.dataset.settings).toBe("closed");
		expect(host.settings.inert).toBe(true);
		expect(host.toggle.attrs["aria-expanded"]).toBe("false");
	});

	test("重复打开不会互相打架（幂等）", () => {
		const host = createHarness({ settings: "closed" });

		host.call(true);
		host.call(true);

		expect(host.body.dataset.settings).toBe("open");
		expect(host.settings.inert).toBe(false);
	});

	test("打开时刷新一次设置面板（可能在别的标签页/终端里改过）", () => {
		const host = createHarness({ settings: "closed" });

		host.call(true);

		expect(host.refreshed()).toBe(1);
	});

	test("元素缺失不再静默失败：必须留下一条 warn（UX-2 曾被静默 return 藏住）", () => {
		const host = createHarness({ settings: "closed" }, ["settings-toggle"]);

		host.call(true);

		expect(host.warnings).toHaveLength(1);
		expect(host.warnings[0]).toContain("settings-toggle");
		// 缺元素时不得假装打开了：属性保持在初始态。
		expect(host.body.dataset.settings).toBe("closed");
	});
});

describe("UX-2 源码契约：开关标识不得再分叉", () => {
	test("setSettingsOpen 里必须写 body[data-settings]", () => {
		const source = extractFunction("setSettingsOpen");
		expect(source).toContain("document.body.dataset.settings");
	});

	test("setSettingsOpen 不得静默 return（element 缺失时必须 warn）", () => {
		const source = extractFunction("setSettingsOpen");
		expect(source).toContain("console.warn");
	});

	test("settings.css 用 body[data-settings=\"closed\"] 压 .aside-slot 宽度（标识分叉了这条测试要重写）", () => {
		expect(SETTINGS_CSS).toContain('body[data-settings="closed"] .aside-slot');
		// 旧的对话面板开关不该再出现，否则两个开关又会分叉。
		expect(SETTINGS_CSS).not.toContain('body[data-chat="closed"] .aside-slot');
	});
});
