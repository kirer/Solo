/**
 * 过程投影落到哪个频道、哪些 kind 会被挡住。
 *
 * 2026-10-30 老板要求「私聊里也要看得见思考和工具过程」，所以 ADR-071 那条
 * 「老板私聊只留 say」的闸被撤掉了：think / tool / work 现在在任何频道都落库，
 * 只保留正文（`say`）的两道去重闸 —— 否则一次回答会在私聊里出现两遍。
 */
import { describe, expect, test } from "vitest";
import { projectionsToPost } from "../../src/core/shell/projector.ts";
import type { Projection } from "../../src/core/channel/transcript.ts";

const projections: readonly Projection[] = [
	{ kind: "think", text: "Let me check the logs first" },
	{ kind: "tool", text: "read src/core/shell/main.ts" },
	{ kind: "work", text: "跑测试" },
	{ kind: "say", text: "改好了，测试 232 例全绿。" },
] as readonly Projection[];

const nothing = () => false;
const there = () => true;

describe("过程投影：老板私聊里 think/tool 也会落", () => {
	test("私聊里思考和工具卡片照常落库（不再只留 say）", () => {
		const posted = projectionsToPost(projections, { spokeThisTurn: false, alreadySaid: nothing });
		expect(posted.map((item) => item.kind)).toEqual(["think", "tool", "work", "say"]);
	});

	test("这一轮他已经说过话：只挡正文，思考和工具照落", () => {
		const posted = projectionsToPost(projections, { spokeThisTurn: true, alreadySaid: nothing });
		expect(posted.map((item) => item.kind)).toEqual(["think", "tool", "work"]);
	});

	test("刚在同一个频道说过同样的话：正文不重复落，过程照落", () => {
		const posted = projectionsToPost(projections, { spokeThisTurn: false, alreadySaid: there });
		expect(posted.map((item) => item.kind)).toEqual(["think", "tool", "work"]);
	});
});

describe("正文去重（一次说两句的根因）", () => {
	const onlySay: readonly Projection[] = [{ kind: "say", text: "在，随时待命。" }];

	test("这一轮已经用 say 说过 → 最终回答那段正文不再投影", () => {
		expect(projectionsToPost(onlySay, { spokeThisTurn: true, alreadySaid: nothing })).toEqual([]);
	});

	test("没说过的照常投影 —— 不说话的人还得靠这条把答案送出来", () => {
		expect(projectionsToPost(onlySay, { spokeThisTurn: false, alreadySaid: nothing })).toHaveLength(1);
	});

	test("同一句刚说过也不重复投影", () => {
		expect(projectionsToPost(onlySay, { spokeThisTurn: false, alreadySaid: there })).toEqual([]);
	});
});
