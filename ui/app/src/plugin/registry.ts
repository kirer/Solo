/**
 * 前端插槽：插件往哪里放东西，以及装插件的那一次 `import`。
 *
 * 为什么是「先装插件，再挂载」而不是运行时订阅：插槽只在启动时填一次，装完就不变 ——
 * 那就不需要订阅、不需要 `useSyncExternalStore`，`<Slot>` 直接读数组即可。少一层状态，
 * 少一类「插件在渲染中途注册了一半」的怪问题。改插件 = 刷新页面（第一版不做热更新）。
 *
 * 插件拿不到 `ctx`，也拿不到别的插件的模块：它只收到 `ui` 这一个对象（React + 注册器 +
 * 现有的 `api/` 客户端）。这是 dsh 那条规矩的简化版 —— 跨插件协作只经插槽。
 */
import * as React from "react";
import * as client from "../api/client.ts";
import * as store from "../state/store.ts";
import { useStore } from "../state/useStore.ts";
import type { Plugin } from "../api/types.ts";

/**
 * 声明出来的插槽。加一个插槽 = 这里加一个名字 + 宿主里画一个 `<Slot>`。
 *
 * 名字是 `区域.位置`：前一段是界面的哪一块，后一段是那一块里的哪个缺口。
 * 一条规矩：**插槽只在自己的容器里占位**，宿主不给它画外框、不留空框 ——
 * 所以插件放在顶栏 / 输入框那种横排里的东西，自己要是横排的尺寸（见 DESIGN §2.8）。
 */
export type SlotName =
	| "sidebar.header"
	| "sidebar.list.before"
	| "sidebar.footer"
	| "topbar.actions"
	| "stream.top"
	| "stream.bottom"
	| "composer.actions"
	| "rightPanel.tab"
	| "rightPanel.detail"
	| "rightPanel.bottom"
	| "settings.section"
	| "overlays";

export type SlotCell = {
	/** 同一插槽里唯一。重复 id 的注册被忽略（StrictMode、重复 boot 都不会画两遍）。 */
	readonly id: string;
	/** `rightPanel.tab` 的页签文字；`settings.section` 的分区名。别的插槽用不到。 */
	readonly label?: string;
	/** `settings.section` 左栏那一格前面的图标（一个 SVG 元素）。不画就只留文字。 */
	readonly icon?: React.ReactNode;
	/** 小的先渲染，默认 100。 */
	readonly order?: number;
	readonly component: React.ComponentType;
};

/** 插件前端入口的默认导出。 */
export type ClientPlugin = {
	readonly id: string;
	/** 插件自己的样式（一段 CSS 文本），宿主插进 `<head>`。 */
	readonly style?: string;
	apply(ui: Ui): void;
};

/** 插件 `apply` 拿到的那一个对象。 */
export type Ui = {
	readonly h: typeof React.createElement;
	readonly React: typeof React;
	/** 现有的接口客户端（`getOrg` / `sendMessage` / …）。 */
	readonly api: typeof client;
	/** 界面状态：`read()` 拿快照、`openChannel` / `send` 这类动作都在这里。 */
	readonly store: typeof store;
	/** `store` 之上的那个订阅钩子 —— 插件组件在 `component` 里用它读当前频道 / 消息。 */
	readonly useStore: typeof useStore;
	register(slot: SlotName, cell: SlotCell): void;
};

/** 全部插槽。`<Slot name>` 只能用这里的名字（TS 卡着），测试也照这份表查宿主有没有画。 */
export const SLOTS: readonly SlotName[] = [
	"sidebar.header",
	"sidebar.list.before",
	"sidebar.footer",
	"topbar.actions",
	"stream.top",
	"stream.bottom",
	"composer.actions",
	"rightPanel.tab",
	"rightPanel.detail",
	"rightPanel.bottom",
	"settings.section",
	"overlays",
];
const cells = new Map<SlotName, SlotCell[]>(SLOTS.map((name) => [name, []]));

export function register(slot: SlotName, cell: SlotCell): void {
	const list = cells.get(slot);
	if (list === undefined || list.some((item) => item.id === cell.id)) return;
	list.push(cell);
	list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/** 某个插槽此刻的格子。`<Slot>` 与右栏页签都读这一份。 */
export function cellsOf(slot: SlotName): readonly SlotCell[] {
	return cells.get(slot) ?? [];
}

const ui: Ui = { h: React.createElement, React, api: client, store, useStore, register };

/**
 * 拉插件清单，逐个 `import` 它的前端入口并 `apply`。
 *
 * **失败只警告**：一个插件的前端炸了不该让整页白屏 —— 那是「插件没生效」，
 * 不是「Solo 坏了」。后端同理，两边都不互相拖累。
 */
/** 前端入口的地址。服务端只说「有没有」，地址在这里拼一次。 */
function clientUrlOf(slug: string): string {
	return `/api/plugins/${encodeURIComponent(slug)}/client.js`;
}

export async function bootPlugins(): Promise<void> {
	let plugins: readonly Plugin[];
	try {
		plugins = (await client.getPlugins()).plugins;
	} catch {
		return;
	}

	for (const plugin of plugins) {
		// 关掉的插件服务端不发前端入口（会 404），别在这里白试一次。
		if (plugin.enabled !== true || plugin.client !== true) continue;
		try {
			const module = (await import(/* @vite-ignore */ clientUrlOf(plugin.slug))) as { default?: ClientPlugin };
			const definition = module.default;
			if (definition === undefined) throw new Error("前端入口没有 export default");
			if (typeof definition.style === "string" && definition.style.trim() !== "") {
				const style = document.createElement("style");
				style.dataset.plugin = plugin.slug;
				style.textContent = definition.style;
				document.head.appendChild(style);
			}
			definition.apply({ ...ui, register: (slot, cell) => register(slot, { ...cell, id: `${plugin.slug}:${cell.id}` }) });
		} catch (error) {
			console.warn(`[plugin] ${plugin.slug} 的前端没装上：`, error);
		}
	}
}
