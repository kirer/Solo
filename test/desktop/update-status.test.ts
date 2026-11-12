/**
 * 「失败一次以后就一直是失败」这个坑（Solo #2409 ①），以及这条状态链真的接上了没有（②）。
 *
 * 为什么这里读源码而不是跑起来：`desktop/src/updates.ts` 一 import 就要 electron 的
 * `app` / `dialog` / `session`，vitest 里起不来。所以两件事分开：
 * - 那句人话怎么算，是纯函数（`update-failure.ts` / `update-line.ts`），有用例；
 * - 「上一次的失败会不会粘住」是**接线**，只能盯源码：`check()` 每次进来自带一个空的
 *   `result`，`finally` 里只在这次没记失败时才写「成功」。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const read = (relpath: string): string => readFileSync(join(REPO, relpath), "utf8");

describe("上一次检查的结论不许粘住", () => {
	const source = read("desktop/src/updates.ts");

	it("每次进 `check()` 都自带一个空的 `result`，`??=` 不再用", () => {
		expect(source).toContain("let result: UpdateCheck | undefined;");
		expect(source).not.toMatch(/lastCheck \?\?=/);
	});

	it("`finally` 里只在这次没记失败时写成功（失败那条不会被盖掉）", () => {
		expect(source).toContain("lastCheck = result ?? { at: Date.now(), ok: true };");
		// 先有空的 result（进 check 时），才有 finally 里那句 —— 反了就是「记完再清」。
		expect(source.indexOf("let result: UpdateCheck | undefined;")).toBeLessThan(
			source.indexOf("lastCheck = result ?? { at: Date.now(), ok: true };"),
		);
	});

	it("失败那条带着人话和 `ok: false`，`status()` 原样递出去", () => {
		expect(source).toContain("result = { at: Date.now(), ok: false, message };");
		expect(source).toContain("status: () => lastCheck,");
	});
});

describe("这条状态链真的接到了界面上", () => {
	it("主进程：`solo:update-status` 只答给自己人（`trusted`）", () => {
		const main = read("desktop/src/main.ts");
		expect(main).toContain('ipcMain.handle("solo:update-status", (event) => (trusted(event) ? (updater?.status() ?? null) : null));');
	});

	it("预加载桥：`updateStatus` 走那条 IPC", () => {
		expect(read("desktop/src/preload.cts")).toContain('updateStatus: () => ipcRenderer.invoke("solo:update-status"),');
	});

	it("类型声明：`soloDesktop.updateStatus` 可选、可 `null`（浏览器里没有这段桥）", () => {
		const declared = read("ui/app/src/desktop.d.ts");
		expect(declared).toContain("updateStatus?: () => Promise<{ at: number; ok: boolean; message?: string } | null>;");
	});

	it("设置页：那行说明用 `updateLine` 算，失败时挂 `data-update-failed`", () => {
		const page = read("ui/app/src/panels/SettingsPage.tsx");
		expect(page).toContain("updateLine({ desktop, version, status })");
		expect(page).toContain("window.soloDesktop");
		expect(page).toContain("?.updateStatus?.()");
		expect(page).toContain('data-update-failed={status !== null && !status.ok ? "true" : undefined}');
		// 打开设置就先看一眼上次的结果（自动检查失败不弹窗，只有这行字）。
		expect(page).toContain("readStatus();");
	});
});
