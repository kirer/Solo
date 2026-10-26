/**
 * UX-2 回归门禁：设置视图与对话槽位的两个开关必须同步。
 *
 * 为什么需要这条测试（而不是靠人点一遍）：
 * UX-2 的病因是「代码层全对、用户看不见」——
 * `showAsideView()` 把 `data-view-aside` 翻成 `settings`、把 `#settings` 的
 * `aria-hidden` 设成 `false`、把 `#chat` 设成 `inert`，**每一步都对**；
 * 但槽位 `.aside-slot` 的**宽度**由另一个开关 `body[data-chat]` 控制
 * （`ui/css/chat.css:41`：`body[data-chat="closed"] .aside-slot { width: 0; visibility: hidden }`），
 * 于是整块被祖先压成 0 宽 —— 用户看到的就是「点了没反应」，而且**不报错**。
 *
 * 所以本用例断言的不是「属性翻了」，而是**打开设置后槽位是开着的**：
 *   `document.body.dataset.chat === "open"`
 * 这正是 `getComputedStyle('.aside-slot').width > 0` 在 DOM 层的等价条件
 * （宽度规则的唯一输入就是 `data-chat`，见 `chat.css:41-50`）。
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
	call(view: "chat" | "settings"): string;
	body: { dataset: Record<string, string> };
	settings: Element;
	chat: Element;
	toggle: Element;
	setMobile(matches: boolean): void;
	warnings: string[];
};

/**
 * 建一个最小宿主，把 app.js 的三个真实函数装进去。
 *
 * @param initial 初始 body dataset，逐字取自 `ui/index.html:36` 的场景。
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
	const chat = makeElement("chat");
	const toggle = makeElement("settings-toggle");
	const byId = new Map<string, Element>([
		["settings", settings],
		["chat", chat],
		["settings-toggle", toggle],
	]);
	for (const id of omit) byId.delete(id);

	const warnings: string[] = [];
	let mobile = false;
	const body = { dataset: { ...initial } };

	const context = {
		document: { body, getElementById: (id: string) => byId.get(id) ?? null },
		console: { warn: (message: string) => warnings.push(String(message)) },
		// 每次调用实时读匹配结果：真实浏览器里 MediaQueryList.matches 也是随视口变化的。
		window: { matchMedia: () => ({ get matches() { return mobile; } }) },
		settingsPanel: { refresh() {} },
	};
	vm.createContext(context);
	vm.runInContext(
		[
			`const $ = (id) => document.getElementById(id);`,
			`const MOBILE_QUERY = window.matchMedia("(max-width: 860px)");`,
			`const ASIDE_VIEW = { chat: "chat", settings: "settings" };`,
			`const settingsPanel = { refresh() {} };`,
			extractFunction("asideView"),
			extractFunction("showAsideView"),
		].join("\n"),
		context,
	);

	return {
		body,
		settings,
		chat,
		toggle,
		warnings,
		setMobile(matches: boolean) {
			mobile = matches;
		},
		call(view: "chat" | "settings") {
			return vm.runInContext(`showAsideView(${JSON.stringify(view)}, { focus: false })`, context) as string;
		},
	};
}

describe("UX-2 设置视图必须把对话槽位打开", () => {
	test("对话已收起时点设置：槽位开关必须被打开（否则整块 0 宽不可见）", () => {
		const host = createHarness({ chat: "closed", sheet: "closed", viewAside: "chat" });

		const result = host.call("settings");

		expect(result).toBe("settings");
		expect(host.body.dataset.viewAside).toBe("settings");
		// 这就是 UX-2 的判据：槽位宽度只认 data-chat（chat.css:41），它没开 → 用户看不见。
		expect(host.body.dataset.chat).toBe("open");
		expect(host.settings.attrs["aria-hidden"]).toBe("false");
		expect(host.chat.inert).toBe(true);
	});

	test("对话本来开着时点设置：不得把它误关", () => {
		const host = createHarness({ chat: "open", sheet: "closed", viewAside: "chat" });

		host.call("settings");

		expect(host.body.dataset.chat).toBe("open");
		expect(host.body.dataset.viewAside).toBe("settings");
	});

	test("窄屏不动 data-chat：槽位宽度不参与布局，动了会误伤抽屉状态", () => {
		const host = createHarness({ chat: "closed", sheet: "closed", viewAside: "chat" });
		host.setMobile(true);

		host.call("settings");

		expect(host.body.dataset.viewAside).toBe("settings");
		expect(host.body.dataset.chat).toBe("closed");
	});

	test("返回对话：视图翻回 chat，且不销毁聊天 DOM（#chat 退出 inert）", () => {
		const host = createHarness({ chat: "closed", sheet: "closed", viewAside: "chat" });
		host.call("settings");

		host.call("chat");

		expect(host.body.dataset.viewAside).toBe("chat");
		expect(host.chat.inert).toBe(false);
		expect(host.settings.attrs["aria-hidden"]).toBe("true");
		expect(host.settings.inert).toBe(true);
	});

	test("已经停在设置、但槽位后来被收起：再点设置必须把槽位救回来", () => {
		// 真实路径：停在设置 → 窄屏切换/对话收起把 data-chat 置为 closed → 回来再点设置。
		// 若这里被 `asideView() === next` 早退，表现同样是「点了没反应」。
		const host = createHarness({ chat: "closed", sheet: "closed", viewAside: "settings" });

		host.call("settings");

		expect(host.body.dataset.viewAside).toBe("settings");
		expect(host.body.dataset.chat).toBe("open");
	});

	test("关闭已关闭的视图：仍然早退，不做无谓的重排", () => {
		const host = createHarness({ chat: "open", sheet: "closed", viewAside: "chat" });

		host.call("chat");

		expect(host.body.dataset.viewAside).toBe("chat");
		expect(host.body.dataset.chat).toBe("open");
	});

	test("元素缺失不再静默失败：必须留下一条 warn（UX-2 曾被静默 return 藏住）", () => {
		const host = createHarness({ chat: "open", sheet: "closed", viewAside: "chat" }, ["settings-toggle"]);

		host.call("settings");

		expect(host.warnings).toHaveLength(1);
		expect(host.warnings[0]).toContain("settings-toggle");
		expect(host.body.dataset.viewAside).toBe("chat");
	});
});

describe("UX-2 源码契约：槽位宽度开关与视图开关不得再分叉", () => {
	test("showAsideView 里必须存在同步 data-chat 的那一行", () => {
		const source = extractFunction("showAsideView");
		expect(source).toContain('document.body.dataset.chat = "open"');
	});

	test("showAsideView 不得静默 return（element 缺失时必须 warn）", () => {
		const source = extractFunction("showAsideView");
		expect(source).toContain('console.warn("[aside]');
	});

	test("chat.css 仍然用 body[data-chat=\"closed\"] 压 .aside-slot 宽度（前提变了这条测试要重写）", () => {
		const css = readFileSync(join(ROOT, "ui/css/chat.css"), "utf8");
		expect(css).toContain('body[data-chat="closed"] .aside-slot');
	});
});
