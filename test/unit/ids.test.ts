/**
 * 语义化请求标识的单元测试。
 *
 * 这些标识是崩溃恢复「至少一次」语义下的去重依据（ADR-006），
 * 所以稳定性是正确性要求，不是风格偏好。
 */
import { describe, expect, test } from "vitest";
import {
	delegationRequestId,
	escalationId,
	messageRequestId,
	ownerDecisionRequestId,
	projectSlug,
	reportRequestId,
} from "../../src/runtime/ids.ts";

describe("派活请求标识", () => {
	test("同输入生成同标识", () => {
		expect(delegationRequestId("task-1", "dev-1")).toBe(delegationRequestId("task-1", "dev-1"));
	});

	test("不同输入生成不同标识", () => {
		const a = delegationRequestId("task-1", "dev-1");
		const b = delegationRequestId("task-2", "dev-1");
		const c = delegationRequestId("task-1", "dev-2");
		const d = delegationRequestId("task-1", "dev-1", 1);
		expect(new Set([a, b, c, d]).size).toBe(4);
	});

	test("大小写与空格被规范化，不产生两个标识", () => {
		expect(delegationRequestId("Task-1", "Dev 1")).toBe(delegationRequestId("task-1", "dev-1"));
	});
});

describe("消息与回报标识", () => {
	test("消息标识随序号变化", () => {
		expect(messageRequestId("owner", 1, 1)).not.toBe(messageRequestId("owner", 1, 2));
	});

	test("回报标识由派活标识与员工推导，可稳定重现", () => {
		const delegation = delegationRequestId("task-9", "qa-1");
		expect(reportRequestId(delegation, "qa-1")).toBe(reportRequestId(delegation, "qa-1"));
	});
});

describe("升级与拍板标识", () => {
	test("升级标识可稳定重现", () => {
		expect(escalationId(3, 1)).toBe(escalationId(3, 1));
		expect(escalationId(3, 1)).not.toBe(escalationId(3, 2));
	});

	test("拍板标识由升级标识推导", () => {
		const escalation = escalationId(3, 1);
		expect(ownerDecisionRequestId(escalation)).toBe(ownerDecisionRequestId(escalation));
	});
});

describe("项目目录标识", () => {
	test("只含小写字母、数字与连字符", () => {
		expect(projectSlug("Tank Battle")).toBe("tank-battle");
		expect(projectSlug("坦克大战 Tank Battle!")).toBe("tank-battle");
		expect(projectSlug("  A  B  ")).toBe("a-b");
	});

	test("符合规格的字符集约束", () => {
		const slug = projectSlug("My Project (v2) — 测试");
		expect(slug).toMatch(/^[a-z0-9-]+$/);
	});

	test("无法生成时抛错而非静默返回空串", () => {
		expect(() => projectSlug("中文名")).toThrow();
		expect(() => projectSlug("!!!")).toThrow();
	});
});

describe("中文标识", () => {
	test("中文员工名可以生成标识", () => {
		expect(() => delegationRequestId("t1", "林越")).not.toThrow();
		expect(delegationRequestId("t1", "林越")).toBe(delegationRequestId("t1", "林越"));
		expect(delegationRequestId("t1", "林越")).not.toBe(delegationRequestId("t1", "周牧"));
	});

	test("纯中文项目名可用于派活标识（目录 slug 另有规则）", () => {
		expect(() => messageRequestId("坦克大战", 1, 1)).not.toThrow();
	});

	test("全符号输入兜底为稳定哈希，不抛错", () => {
		const first = delegationRequestId("t1", "!!!");
		const second = delegationRequestId("t1", "!!!");
		expect(first).toBe(second);
		expect(first).toContain("x");
	});
});
