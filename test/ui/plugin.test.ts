/**
 * 前端插槽注册表：排序、去重、未知插槽。
 *
 * 不测 `bootPlugins`（它要 fetch 和真的 `import`），只测「注册之后读到什么」——
 * 那是插件作者唯一能踩到的地方：重复 id 会画两遍、顺序决定谁在上面。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SLOTS, cellsOf, register } from "../../ui/app/src/plugin/registry.ts";

const nobody = () => null;

describe("插槽注册表", () => {
	it("order 小的先画，没写 order 的按 100", () => {
		register("sidebar.footer", { id: "早", order: 10, component: nobody });
		register("sidebar.footer", { id: "默认", component: nobody });

		expect(cellsOf("sidebar.footer").map((cell) => cell.id)).toEqual(["早", "默认"]);
	});

	it("同 id 只留第一个", () => {
		register("sidebar.footer", { id: "唯一", component: nobody });
		register("sidebar.footer", { id: "唯一", component: nobody });

		expect(cellsOf("sidebar.footer").filter((cell) => cell.id === "唯一")).toHaveLength(1);
	});

	it("两个插槽互不串台", () => {
		register("rightPanel.row", { id: "页签", label: "插件", component: nobody });
		expect(cellsOf("rightPanel.row").map((cell) => cell.id)).toEqual(["页签"]);
		expect(cellsOf("sidebar.footer").map((cell) => cell.id)).not.toContain("页签");
	});
});

/** 界面源码（`ui/app/src`），不含插槽自己的实现目录。 */
function uiSources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "plugin" || entry.name === "styles" ? [] : uiSources(path);
		return entry.name.endsWith(".tsx") ? [path] : [];
	});
}

describe("插槽与宿主对得上", () => {
	// 声明了名字却没画 `<Slot>` 的插槽，插件注册进去会静默消失 —— 这比 TS 报错难查得多。
	// 两种宿主都算：`<Slot name>`（大多数）与直接读注册表的特殊插槽（`rightPanel.row` 是资料表里的行）。
	it("每个 SlotName 在界面里都有宿主", () => {
		const root = fileURLToPath(new URL("../../ui/app/src", import.meta.url));
		const source = uiSources(root)
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");
		for (const name of SLOTS) {
			const hosted = source.includes(`<Slot name="${name}" />`) || source.includes(`cellsOf("${name}")`);
			expect(hosted, `${name} 没有宿主`).toBe(true);
		}
	});
});
