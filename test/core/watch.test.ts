/**
 * 看门狗：异常报告说进频道，但不许刷屏。
 *
 * 钉两件事：
 * 1. 报上来的异常真的变成一句话（不是只躺在 `logs/runtime.jsonl` 里）。
 * 2. 一个坏循环连着报几十条时，频道里只留一条 —— 看门狗自己变成噪音就没意义了。
 */
import { describe, expect, it } from "vitest";
import { createWatch } from "../../src/core/app/watch.ts";

function fakeDiag() {
	const listeners = new Set<(report: { readonly text: string }) => void>();
	return {
		onAbnormal: (listener: (report: { readonly text: string }) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit: (text: string) => {
			for (const listener of listeners) listener({ text });
		},
		count: () => listeners.size,
	};
}

describe("看门狗", () => {
	it("异常报告变成频道里的一句话", async () => {
		const diag = fakeDiag();
		const said: string[] = [];
		const watch = createWatch({
			onAbnormal: diag.onAbnormal,
			notify: async (text) => void said.push(text),
			now: () => 0,
		});
		watch.start();
		diag.emit("任务连续重启超限被挂起：林越");
		await Promise.resolve();
		expect(said).toEqual(["底座报告：任务连续重启超限被挂起：林越"]);
		watch.stop();
	});

	it("10 分钟内只报一条（坏循环不许刷屏），过了窗口才报下一条", async () => {
		const diag = fakeDiag();
		const said: string[] = [];
		let now = 0;
		const watch = createWatch({
			onAbnormal: diag.onAbnormal,
			notify: async (text) => void said.push(text),
			now: () => now,
			gapMs: 1_000,
		});
		watch.start();
		diag.emit("第一条");
		diag.emit("第二条");
		await Promise.resolve();
		expect(said).toHaveLength(1);
		now = 5_000;
		diag.emit("第三条");
		await Promise.resolve();
		expect(said).toEqual(["底座报告：第一条", "底座报告：第三条"]);
		watch.stop();
	});

	it("stop 之后不再收报告（服务关了就别再写频道）", async () => {
		const diag = fakeDiag();
		const said: string[] = [];
		const watch = createWatch({ onAbnormal: diag.onAbnormal, notify: async (text) => void said.push(text), now: () => 0 });
		watch.start();
		expect(diag.count()).toBe(1);
		watch.stop();
		expect(diag.count()).toBe(0);
		diag.emit("停了以后");
		await Promise.resolve();
		expect(said).toEqual([]);
	});
});
