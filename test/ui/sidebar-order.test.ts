/**
 * 会话列表的排序：助理的私聊恒在第一行。
 *
 * 我的验收口径是「重启后也要在顶部」。重启 = 重新 `/api/channels` 拉一份
 * 全新的列表（lastAt 全变了），所以这里断言的是 sortChannels 这个纯函数：
 * 不管输入顺序、不管时间戳怎么变，助理那一行都在第一位。
 *
 * 「谁是助理」只认目录事实（`assistant` 字段），不认名字 —— 换了名字照样钉。
 */
import { describe, expect, it } from "vitest";
import { assistantSlug, isPinnedChannel, sortChannels } from "../../ui/app/src/lib/format.ts";

const channel = (id, kind, lastAt, title = id) => ({ id, kind, title, lastAt });

describe("sortChannels", () => {
	it("助理私聊排第一，即使它是最久没说话的", () => {
		const channels = [
			channel("general", "group", 9_000),
			channel("team:solo", "group", 8_000),
			channel("dm:owner-知言", "dm", 1_000, "知言"),
		];
		expect(sortChannels(channels, "知言").map((item) => item.id)).toEqual([
			"dm:owner-知言",
			"general",
			"team:solo",
		]);
	});

	it("其余频道仍按最后说话时间倒序", () => {
		const out = sortChannels(
			[channel("a", "group", 100), channel("b", "group", 300), channel("c", "dm", 200)],
			"知言",
		);
		expect(out.map((item) => item.id)).toEqual(["b", "c", "a"]);
	});

	it("重启后重新拉取（时间戳全新）依然把助理钉在顶部", () => {
		// 模拟重启：频道顺序打乱、助理的 lastAt 变成最小（很久没说话）。
		const afterRestart = [
			channel("team:solo", "group", 99_000),
			channel("dm:owner-林骁", "dm", 98_000, "林骁"),
			channel("general", "group", 97_000),
			channel("dm:owner-知言", "dm", 500, "知言"),
		];
		const rendered = sortChannels(afterRestart, "知言");
		expect(rendered[0].id).toBe("dm:owner-知言");
		expect(rendered.slice(1).map((item) => item.id)).toEqual([
			"team:solo",
			"dm:owner-林骁",
			"general",
		]);
	});

	it("只钉助理一个人，别的成员私聊不钉", () => {
		expect(isPinnedChannel(channel("dm:owner-知言", "dm", 0), "知言")).toBe(true);
		expect(isPinnedChannel(channel("dm:owner-沈岸", "dm", 0), "知言")).toBe(false);
		expect(isPinnedChannel(channel("dm:owner-林骁", "dm", 0), "知言")).toBe(false);
		expect(isPinnedChannel(channel("general", "group", 0), "知言")).toBe(false);
		// 不是私聊的频道即便 id 带后缀也不钉
		expect(isPinnedChannel(channel("team:知言", "group", 0), "知言")).toBe(false);
		// 还没拿到名册（不知道谁是助理）时，一个都不钉
		expect(isPinnedChannel(channel("dm:owner-知言", "dm", 0), undefined)).toBe(false);
	});

	it("换名字也认：助理叫什么都钉住它的私聊", () => {
		const people = [{ slug: "林骁" }, { slug: "沈岸", assistant: true as const }];
		expect(assistantSlug(people)).toBe("沈岸");
		const out = sortChannels(
			[channel("general", "group", 9_000), channel("dm:owner-沈岸", "dm", 1)],
			assistantSlug(people),
		);
		expect(out[0].id).toBe("dm:owner-沈岸");
	});

	it("空列表和缺 lastAt 都不炸", () => {
		expect(sortChannels([], "知言")).toEqual([]);
		const out = sortChannels([{ id: "a", kind: "group" }, { id: "b", kind: "group" }], "知言");
		expect(out).toHaveLength(2);
	});
});
