/**
 * 同步转交的等待图测试。
 *
 * 真实事故：CEO 等 CTO，CTO 等负责人，负责人又转交回 CTO。三个会话互相等，
 * 全部永远 running，老板点「立即处理」也返回不了。这里验证环检测能提前拒绝。
 */
import { afterEach, describe, expect, test } from "vitest";
import {
	DEFAULT_DELEGATION_TIMEOUT_MS,
	DelegationCycleError,
	DelegationTimeoutError,
	delegationWaits,
	enterDelegation,
	releaseDelegation,
	resetDelegationWaits,
	waitWithTimeout,
} from "../../src/company/delegation-guard.ts";

afterEach(() => {
	resetDelegationWaits();
});

describe("转交环检测", () => {
	test("普通转交可以登记，释放后清空", () => {
		const release = enterDelegation(1, 7);
		expect(delegationWaits().get(1)).toBe(7);
		release();
		expect(delegationWaits().has(1)).toBe(false);
	});

	test("两边互相转交时，第二次被拒绝", () => {
		const releaseA = enterDelegation(1, 7);

		let error: unknown;
		try {
			enterDelegation(7, 1);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(DelegationCycleError);
		expect((error as DelegationCycleError).path).toEqual([7, 1, 7]);
		releaseA();
	});

	test("三方闭环也能识别", () => {
		const releaseA = enterDelegation(1, 7);
		const releaseB = enterDelegation(7, 613);
		expect(() => enterDelegation(613, 1)).toThrow(DelegationCycleError);
		releaseA();
		releaseB();
	});

	test("同一会话连续转交不同目标不算环", () => {
		const first = enterDelegation(1, 7);
		first();
		const second = enterDelegation(1, 19);
		expect(delegationWaits().get(1)).toBe(19);
		second();
	});

	test("自己转交给自己被拒绝", () => {
		expect(() => enterDelegation(5, 5)).toThrow(DelegationCycleError);
	});
});

describe("同步等待必须有上限", () => {
	test("默认上限是 180 秒", () => {
		expect(DEFAULT_DELEGATION_TIMEOUT_MS).toBe(180_000);
	});

	test("超时抛出 DelegationTimeoutError，而不是永远挂着", async () => {
		// 永不 settle 的等待：这正是「员工那轮永远跑不完」的形状
		const never = new Promise<string>(() => undefined);
		const started = Date.now();

		let error: unknown;
		try {
			await waitWithTimeout(never, 50);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(DelegationTimeoutError);
		expect((error as DelegationTimeoutError).timeoutMs).toBe(50);
		expect(Date.now() - started, "必须在 50ms 量级返回，不能等到进程结束").toBeLessThan(2_000);
	});

	test("超时后原 Promise 的拒绝不会变成未处理拒绝", async () => {
		let reject: (reason: unknown) => void = () => undefined;
		const pending = new Promise<string>((_resolve, rejectFn) => {
			reject = rejectFn;
		});

		await expect(waitWithTimeout(pending, 20)).rejects.toBeInstanceOf(DelegationTimeoutError);
		// 超时之后底层才失败：不应把进程带崩（挂了空 catch）
		reject(new Error("迟到的失败"));
		await new Promise((resolve) => setTimeout(resolve, 30));
	});

	test("按时完成时正常返回，不误报超时", async () => {
		await expect(waitWithTimeout(Promise.resolve("答完了"), 5_000)).resolves.toBe("答完了");
	});

	test("timeoutMs 为 0 表示不设上限", async () => {
		await expect(waitWithTimeout(Promise.resolve(1), 0)).resolves.toBe(1);
	});

	test("abort 信号能立刻打断等待", async () => {
		const controller = new AbortController();
		const never = new Promise<string>(() => undefined);
		const waiting = waitWithTimeout(never, 60_000, { signal: controller.signal });
		controller.abort(new Error("老板点了立即处理"));
		await expect(waiting).rejects.toThrow("老板点了立即处理");
	});
});

describe("超时后必须释放等待图", () => {
	test("超时并释放后，反向转交不会被假环挡住", async () => {
		// 1 等 7，超时放弃
		const release = enterDelegation(1, 7);
		await expect(waitWithTimeout(new Promise(() => undefined), 10)).rejects.toBeInstanceOf(
			DelegationTimeoutError,
		);
		release();

		// 7 现在可以回头等 1：图里已经没有 1 → 7 这条边了
		expect(delegationWaits().has(1)).toBe(false);
		const reverse = enterDelegation(7, 1);
		reverse();
	});

	test("releaseDelegation 能强制清掉残留的边", () => {
		enterDelegation(1, 7);
		expect(delegationWaits().get(1)).toBe(7);
		releaseDelegation(1);
		expect(delegationWaits().has(1)).toBe(false);
	});
});
