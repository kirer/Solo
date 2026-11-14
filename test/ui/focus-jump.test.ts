/**
 * 「跳回起源」：任务看板上点一行 → 中间那一列滚到派活那条消息（Solo 2026-11-15）。
 *
 * 这个文件盯三件真会出错的事：
 *   ① 落在哪儿（35% 视口高，上下夹住）——差一截用户就以为没跳；
 *   ② **跳过去之后不飘走**：布局一变锚点必须还是焦点行，不能退回「视口首行」
 *      （Solo 点名要求这条有落成用例）；
 *   ③ 补不到就说一句话，别让「点了没反应」发生。
 *
 * 环境是 node，没有 React 渲染：纯算法直接跑，组件层读源码断言结构（和
 * `stream-source-contract.test.ts` 同一个路子）。
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { clearFocus, focusSeq, getState, markFocusMiss, patch, subscribe } from "../../ui/app/src/state/store.ts";
import { focusScrollTop, keepAnchor } from "../../ui/app/src/stream/scroll.ts";

const streamSource = readFileSync(new URL("../../ui/app/src/stream/Stream.tsx", import.meta.url), "utf8");
const boardSource = readFileSync(new URL("../../ui/app/src/panels/TaskBoard.tsx", import.meta.url), "utf8");

beforeEach(() => {
	patch({ focus: null, focusMiss: null });
});

afterEach(() => {
	vi.useRealTimers();
	patch({ focus: null, focusMiss: null });
});

describe("落在哪儿：行顶落在 35% 视口高", () => {
	test("中间的消息：上面留出三成半的上下文", () => {
		// 现在 scrollTop=1000，这一行在视口里 200px 处，视口 800 → 想让它到 280px：
		// 1000 + 200 - 280 = 920
		expect(focusScrollTop(1000, 200, 800, 4000)).toBe(920);
	});

	test("最上面那几条：夹到 0，不出现负的 scrollTop", () => {
		expect(focusScrollTop(0, 100, 800, 4000)).toBe(0);
	});

	test("最下面那几条：夹到底，别滚不到位", () => {
		// 4000 - 800 = 3200 是底；算出来 3620，夹回 3200
		expect(focusScrollTop(3000, 500, 800, 4000)).toBe(3200);
	});

	test("内容还没填满一屏：任何行都在 0，别硬往下滚", () => {
		expect(focusScrollTop(0, 50, 800, 300)).toBe(0);
	});
});

describe("跳过去之后不飘走（Solo 2026-11-15 点名的那条）", () => {
	test("跳转途中：锚点必须是焦点行，不能是视口首行", () => {
		const focus = { key: "s-247", top: 280 };
		const firstVisible = { key: "s-244", top: 0 };
		expect(keepAnchor(focus, firstVisible)).toEqual({ key: "s-247", top: 280 });
	});

	test("没在跳转：照旧钉视口首行", () => {
		expect(keepAnchor(null, { key: "s-244", top: 12 })).toEqual({ key: "s-244", top: 12 });
	});

	test("两头都没有（空频道 / 还没上屏）：给 null，别编一个锚点", () => {
		expect(keepAnchor(null, null)).toBe(null);
	});
});

describe("请求本身", () => {
	test("点一行：请求带上 seq、频道、时间戳", () => {
		const before = Date.now();
		focusSeq(247, "ch-1");
		const { focus } = getState();
		expect(focus?.seq).toBe(247);
		expect(focus?.channelId).toBe("ch-1");
		expect(focus?.at).toBeGreaterThanOrEqual(before);
	});

	test("同一条再点一次也算新请求（只认 at，界面才会重跳）", () => {
		focusSeq(247, "ch-1");
		const first = getState().focus?.at;
		vi.useFakeTimers();
		vi.setSystemTime(new Date(Date.now() + 1000));
		focusSeq(247, "ch-1");
		expect(getState().focus?.at).toBe((first ?? 0) + 1000);
	});

	test("认领完清掉，下次进这个频道不会再跳一次", () => {
		focusSeq(247, "ch-1");
		clearFocus();
		expect(getState().focus).toBe(null);
	});

	test("没有请求时 clearFocus 一次通知都不发（它会被每帧调用）", () => {
		let notices = 0;
		const off = subscribe(() => {
			notices += 1;
		});
		clearFocus();
		off();
		expect(notices).toBe(0);
	});
});

describe("补不到起源：说一句话，不装死", () => {
	test("说一句，两秒多之后自己撤", () => {
		vi.useFakeTimers();
		markFocusMiss(1200);
		expect(getState().focusMiss?.seq).toBe(1200);
		vi.advanceTimersByTime(2400);
		expect(getState().focusMiss).toBe(null);
	});

	test("连着点两条：前一次的定时器不许把后一次的提示抹掉", () => {
		vi.useFakeTimers();
		markFocusMiss(1200);
		vi.advanceTimersByTime(1000);
		markFocusMiss(1300);
		vi.advanceTimersByTime(1500); // 第一条的定时器到点
		expect(getState().focusMiss?.seq).toBe(1300);
		vi.advanceTimersByTime(1000);
		expect(getState().focusMiss).toBe(null);
	});
});

describe("Stream 里的结构（读源码，node 环境渲染不了）", () => {
	test("只有一条跳转路：引用和看板都走 goToSeq", () => {
		expect(streamSource).toContain("const goToSeq = useCallback(");
		// 补不到历史这两条都得先补再跳，不是「找不到就算了」。
		expect(streamSource).toContain("const reachSeq = useCallback(");
		expect(streamSource).toContain("void reachSeq(seq).then(");
		expect(streamSource).toContain("if (!hit) markFocusMiss(seq);");
		// 老的 `scrollIntoView({block:"center"})` 不许回来：它绕开了 `setScrollTop` 的记账。
		expect(streamSource).not.toContain('scrollIntoView({ block: "center"');
	});

	test("落点算式只写在 scroll.ts 一处", () => {
		expect(streamSource).toContain("focusScrollTop(flow.scrollTop, inViewport, flow.clientHeight, flow.scrollHeight)");
		expect(streamSource).not.toContain("clientHeight * 0.35");
	});

	test("落点认 DOM 真实位置，不认模型的估算偏移（真机第一次跑偏了 135px）", () => {
		expect(streamSource).toContain("const inViewport = rowTop(row.key);");
		expect(streamSource).not.toContain("offsetOf(layout.current, row.key)");
	});

	test("锚点两处更新都走 pinAnchor（不许再各写一遍「视口首行」）", () => {
		expect(streamSource.match(/pinAnchor\(\);/g)?.length).toBe(2);
		expect(streamSource).toContain("anchor.current = keepAnchor(focusPoint, firstVisible);");
	});

	test("进频道落底让路：有跳转请求时不把人拽到最后一条", () => {
		expect(streamSource).toContain("if (getState().focus !== null) return;");
	});

	test("补历史最多 3 页，补不到才报没存到", () => {
		expect(streamSource).toContain("for (let page = 0; page < 3; page += 1)");
		expect(streamSource).toContain("markFocusMiss(focus.seq);");
	});

	test("只认当前频道的请求：seq 是全局的，别的频道硬跳会误报", () => {
		expect(streamSource).toContain("detail.channel.id !== focus.channelId");
	});

	test("人一滚就硬取消（补页可能要好几趟网络往返）", () => {
		expect(streamSource).toContain("if (moved && focusRow.current !== null) cancelFocusRef.current();");
	});
});

describe("看板那一行的话（读源码）", () => {
	test("没存到时把「点开回到原话」换成那句灰字", () => {
		expect(boardSource).toContain("这条在更早的记录里，本机没存到");
		expect(boardSource).toContain("missSeq");
	});
});
