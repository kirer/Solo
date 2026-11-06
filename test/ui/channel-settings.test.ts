/**
 * 列表项覆盖详情时，不能把只存在于详情里的频道设置冲掉。
 *
 * 真实事故：右栏设好共享指令与接话规则，下一次组织推送（列表里没有这两个字段）
 * 就把它们盖成「未写 / 默认」—— 接口里明明有值。
 */
import { describe, expect, test } from "vitest";
import { withSettings } from "../../ui/app/src/state/store.ts";
import type { ChannelDetail } from "../../ui/app/src/api/types.ts";

type DetailChannel = ChannelDetail["channel"];

const base: DetailChannel = {
	id: "team:weekly",
	kind: "group",
	title: "周报",
	team: "weekly",
	lastAt: 1,
	lastSeq: 10,
	memberCount: 3,
	members: ["Solo", "苏晓"],
};

describe("withSettings", () => {
	test("列表项没有的两样，从旧详情带回来", () => {
		const prev: DetailChannel = { ...base, bulletin: "只讨论周报", responder: { kind: "lead", slug: "苏晓" } };
		const next: DetailChannel = { ...base, title: "周报（改名）" };
		expect(withSettings(next, prev)).toEqual({
			...next,
			bulletin: "只讨论周报",
			responder: { kind: "lead", slug: "苏晓" },
		});
	});

	test("换了频道就不带：那是上一个房间的设置", () => {
		const prev: DetailChannel = { ...base, bulletin: "只讨论周报", responder: { kind: "mentions" } };
		const next: DetailChannel = { ...base, id: "team:dino", title: "小恐龙", team: "dino" };
		expect(withSettings(next, prev)).toEqual(next);
	});

	test("旧详情本来就没写，结果里也不出现这两个键", () => {
		const merged = withSettings({ ...base, title: "新标题" }, base);
		expect("bulletin" in merged).toBe(false);
		expect("responder" in merged).toBe(false);
	});
});
