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

	it("真机那条卡死：人不停往上撞，每撞一次都要能结算（2026-11-11）", () => {
		// 7791 真窗口：进 10000 条频道往上撞顶，补了**一次**页（24→33），之后再怎么撞都不动。
		// 原因：`settle()` 结尾无条件把 `lastSettleFilled` 置 true，而复位它的只有 `noteFilled()`
		// 和 `reset()` —— 「没人报补了」这一支没有任何复位路径，第一次结算之后保险丝永久带上记号。
		//
		// 真机上是**连着撞**：两次动作之间人没停够 400ms。这里照那个节奏来（间距 120ms），
		// 而且全程不调 `noteFilled()` —— 只要第二次结算被吞，就是卡死那个形状。
		const box = makeHost({ top: 4000, height: 9000, client: 900 });
		const arbiter = createArbiter(box.host);

		const settled: (number | null)[] = [];
		let top = 4000;
		for (let hit = 0; hit < 3; hit += 1) {
			top -= 200; // 每次往上撞一屏
			box.userScrollTo(top);
			box.advance(16);
			arbiter.sample();
			box.advance(GESTURE_IDLE_MS);
			const s1 = arbiter.settle();
			settled.push(s1 === null ? null : s1.upTo);
			box.advance(120); // 手没停够冷却期就接着撞下一次
		}
		expect(settled).toEqual([200, 200, 200]); // 卡死时是 [200, null, null]
	});

	it("保险丝只咬「真补过页」的那一次：没补页的结算不吃下一次", () => {
		const box = makeHost({ top: 4000, height: 9000, client: 900 });
		const arbiter = createArbiter(box.host);

		box.userScrollTo(3900);
		box.advance(16);
		arbiter.sample();
		box.advance(GESTURE_IDLE_MS);
		expect(arbiter.settle()).not.toBeNull(); // 这一次没补页（没调 noteFilled）

		// 紧接着（100ms 内）人又动了一下：上一次没补页，不该被咬。
		box.userScrollTo(3890);
		box.advance(16);
		arbiter.sample();
		box.advance(GESTURE_IDLE_MS);
		expect(arbiter.settle()).not.toBeNull();
	});

	it("贴顶还往上推：位置不动也必须算一次向上动作（7791 那个「停在顶部继续撞不补页」）", () => {
		// 真窗口的规律：离开顶部再滚回来，每轮都补一页（24→30→37→43→50）；
		// 可是人停在顶部继续往上撞时，`scrollTop` 恒 0 —— 没有 scroll 事件、`sample()` 看到的
		// 是「位置没动」，于是永远不结算，一个 ?before= 都不发。这条钉住出口。
		const box = makeHost({ top: 0, height: 9000, client: 900 });
		const arbiter = createArbiter(box.host);

		arbiter.push("up"); // 贴顶 + 往上推
		box.advance(GESTURE_IDLE_MS);
		const settled = arbiter.settle();
		expect(settled).not.toBeNull(); // 卡死时这里是 null
		expect(settled?.atTop).toBe(true);
		expect(settled!.upTo).toBeGreaterThan(0); // 语义是「往上」，结算出口才认
	});

	it("推的方向和边界不一致时不算动作（在顶部往下推、在中间往上推都不算）", () => {
		const box = makeHost({ top: 0, height: 9000, client: 900 });
		const arbiter = createArbiter(box.host);
		arbiter.push("down"); // 在顶部往下推：不是撞顶
		box.advance(GESTURE_IDLE_MS);
		expect(arbiter.settle()).toBeNull();

		const box2 = makeHost({ top: 4000, height: 9000, client: 900 });
		const arbiter2 = createArbiter(box2.host);
		arbiter2.push("up"); // 在中间往上推：位置本来就会动，走 sample() 那条路
		box2.advance(GESTURE_IDLE_MS);
		expect(arbiter2.settle()).toBeNull();
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
