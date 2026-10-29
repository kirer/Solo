/**
 * 提交串行化。
 *
 * 修的是线上抓到两次的现象：agent 调 `say` 发出去一句话，工具却回
 * `Cannot use a settled overlay`，模型以为没发成于是重发 —— 频道里两条一模一样的话。
 * 底层那次「失败」的提交其实已经写进去了。
 */
import { describe, expect, it } from "vitest";
import { serializedHarness } from "../../src/core/runtime/serialize.ts";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";

/** 假 harness：只实现被测的那一件事，并记录「同时在跑的提交数」。 */
function fakeHarness(delayMs = 5) {
	let running = 0;
	let peak = 0;
	const order: number[] = [];
	const harness = {
		running: () => running,
		peak: () => peak,
		order,
		async commit<T>(change: (tx: undefined) => T | Promise<T>): Promise<T> {
			running += 1;
			peak = Math.max(peak, running);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			const value = await change(undefined);
			running -= 1;
			return value;
		},
		mark(id: number) {
			order.push(id);
		},
	};
	return harness;
}

describe("serializedHarness", () => {
	it("并发提交不重叠：峰值永远是 1", async () => {
		const raw = fakeHarness();
		const harness = serializedHarness(raw as never) as unknown as typeof raw;
		await Promise.all([
			harness.commit(async () => raw.mark(1)),
			harness.commit(async () => raw.mark(2)),
			harness.commit(async () => raw.mark(3)),
		]);
		expect(raw.peak()).toBe(1);
		expect(raw.order).toEqual([1, 2, 3]);
	});

	it("一次提交报错不会让队列停摆", async () => {
		const raw = fakeHarness(1);
		const harness = serializedHarness(raw as never) as unknown as typeof raw;
		await expect(
			harness.commit(() => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		// 后面那次必须照常跑完。
		await expect(harness.commit(async () => "ok")).resolves.toBe("ok");
	});

	it("嵌套提交不死锁", async () => {
		const raw = fakeHarness(1);
		const harness = serializedHarness(raw as never) as unknown as typeof raw;
		const value = await harness.commit(async () => {
			// 提交体内部再提交一次：必须放行而不是自己等自己。
			return harness.commit(async () => "inner");
		});
		expect(value).toBe("inner");
	});

	it("其它成员原样透传且 this 正确", async () => {
		const raw = fakeHarness(1);
		const harness = serializedHarness(raw as never) as unknown as typeof raw;
		expect(harness.peak()).toBe(0);
		await harness.commit(async () => raw.mark(7));
		expect(harness.order).toEqual([7]);
	});

	it("不改动传入的对象", async () => {
		const raw = fakeHarness(1);
		const before = raw.commit;
		serializedHarness(raw as never);
		expect(raw.commit).toBe(before);
	});

	it("context 原样传给底层", async () => {
		const seen: unknown[] = [];
		const raw = {
			async commit<T>(change: (tx: undefined) => T, context: unknown): Promise<T> {
				seen.push(context);
				return change(undefined);
			},
		};
		const harness = serializedHarness(raw as never) as unknown as typeof raw;
		await harness.commit(async () => "x", BACKGROUND_CONTEXT);
		expect(seen).toEqual([BACKGROUND_CONTEXT]);
	});
});
