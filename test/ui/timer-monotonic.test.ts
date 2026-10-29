/**
 * 组头秒数「只增不减」不能靠文案反解（审计 P2-1）。
 *
 * 老实现是从组头的 textContent 里 `/(\d+)s/` 抠数字再比较：文案一旦从
 * 「正在执行 · 67s」改成「用时 67 秒」，两边都抠不到，比较恒为 false，
 * 防倒退逻辑就静默失效了 —— 而且没有任何提示。现在秒数单独存在数值里，
 * 文案只负责显示，改文案不影响判断。
 */
import { describe, expect, it } from "vitest";
import { advanceSeconds, runningStatus } from "../../ui/app/src/rows.ts";

describe("advanceSeconds：数值比较，与文案无关", () => {
	it("正常走：秒数随 now 变大", () => {
		expect(advanceSeconds(0, 1_000, 12_000)).toBe(11);
		expect(advanceSeconds(11, 1_000, 68_000)).toBe(67);
	});

	it("时钟被拨回也不倒退：保留上次的秒数", () => {
		// 上次已经显示 67s，这次算出来只有 55s —— 不许往回跳
		expect(advanceSeconds(67, 1_000, 56_000)).toBe(67);
	});

	it("改文案不影响判断（不再从文案里抠数字）", () => {
		// 文案长什么样都无所谓：比较只吃数值。这里把文案换成完全不含 `s` 的写法，
		// 只要 advanceSeconds 还是数值比较，结果就不变。
		const pretty = "正在执行（已用时 67 秒）";
		expect(pretty).not.toMatch(/\d+s/);
		expect(advanceSeconds(67, 1_000, 56_000)).toBe(67);
		expect(advanceSeconds(67, 1_000, 90_000)).toBe(89);
	});

	it("首次没有历史值（dataset 缺省）时直接用当前秒数", () => {
		expect(advanceSeconds(undefined, 1_000, 30_000)).toBe(29);
		expect(advanceSeconds(Number.NaN, 1_000, 30_000)).toBe(29);
	});

	it("显示文案只吃一个秒数", () => {
		expect(runningStatus(67)).toBe("正在执行 · 67s");
		expect(runningStatus(0)).toBe("正在执行 · 0s");
	});
});
