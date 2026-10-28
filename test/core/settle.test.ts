import { describe, expect, it } from "vitest";
import {
	renderSettlePrompt,
	settleCandidates,
	settleKey,
	type SettleCandidate,
} from "../../src/core/project/memory.ts";
import { settleTarget } from "../../src/core/project/settle.ts";
import type { Identity } from "../../src/core/agent/identity.ts";
import type { ProjectDoc } from "../../src/core/project/doc.ts";

const identity = (slug: string, extra: Partial<Identity> = {}): Identity => ({
	slug,
	dir: `/tmp/${slug}`,
	name: slug,
	body: "",
	...extra,
});

const project = (owner?: string): ProjectDoc => ({
	slug: "alpha",
	name: "alpha",
	status: "active",
	body: "",
	dir: "/tmp/alpha",
	...(owner === undefined ? {} : { owner }),
});

describe("项目记忆自动沉淀：哪些消息算数", () => {
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

	it("老板在项目频道拍的板也要沉淀", () => {
		const picked = settleCandidates([{ seq: 9, from: "owner", text: "停掉旧方案", kind: "decision" }], 0);
		expect(picked.map((item) => item.from)).toEqual(["owner"]);
	});

	it("沉淀提示词列全每条，并把判断规则指向技能「记忆整理」", () => {
		const candidates: SettleCandidate[] = [
			{ seq: 4, from: "lin", text: "连接池默认 5，要调到 20", kind: "decision" },
			{ seq: 5, from: "zhao", text: "v1 已上线", kind: "report" },
		];
		const prompt = renderSettlePrompt("alpha", candidates);
		expect(prompt).toContain("#4 [decision] lin：");
		expect(prompt).toContain("#5 [report] zhao：");
		// 判断规则不在代码里：提示词只说「去看技能」，不复述清单。
		expect(prompt).toContain("记忆整理");
		expect(prompt).toContain("projects/alpha/memory.md");
		expect(prompt).not.toContain("不写过程");
	});

	it("游标键按项目分", () => {
		expect(settleKey("alpha")).toBe("settle:alpha");
		expect(settleKey("beta")).not.toBe(settleKey("alpha"));
	});
});

describe("谁去沉淀", () => {
	it("优先 README.md 里写的负责人", () => {
		const to = settleTarget(project("zhao"), ["owner", "lin", "zhao"], [identity("lin"), identity("zhao")]);
		expect(to).toBe("zhao");
	});

	it("负责人还没建文件夹时退到频道里第一个真人", () => {
		const to = settleTarget(project("ghost"), ["owner", "lin"], [identity("lin")]);
		expect(to).toBe("lin");
	});

	it("没有 README.md 也能定：取频道第一个非老板成员", () => {
		expect(settleTarget(undefined, ["owner", "lin"], [identity("lin")])).toBe("lin");
	});

	it("全是老板或全是没身份的人 → undefined（做不到就承认做不到）", () => {
		expect(settleTarget(undefined, ["owner"], [])).toBeUndefined();
		expect(settleTarget(project("ghost"), ["owner", "nobody"], [])).toBeUndefined();
	});
});
