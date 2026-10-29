/**
 * 卡顿记录要能自证「是不是节流伪长帧」（A5 那条 21.6 秒）。
 *
 * 21.6 秒的帧很可能不是主线程忙：页面被切到后台、系统睡眠时 rAF 会被节流/暂停，
 * 回到前台补一帧算出来的间隔就是几十秒。所以每条记录都带上 `vis` / `visForMs`
 * 和粗判 `state`：只有 `foreground` 才值得去查主线程。
 */
import { describe, expect, it } from "vitest";
import { classifyJank } from "../../ui/web/js/jank.js";

describe("classifyJank", () => {
	it("记录时页面不可见 → hidden（帧间隔没有意义）", () => {
		expect(classifyJank({ gapMs: 21_601, visibility: "hidden", sinceVisibility: 60_000 })).toBe("hidden");
	});

	it("帧间隔比「切回前台后经过的时间」长 → resumed（跨了隐藏/唤醒）", () => {
		// 切回前台才 50ms，却报了一个 21.6 秒的帧：这段时间页面根本不在前台
		expect(classifyJank({ gapMs: 21_601, visibility: "visible", sinceVisibility: 50 })).toBe("resumed");
		expect(classifyJank({ gapMs: 4_133, visibility: "visible", sinceVisibility: 1_000 })).toBe("resumed");
	});

	it("真正在前台连着跑 → foreground（这才值得查）", () => {
		// 前台已经连续 5 分钟，只报了一个 300ms 的长帧
		expect(classifyJank({ gapMs: 300, visibility: "visible", sinceVisibility: 5 * 60_000 })).toBe("foreground");
	});

	it("缺省参数不炸，按前台算", () => {
		expect(classifyJank()).toBe("foreground");
		expect(classifyJank({ gapMs: 500, visibility: "visible", sinceVisibility: 0 })).toBe("resumed");
	});
});
