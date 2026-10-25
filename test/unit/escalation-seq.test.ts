/**
 * 升级编号的唯一性契约（回归：跨重启冲突）。
 *
 * 背景：旧实现是模块级内存自增 `let escalationSeq = 0`，进程重启后归零，
 * 重启后的第一条上报会拿到和重启前相同的 `esc:<conv>:1`，导致
 * ①`ensurePending` 认为「同 key 已存在」而不建新待办；②`readOutcome` 读到
 * 旧的已答复条目，把旧答复当成新问题的决定。结果是新问题凭空消失，
 * 提问方收到答非所问的「拍板结果」，全程不报错。
 *
 * 为什么这里断言「量级」而不是「跨进程相等」：
 * 单进程测试无法重置模块状态，所以端到端复现不可靠。但「编号必须含时间戳」
 * 是唯一能保证跨重启不撞车的实现契约——一旦有人改回小整数自增，这条会失败。
 * 语义层面的端到端用例见 test/e2e/escalation.test.ts。
 */
import { describe, expect, test } from "vitest";
import { nextEscalationSeq } from "../../src/company/org.ts";

describe("升级编号跨重启唯一", () => {
	test("编号量级必须与时间戳同阶（小整数自增会撞车）", () => {
		const seq = nextEscalationSeq();
		// 时间戳量级 ~1.7e12；乘以 1000 后 ~1.7e15。
		// 若改回 `escalationSeq += 1`，这里会得到个位数，直接失败。
		expect(seq).toBeGreaterThan(Date.now());
		expect(seq).toBeLessThan(Date.now() * 2000);
	});

	test("连续调用严格递增（同一毫秒内也不得重复）", () => {
		const a = nextEscalationSeq();
		const b = nextEscalationSeq();
		const c = nextEscalationSeq();
		expect(b).toBeGreaterThan(a);
		expect(c).toBeGreaterThan(b);
	});

	test("编号可用于升级标识且互不相同", async () => {
		const { escalationId } = await import("../../src/runtime/ids.ts");
		const keys = new Set<string>();
		for (let i = 0; i < 50; i += 1) keys.add(escalationId(7, nextEscalationSeq()));
		expect(keys.size).toBe(50);
	});
});
