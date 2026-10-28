import { describe, expect, it } from "vitest";
import { mergeMessages } from "../../ui/web/js/messages.js";

/**
 * 补历史时把一个频道的两页消息拼起来。
 *
 * 这个函数存在的理由是一次真实故障：补两轮历史后 DOM 里出现 20 个重复的
 * `data-seq`，于是「按 seq 定位一条消息」整套失效 —— 高亮亮错行、动作条挂到
 * 另一条消息上。所以这里要钉死的不是「能拼」，而是「拼完 seq 唯一且升序」。
 */
const msg = (seq: number, text = "") => ({ seq, text });

describe("mergeMessages", () => {
	it("把两批按 seq 升序合并", () => {
		expect(mergeMessages([msg(3), msg(4)], [msg(5), msg(6)]).map((m) => m.seq)).toEqual([3, 4, 5, 6]);
	});

	it("补历史时更早的一批排在前面", () => {
		expect(mergeMessages([msg(1), msg(2)], [msg(9)]).map((m) => m.seq)).toEqual([1, 2, 9]);
	});

	it("重叠的 seq 只留一条", () => {
		const merged = mergeMessages([msg(1), msg(2), msg(3)], [msg(2), msg(3), msg(4)]);
		expect(merged.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
	});

	it("重叠时后一批赢（它带着更新的字段）", () => {
		const merged = mergeMessages([{ seq: 2, text: "旧" }], [{ seq: 2, text: "新" }]);
		expect(merged).toHaveLength(1);
		expect(merged[0].text).toBe("新");
	});

	it("输入乱序也能排出升序", () => {
		expect(mergeMessages([msg(7)], [msg(2), msg(5)]).map((m) => m.seq)).toEqual([2, 5, 7]);
	});

	it("空输入不炸", () => {
		expect(mergeMessages(undefined, undefined)).toEqual([]);
		expect(mergeMessages([], [msg(1)]).map((m) => m.seq)).toEqual([1]);
	});

	it("没有 seq 的东西丢掉（半条 JSON、占位项）", () => {
		const merged = mergeMessages([msg(1), null as never, { text: "没有 seq" } as never], [msg(2)]);
		expect(merged.map((m) => m.seq)).toEqual([1, 2]);
	});

	it("不改动传进来的数组", () => {
		const older = [msg(1)];
		const newer = [msg(2)];
		mergeMessages(older, newer);
		expect(older).toEqual([msg(1)]);
		expect(newer).toEqual([msg(2)]);
	});
});
