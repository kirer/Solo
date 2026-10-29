/**
 * 会话列表的排序：知言的私聊恒在第一行。
 *
 * 老板的验收口径是「重启后也要在顶部」。重启 = 重新 `/api/channels` 拉一份
 * 全新的列表（lastAt 全变了），所以这里断言的是 sortChannels 这个纯函数：
 * 不管输入顺序、不管时间戳怎么变，知言那一行都在第一位。
 */
import { describe, expect, it } from "vitest";
import { isPinnedChannel, sortChannels } from "../../ui/web/js/format.js";

const channel = (id, kind, lastAt, title = id) => ({ id, kind, title, lastAt });

describe("sortChannels", () => {
	it("知言私聊排第一，即使它是最久没说话的", () => {
		const channels = [
			channel("general", "company", 9_000),
			channel("proj:solo", "project", 8_000),
			channel("dm:owner-知言", "dm", 1_000, "知言"),
		];
		expect(sortChannels(channels).map((item) => item.id)).toEqual([
			"dm:owner-知言",
			"general",
			"proj:solo",
		]);
	});

	it("其余频道仍按最后说话时间倒序", () => {
		const out = sortChannels([
			channel("a", "company", 100),
			channel("b", "project", 300),
			channel("c", "dm", 200),
		]);
		expect(out.map((item) => item.id)).toEqual(["b", "c", "a"]);
	});

	it("重启后重新拉取（时间戳全新）依然把知言钉在顶部", () => {
		// 模拟重启：频道顺序打乱、知言的 lastAt 变成最小（很久没说话）。
		const afterRestart = [
			channel("proj:solo", "project", 99_000),
			channel("dm:owner-林骁", "dm", 98_000, "林骁"),
			channel("general", "company", 97_000),
			channel("dm:owner-知言", "dm", 500, "知言"),
		];
		const rendered = sortChannels(afterRestart);
		expect(rendered[0].id).toBe("dm:owner-知言");
		expect(rendered.slice(1).map((item) => item.id)).toEqual([
			"proj:solo",
			"dm:owner-林骁",
			"general",
		]);
	});

	it("只钉知言一个人，别的同事私聊不钉", () => {
		expect(isPinnedChannel(channel("dm:owner-知言", "dm", 0))).toBe(true);
		expect(isPinnedChannel(channel("dm:owner-沈岸", "dm", 0))).toBe(false);
		expect(isPinnedChannel(channel("dm:owner-林骁", "dm", 0))).toBe(false);
		expect(isPinnedChannel(channel("general", "company", 0))).toBe(false);
		// 不是私聊的频道即便 id 带后缀也不钉
		expect(isPinnedChannel(channel("proj:知言", "project", 0))).toBe(false);
	});

	it("空列表和缺 lastAt 都不炸", () => {
		expect(sortChannels([])).toEqual([]);
		const out = sortChannels([{ id: "a", kind: "company" }, { id: "b", kind: "company" }]);
		expect(out).toHaveLength(2);
	});
});
