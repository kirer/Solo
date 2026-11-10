/**
 * 正文里的文件路径：点了到底走不走右栏。
 *
 * 季衡报过「点正文里的本地路径没反应」。查下来链路是通的（`markdown.ts` 三处都带
 * `data-path`，`main.tsx` 装 `installPathPreview` 全局委托到 `openRightFile`），
 * 但这条链一直没有测试钉着 —— 任何一头改了都不会有人发现，点了就是死链接。
 * 所以这里守两头：①渲染出来的路径节点带 `data-path`；②委托真的把点击转给回调，
 * 并且不抢 ⌘/Ctrl 点和右键。
 */
import { describe, expect, it } from "vitest";
import { builtinLink, installPathPreview } from "../../ui/app/src/lib/links.ts";
import { renderMarkdown } from "../../ui/app/src/lib/markdown.ts";

describe("正文外链", () => {
	it("http / https 算", () => {
		expect(builtinLink("https://example.com/a?b=1")).toBe(true);
		expect(builtinLink("http://127.0.0.1:7788/")).toBe(true);
		expect(builtinLink("  HTTPS://EXAMPLE.COM  ")).toBe(true);
	});

	it("站内路径、锚点、相对路径不算", () => {
		expect(builtinLink("/channels/1")).toBe(false);
		expect(builtinLink("#section")).toBe(false);
		expect(builtinLink("./doc.md")).toBe(false);
	});

	it("别的协议不算", () => {
		expect(builtinLink("javascript:alert(1)")).toBe(false);
		expect(builtinLink("mailto:hi@example.com")).toBe(false);
		expect(builtinLink("//example.com")).toBe(false);
	});
});

/**
 * 一个够用的假文档：`document` 上挂一个监听表，`click` 能手动派。
 *
 * node 环境没有 `Element`，而 `installPathPreview` 里那句 `target instanceof Element`
 * 是真实存在的守卫（防止点到文本节点），所以这里给全局塞一个占位构造器，只让
 * `instanceof` 能过 —— 不模拟 DOM。
 */
class FakeElement {}

/** 一个够用的假文档：`document` 上挂一个监听表，`click` 能手动派。 */
function fakeDocument(): {
	readonly doc: Document;
	click(node: { closest: (selector: string) => { getAttribute: (name: string) => string | null } | null }, opts?: { button?: number; ctrlKey?: boolean; defaultPrevented?: boolean }): boolean;
} {
	// 收集所有监听器而不是只留最后一个：同一个文档上装了不止一条委托（外链、路径、
	// 破图），测试之间也不清表 —— 只留最后一个会把先前那条覆盖掉。
	const handlers: ((event: unknown) => void)[] = [];
	const doc = {
		addEventListener: (type: string, fn: (event: unknown) => void): void => {
			if (type === "click") handlers.push(fn);
		},
	} as unknown as Document;
	const click = (
		node: { closest: (selector: string) => { getAttribute: (name: string) => string | null } | null },
		opts: { button?: number; ctrlKey?: boolean; defaultPrevented?: boolean } = {},
	): boolean => {
		let prevented = opts.defaultPrevented ?? false;
		const event = {
			button: opts.button ?? 0,
			metaKey: false,
			ctrlKey: opts.ctrlKey ?? false,
			shiftKey: false,
			altKey: false,
			defaultPrevented: false,
			target: node,
			preventDefault: (): void => {
				prevented = true;
			},
		};
		for (const fn of handlers) fn(event);
		return prevented;
	};
	return { doc, click };
}

describe("正文里的本地路径", () => {
	it("行内代码、链接、裸路径都带 data-path", () => {
		expect(renderMarkdown("看 `teams/Solo/memory.md`")).toContain('data-path="teams/Solo/memory.md"');
		expect(renderMarkdown("见 [周报](teams/Solo/workspace/report.md)")).toContain('data-path="teams/Solo/workspace/report.md"');
		expect(renderMarkdown("在 teams/Solo/workspace/report.md 里")).toContain('data-path="teams/Solo/workspace/report.md"');
	});

	it("点路径 → 回调拿到那条路径，并且拦掉默认行为", () => {
		const fake = fakeDocument();
		const opened: string[] = [];
		// 假节点必须真是 `FakeElement` 的实例：`installPathPreview` 里有
		// `target instanceof Element` 这道守卫，不模拟 DOM 也得让它过。
		const original = globalThis.document;
		const originalElement = (globalThis as { Element?: unknown }).Element;
		(globalThis as { document: Document }).document = fake.doc;
		(globalThis as { Element?: unknown }).Element = FakeElement;
		try {
			installPathPreview((path) => opened.push(path));
			const node = Object.assign(new FakeElement(), {
				closest: (selector: string) => (selector === "[data-path]" ? { getAttribute: () => "teams/Solo/memory.md" } : null),
			});
			expect(fake.click(node)).toBe(true);
			expect(opened).toEqual(["teams/Solo/memory.md"]);
		} finally {
			(globalThis as { document: Document }).document = original;
			(globalThis as { Element?: unknown }).Element = originalElement;
		}
	});

	it("⌘/Ctrl 点、非左键都不抢，交给系统", () => {
		const fake = fakeDocument();
		const opened: string[] = [];
		const original = globalThis.document;
		const originalElement = (globalThis as { Element?: unknown }).Element;
		(globalThis as { document: Document }).document = fake.doc;
		(globalThis as { Element?: unknown }).Element = FakeElement;
		try {
			installPathPreview((path) => opened.push(path));
			const node = Object.assign(new FakeElement(), {
				closest: (selector: string) => (selector === "[data-path]" ? { getAttribute: () => "teams/Solo/memory.md" } : null),
			});
			expect(fake.click(node, { ctrlKey: true })).toBe(false);
			expect(fake.click(node, { button: 1 })).toBe(false);
			expect(opened).toEqual([]);
		} finally {
			(globalThis as { document: Document }).document = original;
			(globalThis as { Element?: unknown }).Element = originalElement;
		}
	});

	it("没带 data-path 的地方（正文文字、代码块）点了没反应", () => {
		const fake = fakeDocument();
		const opened: string[] = [];
		const original = globalThis.document;
		const originalElement = (globalThis as { Element?: unknown }).Element;
		(globalThis as { document: Document }).document = fake.doc;
		(globalThis as { Element?: unknown }).Element = FakeElement;
		try {
			installPathPreview((path) => opened.push(path));
			expect(fake.click(Object.assign(new FakeElement(), { closest: () => null }))).toBe(false);
			expect(opened).toEqual([]);
		} finally {
			(globalThis as { document: Document }).document = original;
			(globalThis as { Element?: unknown }).Element = originalElement;
		}
	});
});
