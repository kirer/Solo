/**
 * 同步转交的等待图测试。
 *
 * 真实事故：CEO 等 CTO，CTO 等负责人，负责人又转交回 CTO。三个会话互相等，
 * 全部永远 running，老板点「立即处理」也返回不了。这里验证环检测能提前拒绝。
 */
import { afterEach, describe, expect, test } from "vitest";
import {
	DelegationCycleError,
	delegationWaits,
	enterDelegation,
	resetDelegationWaits,
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
