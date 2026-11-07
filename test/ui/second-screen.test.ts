/**
 * 第二屏：设置是那张弹窗的壳，插件清单与插件自己的页是它的下一层。
 *
 * 同一时刻只有一个外壳在画（`App` 里 `settings` 一真就算「在设置里」）；
 * 插件清单 / 插件页不再另起一层浮层。打开任何一层都要把任务屏让开，
 * 关掉时退一层而不是一路关到底（ADR-099）。
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

/** 现在开着哪几层（设置在最底下，上面最多压一层插件页 / 插件清单）。 */
const open = (): string[] => {
	const state = getState();
	return [
		state.settings ? "settings" : undefined,
		state.pluginSheet ? "plugins" : undefined,
		state.pluginView !== null ? "plugin" : undefined,
		state.tasks.open ? "tasks" : undefined,
	].filter((item): item is string => item !== undefined);
};

beforeEach(() => {
	openPluginView("__none__");
	closePluginView();
	setSettings(false);
	setPluginSheet(false);
});

describe("设置的层叠", () => {
	it("开任务（右栏的一态），把设置让开", () => {
		setPluginSheet(true);
		expect(open()).toEqual(["settings", "plugins"]);
		openTasks();
		expect(open()).toEqual(["tasks"]);
	});

	it("开插件清单 / 设置，都把任务屏关掉，并且只有一个外壳", () => {
		openTasks();
		expect(open()).toEqual(["tasks"]);
		setPluginSheet(true);
		expect(open()).toEqual(["settings", "plugins"]);
		setSettings(false);
		openTasks();
		setSettings(true);
		expect(open()).toEqual(["settings"]);
	});

	it("开设置时把上一层插件页收掉", () => {
		openPluginView("demo");
		expect(open()).toEqual(["settings", "plugin"]);
		setSettings(true);
		expect(open()).toEqual(["settings"]);
	});

	it("插件自己的一页让任务让路，关掉只退一层（回设置，不是回聊天）", () => {
		openTasks();
		openPluginView("demo");
		expect(open()).toEqual(["settings", "plugin"]);
		closePluginView();
		expect(open()).toEqual(["settings"]);
	});

	it("插件清单的返回也只退一层", () => {
		setPluginSheet(true);
		setPluginSheet(false);
		expect(open()).toEqual(["settings"]);
	});
});
