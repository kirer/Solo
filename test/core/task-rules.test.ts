/**
 * 状态机 5×5 逐格 + 权限矩阵（2.9.20 第三笔的规矩层）。
 *
 * 逐格写死，不写「一张表 + for 循环」：要的就是「有人偷偷松掉一格」时红在一个具名的
 * 格子上，而不是红在一条看不出是哪格失败的循环里。
 */
import { describe, expect, test } from "vitest";
import { checkMove, checkPermission, canCreate, type TaskChange } from "../../src/core/channel/task-rules.ts";
import type { TaskStatus } from "../../src/core/channel/types.ts";

const ALL: readonly TaskStatus[] = ["open", "doing", "blocked", "done", "dropped"];

describe("状态机：能走的路一步不少，不能走的一步不许", () => {
	// 第十一节验收第 1 条：11 条能走。
	const allowed: readonly [TaskStatus, TaskStatus, string?][] = [
		["open", "doing"],
		["open", "dropped", "不做了"],
		["doing", "open"],
		["doing", "blocked", "等界面那边定形状"],
		["doing", "done"],
		["doing", "dropped", "换了方案"],
		["blocked", "open"],
		["blocked", "doing"],
		["blocked", "done"],
		["blocked", "dropped", "这条并进 t3 了"],
	];
	for (const [from, to, note] of allowed) {
		test(`${from} → ${to} 能走`, () => {
			expect(checkMove(from, to, note)).toEqual({ ok: true });
		});
	}

	test("5×5 里除了上面这 10 格和 5 个同状态，其余全拒", () => {
		const passable = new Set(allowed.map(([from, to]) => `${from}>${to}`));
		for (const from of ALL) {
			for (const to of ALL) {
				if (passable.has(`${from}>${to}`)) continue;
				const result = checkMove(from, to, "有原因");
				expect(result.ok, `${from} → ${to} 不该能走`).toBe(false);
				// 同状态、终态、不存在的边，三种说法要分开。
				if (from === to) expect(result).toEqual({ ok: false, why: "same" });
				else if (from === "done" || from === "dropped") expect(result).toEqual({ ok: false, why: "terminal" });
				else expect(result).toEqual({ ok: false, why: "invalid" });
			}
		}
	});

	test("带 * 的两处不带原因就拒，空白也算没写", () => {
		expect(checkMove("doing", "blocked", undefined)).toEqual({ ok: false, why: "note" });
		expect(checkMove("doing", "blocked", "   ")).toEqual({ ok: false, why: "note" });
		expect(checkMove("open", "dropped", "")).toEqual({ ok: false, why: "note" });
		// 不带 * 的那几步不要求原因。
		expect(checkMove("doing", "done", undefined)).toEqual({ ok: true });
		expect(checkMove("doing", "open", "")).toEqual({ ok: true });
	});

	test("终态一步都不许回退", () => {
		for (const from of ["done", "dropped"] as const) {
			for (const to of ALL) {
				if (to === from) continue;
				expect(checkMove(from, to, "想复活")).toEqual({ ok: false, why: "terminal" });
			}
		}
	});
});

describe("权限：成员只在自己名下能动，且不能划掉", () => {
	const member = { slug: "甲", assistant: false };
	const assistant = { slug: "助理", assistant: true };
	const mine = { owner: "甲" };
	const others = { owner: "乙" };

	const change = (to: TaskStatus): TaskChange => ({ kind: "status", to });

	test("自己名下：open / doing / blocked / done 都能改", () => {
		for (const to of ["open", "doing", "blocked", "done"] as const) {
			expect(checkPermission(member, mine, change(to))).toEqual({ ok: true });
		}
	});

	test("自己名下也不许划掉", () => {
		expect(checkPermission(member, mine, change("dropped"))).toEqual({ ok: false, why: "dropped" });
	});

	test("别人名下的：一律不动，拒法是 not-owner", () => {
		expect(checkPermission(member, others, change("doing"))).toEqual({ ok: false, why: "not-owner" });
		expect(checkPermission(member, others, change("dropped"))).toEqual({ ok: false, why: "not-owner" });
	});

	test("换负责人：成员不行，助理行", () => {
		expect(checkPermission(member, mine, { kind: "owner", owner: "乙" })).toEqual({ ok: false, why: "assign" });
		expect(checkPermission(assistant, others, { kind: "owner", owner: "甲" })).toEqual({ ok: true });
	});

	test("改验收标准：自己名下能补，别人的不能", () => {
		expect(checkPermission(member, mine, { kind: "accept", accept: "测试全过" })).toEqual({ ok: true });
		expect(checkPermission(member, others, { kind: "accept", accept: "测试全过" })).toEqual({ ok: false, why: "not-owner" });
	});

	test("助理全都能改（含划掉）", () => {
		for (const to of ALL) expect(checkPermission(assistant, others, change(to))).toEqual({ ok: true });
	});

	test("新建：只有助理；成员建不了", () => {
		expect(canCreate(assistant)).toEqual({ ok: true });
		expect(canCreate(member)).toEqual({ ok: false, why: "add" });
	});
});
