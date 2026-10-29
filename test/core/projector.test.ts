/**
 * 过程投影落到哪个频道：老板的私聊只留 `say`（ADR-040）。
 *
 * 审计背景：一个人每次被 @ 一次，私聊里半小时平均多 76 条（最高 197 条），老板在私聊里的
 * 回复率掉到 1.06%（51/4804）—— think/tool/work 把真正要说的话淹掉了。这里只测那条判定，
 * 因为它决定「老板读到的私聊长什么样」，而投影整条链路要真模型才跑得到。
 */
import { describe, expect, test } from "vitest";
import { keptProjections, projectionsToPost } from "../../src/core/shell/projector.ts";
import type { Channel } from "../../src/core/channel/state.ts";
import type { Projection } from "../../src/core/channel/transcript.ts";

const NOW = 1_700_000_000_000;

function channel(id: string, members: readonly string[]): Channel {
	return { id, title: id, members, wakeOnAll: [], createdAt: NOW } as Channel;
}

const projections: readonly Projection[] = [
	{ kind: "think", text: "Let me check the logs first" },
	{ kind: "tool", text: "read src/core/shell/main.ts" },
	{ kind: "work", text: "跑测试" },
	{ kind: "say", text: "改好了，测试 232 例全绿。" },
] as readonly Projection[];

describe("投影落点：老板的私聊", () => {
	test("老板私聊只留 say —— 思考和工具卡片不落库", () => {
		const kept = keptProjections(channel("dm:owner-linyue", ["owner", "林越"]), projections);
		expect(kept.map((item) => item.kind)).toEqual(["say"]);
	});

	test("项目频道原样全留（过程对交接有用）", () => {
		const kept = keptProjections(channel("proj:ai-company", ["owner", "林越"]), projections);
		expect(kept.map((item) => item.kind)).toEqual(["think", "tool", "work", "say"]);
	});

	test("判定只看 dm: 前缀 + 成员里有老板，不看标题", () => {
		// 标题叫 dm 但成员里没有老板（比如 agent 之间的私聊）→ 不拦
		expect(keptProjections(channel("dm:a:b", ["林越", "沈舟"]), projections)).toHaveLength(4);
		// 名字不是 dm 但 id 是 → 拦
		const weird = { ...channel("dm:owner-x", ["owner", "林越"]), title: "随便什么标题" } as Channel;
		expect(keptProjections(weird, projections).map((item) => item.kind)).toEqual(["say"]);
	});
});

describe("正文投影的两道闸（一次说两句的根因）", () => {
	const dm = channel("dm:owner-shenan", ["owner", "沈岸"]);
	const nothing = () => false;
	const there = () => true;

	test("这一轮他已经用 say 说过 → 最终回答那段正文不再投影（实测：一次说两句）", () => {
		const posted = projectionsToPost(dm, projections, { spokeThisTurn: true, alreadySaid: nothing });
		expect(posted.map((item) => item.kind)).toEqual([]);
	});

	test("没说过的照常投影 —— 不说话的人还得靠这条把答案送出来", () => {
		const posted = projectionsToPost(dm, projections, { spokeThisTurn: false, alreadySaid: nothing });
		expect(posted.map((item) => item.kind)).toEqual(["say"]);
	});

	test("刚在同一个频道说过同样的话也不重复投影", () => {
		const posted = projectionsToPost(dm, projections, { spokeThisTurn: false, alreadySaid: there });
		expect(posted).toHaveLength(0);
	});

	test("只挡正文：思考和工具卡片该落还是落（表里没有它们，用项目频道看）", () => {
		const proj = channel("proj:solo", ["owner", "沈岸"]);
		const posted = projectionsToPost(proj, projections, { spokeThisTurn: true, alreadySaid: nothing });
		expect(posted.map((item) => item.kind)).toEqual(["think", "tool", "work"]);
	});
});
