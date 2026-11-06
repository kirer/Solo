/**
 * 资料页那行「后台任务 N 轮」与后台任务屏的行数必须是同一个数。
 *
 * 真实事故：资料页数了全部轮次（9 轮），点进去只列动过手的（4 轮），
 * 看起来像丢了五轮。
 */
import { describe, expect, test } from "vitest";
import { workTurns } from "../../ui/app/src/panels/TasksPanel.tsx";
import type { Turn } from "../../ui/app/src/api/types.ts";

const turn = (over: Partial<Turn>): Turn => ({
	channelId: "team:weekly",
	seq: 1,
	slug: "苏晓",
	label: "苏晓",
	status: "done",
	startedAt: 1,
	stepCount: 0,
	summary: "想了 1s",
	...over,
});

describe("workTurns", () => {
	test("0 步的一轮不算任务：只说了句话，那是聊天", () => {
		expect(workTurns([turn({}), turn({ stepCount: 3 })])).toHaveLength(1);
	});

	test("还在跑的先留着：步数随后才到", () => {
		expect(workTurns([turn({ status: "running" })])).toHaveLength(1);
	});

	test("失败的那一轮只要动过手就留着", () => {
		expect(workTurns([turn({ status: "failed", stepCount: 2 })])).toHaveLength(1);
	});
});
