/**
 * 频道顶栏副标题：团队频道的第一段是「这个团队现在在干什么」（后端 doing）。
 *
 * 我的验收口径是「团队频道顶部显示 doing，没有 doing 的团队不显示」。
 * renderHead 要吃 DOM，node 环境跑不了，所以把「哪些段落、什么顺序」抽成
 * format.headParts 这个纯函数，这里钉住两件事：doing 在最前；没有就不占位。
 */
import { describe, expect, it } from "vitest";
import { headParts } from "../../ui/app/src/lib/format.ts";

const team = (extra) => ({
	id: "team:solo",
	kind: "group",
	title: "Solo",
	team: "solo",
	leadLabel: "知言",
	memberCount: 2,
	...extra,
});

describe("headParts", () => {
	it("团队频道：doing 排在团队名 / 团队管理员 / 人数之前", () => {
		const parts = headParts(team({ doing: "沈舟做服务端、林越做前端" }));
		expect(parts[0]).toBe("沈舟做服务端、林越做前端");
		expect(parts).toEqual(["沈舟做服务端、林越做前端", "solo", "团队管理员 知言", "2 人"]);
	});

	it("没有 doing（或空串）时和以前一模一样，不多出分隔点", () => {
		expect(headParts(team({}))).toEqual(["solo", "团队管理员 知言", "2 人"]);
		expect(headParts(team({ doing: "" }))).toEqual(["solo", "团队管理员 知言", "2 人"]);
		expect(headParts({ id: "general", kind: "group", title: "全员" })).toEqual([]);
	});
});
