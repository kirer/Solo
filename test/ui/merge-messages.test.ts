import { describe, expect, it } from "vitest";
import { mergeMessage, mergeMessages, previousOf } from "../../ui/web/js/messages.js";

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

describe("previousOf：替换已有行时，上一条不能是自己", () => {
	const messages = [
		{ seq: 1, fromSlug: "owner", kind: "say", at: 1_000 },
		{ seq: 2, fromSlug: "知言", kind: "say", at: 2_000, processing: true },
	];
	const replaced = { seq: 2, fromSlug: "知言", kind: "say", at: 9_000 };

	it("占位填充（原地替换）时取 index - 1，不是列表最后一条", () => {
		const index = messages.findIndex((message) => message.seq === replaced.seq);
		// 列表最后一条就是被替换的占位自己；拿它当上一条 → 同人连发合并 → 头像和名字被吃掉
		expect(messages[messages.length - 1]).toBe(messages[index]);
		expect(previousOf(messages, index, false)).toBe(messages[0]);
		expect(previousOf(messages, index, false)?.fromSlug).toBe("owner");
	});

	it("追加新消息时仍取列表最后一条", () => {
		expect(previousOf(messages, -1, true)).toBe(messages[messages.length - 1]);
	});

	it("替换第一行或空列表时没有上一条", () => {
		expect(previousOf(messages, 0, false)).toBeNull();
		expect(previousOf([], -1, true)).toBeNull();
		expect(previousOf(null, 3, false)).toBeNull();
	});
});

describe("mergeMessage：占位填充后不许残留 processing", () => {
	const placeholder = { seq: 7, fromSlug: "知言", kind: "say", text: "开始处理", processing: true, status: "pending", at: 1_000 };

	it("旧 processing:true + 新消息没有该键 → 结果里没有 processing（也不再是 pending）", () => {
		// 服务端填充时不带 processing（false 会被省略），spread 不会覆盖旧值 —— 必须显式删
		const merged = mergeMessage(placeholder, { seq: 7, kind: "say", text: "做完了。", at: 9_000 });
		expect("processing" in merged).toBe(false);
		expect("status" in merged).toBe(false);
		expect(merged.text).toBe("做完了。");
		expect(merged.at).toBe(9_000);
	});

	it("新消息明确带 processing:true 时保留；别的字段照旧被覆盖", () => {
		const merged = mergeMessage(placeholder, { seq: 7, processing: true, text: "还在跑", at: 2_000 });
		expect(merged.processing).toBe(true);
		expect(merged.text).toBe("还在跑");
	});
});
