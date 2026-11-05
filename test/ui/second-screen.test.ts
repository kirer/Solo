/**
 * 第二屏互斥：任务 / 插件 / 设置 / 插件页都是**占满整块**的屏，
 * 同一时刻只能画一处 —— 两处同时开着会叠在一起互相压住（真实踩过：
 * 后台任务和插件页叠成一张，两个导航格同时亮着）。
 *
 * 这里测的是 store 的开关本身，不测渲染：只要打开任何一个都让其它让路，
 * `App` 里那个 `view` 就不会算出两屏并存。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	closePluginView,
	openPluginView,
	openTasks,
	setPluginSheet,
	setSettings,
	getState,
} from "../../ui/app/src/state/store.ts";

/** 现在开着哪几屏（正常情况应该恰好 0 或 1 个）。 */
const open = (): string[] => {
	const state = getState();
	return [
		state.tasks.open ? "tasks" : undefined,
		state.pluginSheet ? "plugins" : undefined,
		state.settings ? "settings" : undefined,
		state.pluginView !== null ? "plugin" : undefined,
	].filter((item): item is string => item !== undefined);
};

beforeEach(() => {
	openPluginView("__none__");
	closePluginView();
});

describe("第二屏互斥", () => {
	it("开任务（右栏的一态），把其它屏关掉", () => {
		setPluginSheet(true);
		expect(open()).toEqual(["plugins"]);
		openTasks();
		expect(open()).toEqual(["tasks"]);
	});

	it("开插件 / 设置，都把任务屏关掉", () => {
		for (const turn of [() => setPluginSheet(true), () => setSettings(true)]) {
			openTasks();
			expect(open()).toEqual(["tasks"]);
			turn();
			expect(open()).toHaveLength(1);
			expect(open()[0]).not.toBe("tasks");
		}
	});

	it("三屏之间也互斥，打开一个只留一个", () => {
		openTasks();
		setPluginSheet(true);
		expect(open()).toEqual(["plugins"]);
		setSettings(true);
		expect(open()).toEqual(["settings"]);
	});

	it("插件自己的一页同样让其它屏让路（打开与关闭都只动这一屏）", () => {
		openTasks();
		openPluginView("demo");
		expect(open()).toEqual(["plugin"]);
		closePluginView();
		expect(open()).toEqual([]);
	});
});
