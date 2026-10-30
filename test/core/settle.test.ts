import { describe, expect, it } from "vitest";
import { renderSettlePrompt, settleCandidates, type SettleCandidate } from "../../src/core/team/memory.ts";
import { SETTLE_TEMPLATE } from "./seed-prompt.ts";
import { settleTarget } from "../../src/core/team/settle.ts";
import type { Identity } from "../../src/core/agent/identity.ts";
import type { TeamDoc } from "../../src/core/team/doc.ts";

const identity = (slug: string, extra: Partial<Identity> = {}): Identity => ({
	slug,
	dir: `/tmp/${slug}`,
	name: slug,
	body: "",
	...extra,
});

const team = (lead?: string): TeamDoc => ({
	slug: "alpha",
	name: "alpha",
	status: "active",
	body: "",
	...(lead === undefined ? {} : { lead }),
});

describe("团队记忆自动沉淀：哪些消息算数", () => {
	it("普通 chat 也算：代码不按 kind 拦", () => {
		const picked = settleCandidates(
			[{ seq: 1, from: "lin", text: "就这么定了，用方案 B。", kind: "chat" }],
			0,
		);
		expect(picked.map((item) => item.seq)).toEqual([1]);
	});

	it("不按 kind 筛：所有新消息都是候选", () => {
		const picked = settleCandidates(
			[
				{ seq: 1, from: "lin", text: "开工", kind: "chat" },
				{ seq: 2, from: "lin", text: "定了：用连接池", kind: "decision" },
				{ seq: 3, from: "owner", text: "交付了 v1", kind: "report" },
			],
			0,
		);
		expect(picked).toEqual([
			{ seq: 1, from: "lin", text: "开工", kind: "chat" },
			{ seq: 2, from: "lin", text: "定了：用连接池", kind: "decision" },
			{ seq: 3, from: "owner", text: "交付了 v1", kind: "report" },
		]);
	});

	it("排除要整理的那个人自己说的话", () => {
		const picked = settleCandidates(
			[
				{ seq: 1, from: "lin", text: "我自己说的", kind: "chat" },
				{ seq: 2, from: "zhao", text: "别人说的", kind: "chat" },
			],
			0,
			"lin",
		);
		expect(picked.map((item) => item.from)).toEqual(["zhao"]);
	});

	it("游标之后才算：沉淀过的不会重复提", () => {
		const messages = [
			{ seq: 1, from: "lin", text: "a", kind: "decision" as const },
			{ seq: 2, from: "lin", text: "b", kind: "decision" as const },
		];
		expect(settleCandidates(messages, 1).map((item) => item.seq)).toEqual([2]);
		expect(settleCandidates(messages, 2)).toEqual([]);
	});

	it("我在团队频道拍的板也要沉淀", () => {
		const picked = settleCandidates([{ seq: 9, from: "owner", text: "停掉旧方案", kind: "decision" }], 0);
		expect(picked.map((item) => item.from)).toEqual(["owner"]);
	});

	it("沉淀提示词：列全每条候选，判据指向技能「记忆整理」（不在代码里）", () => {
		const candidates: SettleCandidate[] = [
			{ seq: 4, from: "lin", text: "连接池默认 5，要调到 20", kind: "decision" },
			{ seq: 5, from: "zhao", text: "v1 已上线", kind: "report" },
		];
		const prompt = renderSettlePrompt(SETTLE_TEMPLATE, "alpha", candidates);
		// 每条候选都要在：谁、第几条、什么标签、说了什么（多行压成单行）。
		expect(prompt).toContain("- #4 [decision] lin：连接池默认 5，要调到 20");
		expect(prompt).toContain("- #5 [report] zhao：v1 已上线");
		expect(prompt).toContain("2 条新消息");
		expect(prompt).toContain("`alpha`");
		// 判据只有一处家：技能「记忆整理」。模板只负责把这一轮的候选捧到它面前。
		expect(prompt).toContain("记忆整理");
		// 落点写清楚，别让模型猜写到哪。
		expect(prompt).toContain("teams/alpha/memory.md");
		// V2 的工具调用语法不许回来（工具改名它就撒谎）。
		expect(prompt).not.toContain("skills(action");
	});

	it("模板为空 = 空串：调用方据此跳过，不退回硬编码散文", () => {
		expect(renderSettlePrompt("", "alpha", [{ seq: 1, from: "lin", text: "x", kind: "chat" }])).toBe("");
	});
});

describe("谁去沉淀", () => {
	it("优先 README.md 里写的团队管理员", () => {
		const to = settleTarget(team("zhao"), ["owner", "lin", "zhao"], [identity("lin"), identity("zhao")]);
		expect(to).toBe("zhao");
	});

	it("团队管理员还没建文件夹时退到频道里第一个真人", () => {
		const to = settleTarget(team("ghost"), ["owner", "lin"], [identity("lin")]);
		expect(to).toBe("lin");
	});

	it("没有 README.md 也能定：取频道第一个非我成员", () => {
		expect(settleTarget(undefined, ["owner", "lin"], [identity("lin")])).toBe("lin");
	});

	it("全是我或全是没身份的人 → undefined（做不到就承认做不到）", () => {
		expect(settleTarget(undefined, ["owner"], [])).toBeUndefined();
		expect(settleTarget(team("ghost"), ["owner", "nobody"], [])).toBeUndefined();
	});
});
