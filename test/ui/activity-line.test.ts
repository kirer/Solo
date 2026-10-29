/**
 * 底部那条活动行（#act）：老板第 5 条验收就在这儿。
 *
 * 以前它拿「最后一条过程行的 at」当起点，每来一条过程就清零重算 —— 屏幕上是
 * 一个永远停在 5s 的表。现在和过程组头同一套：起点是这一段活的组起点
 * （`startedAt ?? 第一条过程行 at`），跑着「正在执行 · 67s」+ 三个动点，
 * 他说完话那一刻换成「已完成，用时 55 秒」，停 4 秒再收掉。
 *
 * 文案在 rows.js 的纯函数里，DOM 只负责画，所以这里断言文案与状态。
 */
import { describe, expect, it } from "vitest";
import { activityRun, groupStatus, shouldShowActivity } from "../../ui/web/js/rows.js";

const think = (at, slug = "知言") => ({ fromSlug: slug, kind: "think", text: "想一下。", at });
const say = (at, slug = "知言") => ({ fromSlug: slug, kind: "say", text: "做完了。", at });

describe("activityRun：底部活动行的起点与状态", () => {
	it("新来一条过程行不会把起点清零", () => {
		const first = [think(1_000), think(3_000), think(5_000)];
		const before = activityRun(first, 6_000);
		expect(before?.startAt).toBe(1_000);
		// 又来一条（at=7s）：起点还是 1s，不是 7s —— 否则秒数会从 2s 重新开始
		const after = activityRun([...first, think(7_000)], 8_000);
		expect(after?.startAt).toBe(1_000);
		expect(after?.endAt).toBe(7_000);
	});

	it("跑着的时候秒数随 now 递增（同一段活）", () => {
		const run = activityRun([think(1_000), think(3_000)], 10_000);
		expect(run?.running).toBe(true);
		expect(groupStatus({ ...run, now: 5_000 })).toBe("正在执行 · 4s");
		expect(groupStatus({ ...run, now: 10_000 })).toBe("正在执行 · 9s");
	});

	it("他一开口就收掉，不再停 4 秒显示「已完成」", () => {
		const messages = [think(1_000), think(3_000), say(9_000)];
		// 老板改口径：跑完直接收掉，活动行只服务「正在跑」
		expect(activityRun(messages, 9_001)).toBeNull();
		expect(activityRun(messages, 9_500)).toBeNull();
	});

	it("别人说话时，前一个人的活动行直接收掉（不显示错人）", () => {
		const messages = [think(1_000), think(3_000), say(9_000, "沈舟")];
		// 最后一条不是过程行 → 没有「正在跑」可显示；不会把沈舟的发言算成知言的结束
		expect(activityRun(messages, 3_500)).toBeNull();
		expect(activityRun(messages, 9_500)).toBeNull();
	});

	it("起点优先用消息自带的 startedAt", () => {
		const run = activityRun([{ ...think(9_000), startedAt: 3_000 }, think(20_000)], 21_000);
		expect(run?.startAt).toBe(3_000);
	});

	it("没有过程行、或老板自己在说话时，不显示活动行", () => {
		expect(activityRun([], 1_000)).toBeNull();
		expect(activityRun([say(1_000, "owner")], 2_000)).toBeNull();
	});

	it("很久没有新过程行就不再当它还在跑", () => {
		expect(activityRun([think(1_000)], 1_000 + 5 * 60 * 1000 + 1)).toBeNull();
	});
});

describe("活动行只在过程行没画出来时兜底", () => {
	const run = { slug: "知言", running: true, startAt: 1_000, endAt: 5_000 };

	it("页面上已经有 running 组头 → 不再显示活动行（同一件事不说两遍）", () => {
		expect(shouldShowActivity(run, { hasRunningGroup: true })).toBe(false);
	});

	it("没有 running 组头 → 兜底显示", () => {
		expect(shouldShowActivity(run, { hasRunningGroup: false })).toBe(true);
		expect(shouldShowActivity(run)).toBe(true);
	});

	it("根本没有在跑的东西 → 不显示", () => {
		expect(shouldShowActivity(null, { hasRunningGroup: false })).toBe(false);
	});
});
