/**
 * 「谁在动」的判法 —— `ui/app/src/stream/scroll.ts`（设计 §1，季衡方案第一节）。
 *
 * 这里不模拟浏览器，只喂一个 `Host`：三个数和一次写。**每条断言都是一个曾经坏过的形状**：
 * 拖滚动条（不靠 `pointerdown` 也得认）、程序补偿被当成人在滚（前几轮死因）、
 * 夹紧被当成人在滚（狂补的入口）、一次甩动只补一页（第一轮补到 5031 条）。
 */
import { describe, expect, it } from "vitest";
import { createArbiter, GESTURE_IDLE_MS, SETTLE_COOLDOWN_MS } from "../../ui/app/src/stream/scroll.ts";

/** 造一个可控的滚动容器：`top` 是 `scrollTop`，`height` 是 `scrollHeight`，`client` 是可见高。 */
function makeHost(init: { top: number; height: number; client: number }) {
	let clock = 0;
	const state = { ...init };
	let writes = 0;
	const host = {
		read: () => ({ top: state.top, height: state.height, client: state.client }),
		write: (top: number) => {
			writes += 1;
			state.top = top;
		},
		now: () => clock,
	};
	return {
		host,
		state,
		/** 时间往前走（毫秒）。 */
		advance: (ms: number) => {
			clock += ms;
		},
		/** 人滚了一下：只有 `top` 变（浏览器行为，`height` / `client` 不动）。 */
		userScrollTo: (top: number) => {
			state.top = top;
		},
		/** 内容长高/变短（补页、图片撑高、夹紧）。 */
		grow: (height: number) => {
			state.height = height;
		},
		writes: () => writes,
	};
}

describe("谁是「人在动」（设计 §1.1）", () => {
	it("只有 scrollTop 变、我们没写过、高度没变 → 是人（拖滚动条也算）", () => {
		const box = makeHost({ top: 1000, height: 5000, client: 900 });
		const arbiter = createArbiter(box.host);
		// 原生滚动条不在 DOM 里，`pointerdown` 拿不到 —— 这里就是「只有位置变了」。
		box.userScrollTo(700);
		box.advance(16);
		expect(arbiter.sample()).toBe(true);
	});

	it("程序写的 scrollTop 被认领并丢弃，不算人", () => {
		const box = makeHost({ top: 1000, height: 5000, client: 900 });
		const arbiter = createArbiter(box.host);
		arbiter.setScrollTop(1100, "anchor");
		box.advance(16);
		expect(arbiter.sample()).toBe(false);
		expect(arbiter.claimed()).toBe(1);
		expect(arbiter.writes()).toBe(1);
	});

	it("补偿之后人接着滚的那一下不算「我们写的」（一次写只认一次）", () => {
		const box = makeHost({ top: 1000, height: 5000, client: 900 });
		const arbiter = createArbiter(box.host);
		arbiter.setScrollTop(1100, "anchor");
		box.advance(16);
		expect(arbiter.sample()).toBe(false); // 补偿被认领
		box.userScrollTo(900);
		box.advance(16);
		expect(arbiter.sample()).toBe(true); // 人立刻往回滚，不能被上一笔账吞掉
	});

	it("内容高度变了导致的位置变化不算人（夹紧 / 图片撑高 / 页回来）", () => {
		const box = makeHost({ top: 1000, height: 5000, client: 900 });
		const arbiter = createArbiter(box.host);
		box.grow(4700); // 内容变短，浏览器把 top 夹下来
		box.userScrollTo(880);
		box.advance(16);
		expect(arbiter.sample()).toBe(false);
	});

	it("同一帧里「我们先写、紧接着高度也变」时，先按「我们写的」认领（顺序写死）", () => {
		const box = makeHost({ top: 1000, height: 5000, client: 900 });
		const arbiter = createArbiter(box.host);
		arbiter.setScrollTop(1120, "anchor");
		box.grow(5120);
		box.advance(16);
		expect(arbiter.sample()).toBe(false);
		expect(arbiter.claimed()).toBe(1);
	});

	it("没动的时候什么都不判（也不会误报成人）", () => {
		const box = makeHost({ top: 1000, height: 5000, client: 900 });
		const arbiter = createArbiter(box.host);
		box.advance(16);
		expect(arbiter.sample()).toBe(false);
		expect(arbiter.moving()).toBe(false);
	});
});

describe("一次动作的边界（设计 §1.3）", () => {
	it("甩动一下（几十帧都在变）只算一次动作，结算只发生一次", () => {
		const box = makeHost({ top: 4000, height: 9000, client: 900 });
		const arbiter = createArbiter(box.host);
		// 触控板惯性：50 帧，每帧往上 12px
		for (let frame = 0; frame < 50; frame += 1) {
			box.userScrollTo(4000 - (frame + 1) * 12);
			box.advance(16);
			expect(arbiter.sample()).toBe(true);
			expect(arbiter.settle()).toBeNull(); // 还在动，不许结算
		}
		box.advance(GESTURE_IDLE_MS);
		const settled = arbiter.settle();
		expect(settled).not.toBeNull();
		expect(settled?.moved).toBe(-600); // 一共往上走了 600px
		expect(arbiter.settle()).toBeNull(); // 已经结算过，不会有第二次
	});

	it("结算后 400ms 内再来一次结算 → 保险丝咬住（上一次补过页）", () => {
		const box = makeHost({ top: 4000, height: 9000, client: 900 });
		const arbiter = createArbiter(box.host);
		box.userScrollTo(3900);
		box.advance(16);
		arbiter.sample();
		box.advance(GESTURE_IDLE_MS);
		expect(arbiter.settle()).not.toBeNull();
		arbiter.noteFilled();

		// 停手后 100ms 内又动了一下（手没走，指尖抖动）
		box.userScrollTo(3890);
		box.advance(16);
		arbiter.sample();
		box.advance(GESTURE_IDLE_MS);
		expect(arbiter.settle()).toBeNull();
	});

	it("过了冷却期就能再结算（不会一次动作之后永久卡死）", () => {
		const box = makeHost({ top: 4000, height: 9000, client: 900 });
		const arbiter = createArbiter(box.host);
		box.userScrollTo(3900);
		box.advance(16);
		arbiter.sample();
		box.advance(GESTURE_IDLE_MS);
		expect(arbiter.settle()).not.toBeNull();
		arbiter.noteFilled();

		box.advance(SETTLE_COOLDOWN_MS);
		box.userScrollTo(3700);
		box.advance(16);
		arbiter.sample();
		box.advance(GESTURE_IDLE_MS);
		expect(arbiter.settle()).not.toBeNull();
	});

	it("只往上滚的动作报出 upTo；往下滚不报", () => {
		const box = makeHost({ top: 2000, height: 9000, client: 900 });
		const arbiter = createArbiter(box.host);
		box.userScrollTo(1900);
		box.advance(16);
		arbiter.sample();
		box.advance(GESTURE_IDLE_MS);
		expect(arbiter.settle()?.upTo).toBe(100);

		box.advance(SETTLE_COOLDOWN_MS);
		box.userScrollTo(2200);
		box.advance(16);
		arbiter.sample();
		box.advance(GESTURE_IDLE_MS);
		expect(arbiter.settle()?.upTo).toBe(0);
	});
});

describe("记账的时限（设计 §1.2）", () => {
	it("写的位置本来就等于当前位置时不记账（否则会吞掉下一次人的滚动）", () => {
		const box = makeHost({ top: 1000, height: 5000, client: 900 });
		const arbiter = createArbiter(box.host);
		arbiter.setScrollTop(1000, "anchor");
		expect(arbiter.writes()).toBe(0);
		expect(box.writes()).toBe(0);
	});

	it("记账过了 300ms 没人认领就作废（浏览器判「位置没变」不发 scroll 的那种）", () => {
		const box = makeHost({ top: 1000, height: 5000, client: 900 });
		const arbiter = createArbiter(box.host);
		arbiter.setScrollTop(1100, "anchor");
		box.advance(400);
		expect(arbiter.sample()).toBe(false); // 这一帧按「我们写的」认领掉
		box.advance(16);
		// 人接着滚到别处：不能被那笔已经用掉的账吞掉
		box.userScrollTo(900);
		box.advance(16);
		expect(arbiter.sample()).toBe(true);
		// 认领只发生一次，不会把这笔账算成两次
		expect(arbiter.claimed()).toBe(1);
	});
});
