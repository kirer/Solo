/**
 * SSE 事件按帧批量处理（运行时 21.6s 长帧那条）。
 *
 * 改前：每条事件单独走一遍「合判 + 追加 + scrollToBottom + renderActivity」，
 * scrollToBottom 读 scrollHeight 会强制布局 —— 服务端一次补几十条老消息时，
 * 几十次强制重排叠在一个任务里，主线程被啃掉；乱序消息还会每条触发一次整列重建
 * （60 条 = 60 次 buildStream，O(n²)）。
 *
 * 改后：事件先入队（同 seq 去重），下一帧统一落一批，滚动只做一次；
 * 一批超过阈值就整列重建**一次**。
 */
import { describe, expect, it } from "vitest";
import { enqueueMessage } from "../../ui/app/src/lib/messages.ts";

const msg = (seq, text = "x") => ({ seq, fromSlug: "知言", kind: "say", text, at: seq * 1000 });

describe("enqueueMessage：按帧批处理的前置去重", () => {
	it("同一个 seq 在一批里只留最后一条（服务端重推很常见）", () => {
		let queue = [];
		queue = enqueueMessage(queue, msg(3, "第一版"));
		queue = enqueueMessage(queue, msg(4, "另一条"));
		queue = enqueueMessage(queue, msg(3, "填充后"));
		expect(queue).toHaveLength(2);
		expect(queue.find((item) => item.seq === 3)?.text).toBe("填充后");
	});

	it("保序：新 seq 追加在末尾，和到达顺序一致", () => {
		let queue = [];
		for (const seq of [5, 6, 7]) queue = enqueueMessage(queue, msg(seq));
		expect(queue.map((item) => item.seq)).toEqual([5, 6, 7]);
	});

	it("脏值不入队（没有 seq 的事件直接丢）", () => {
		const queue = enqueueMessage([], { kind: "say" });
		expect(queue).toEqual([]);
		expect(enqueueMessage(undefined, msg(1))).toHaveLength(1);
	});
});
