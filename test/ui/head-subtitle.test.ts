/**
 * 频道顶栏副标题：项目频道的第一段是「这个项目现在在干什么」（后端 doing）。
 *
 * 老板的验收口径是「项目频道顶部显示 doing，没有 doing 的项目不显示」。
 * renderHead 要吃 DOM，node 环境跑不了，所以把「哪些段落、什么顺序」抽成
 * format.headParts 这个纯函数，这里钉住两件事：doing 在最前；没有就不占位。
 */
import { describe, expect, it } from "vitest";
import { headParts } from "../../ui/app/src/lib/format.ts";

const project = (extra) => ({
	id: "proj:solo",
	kind: "project",
	title: "Solo",
	project: "solo",
	ownerLabel: "知言",
	memberCount: 2,
	...extra,
});

describe("headParts", () => {
	it("项目频道：doing 排在项目名 / 负责人 / 人数之前", () => {
		const parts = headParts(project({ doing: "沈舟做服务端、林越做前端" }));
		expect(parts[0]).toBe("沈舟做服务端、林越做前端");
		expect(parts).toEqual(["沈舟做服务端、林越做前端", "solo", "负责人 知言", "2 人"]);
	});

	it("没有 doing（或空串）时和以前一模一样，不多出分隔点", () => {
		expect(headParts(project({}))).toEqual(["solo", "负责人 知言", "2 人"]);
		expect(headParts(project({ doing: "" }))).toEqual(["solo", "负责人 知言", "2 人"]);
		expect(headParts({ id: "general", kind: "company", title: "全员" })).toEqual([]);
	});
});
