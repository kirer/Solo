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
import { ACTIVITY_DONE_MS, activityRun, groupStatus } from "../../ui/web/js/rows.js";

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

	it("他说完话那一刻定格成「已完成，用时 X 秒」，4 秒后收掉", () => {
		const messages = [think(1_000), think(3_000), say(9_000)];
		const justDone = activityRun(messages, 9_500);
		expect(justDone?.running).toBe(false);
		const frozen = groupStatus({ ...justDone, now: 9_500 });
		expect(frozen).toBe("已完成，用时 8 秒");
		// 时间往前走，文案不许变（也不许比跑着时小）
		expect(groupStatus({ ...justDone, now: 12_000 })).toBe(frozen);
		// 超过 4 秒就该收起来了
		expect(activityRun(messages, 9_000 + ACTIVITY_DONE_MS + 1)).toBeNull();
	});

	it("别人说话不算这一段活的结束时间（不许把后一个人的发言记到前一个人头上）", () => {
		const messages = [think(1_000), think(3_000), say(9_000, "沈舟")];
		// 结束时间 = 林越最后一条过程行（3s），不是沈舟说话的 9s
		const run = activityRun(messages, 3_500);
		expect(run?.slug).toBe("知言");
		expect(run?.running).toBe(false);
		expect(run?.endAt).toBe(3_000);
		expect(groupStatus({ ...run, now: 3_500 })).toBe("已完成，用时 2 秒");
		// 别人说话那一秒早就过了 4 秒窗口：这条不该再显示
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
