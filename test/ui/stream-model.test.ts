/**
 * 「屏幕上一行一行是什么」—— `ui/app/src/stream/model.ts` 的 `buildRows`。
 *
 * ADR-081 之后这里只剩两件事：**同一人连发算一段**（grouped / cont 两个标记）与
 * **时间分隔**。过程行（think/tool/work）、step 合并、占位、底部活动行全部删掉了：
 * 数据模型里没有「他正在做什么」，界面也就不画。
 *
 * 历史库里还有那些 kind 的消息，规则是**直接过滤**（不画成普通行）—— 见下面
 * 「历史过程 kind」那一组。
 */
import { describe, expect, it } from "vitest";
import { buildRows } from "../../ui/app/src/stream/model.ts";

/** 固定基准时刻，测试里所有时间都相对它算 —— 不用 Date.now()，断言才不会看运气。 */
const T = new Date("2026-05-06T12:00:00+08:00").getTime();

const SEC = 1_000;
const MIN = 60 * SEC;

type Msg = {
	seq: number;
	at: number;
	fromSlug: string;
	fromLabel: string;
	kind: string;
	text: string;
};

/** 造一条消息。只填 buildRows 真正读的字段（投影里其余字段它不碰）。 */
const m = (seq: number, kind: string, at: number, slug = "zhiyan"): Msg => ({
	seq,
	at,
	fromSlug: slug,
	fromLabel: slug,
	kind,
	text: `${kind} ${seq}`,
});

const build = (messages: Msg[], now = T + 60 * MIN) => buildRows({ messages, now });

const types = (messages: Msg[]) => build(messages).map((row) => row.type);

describe("同一人连发：grouped / cont 的口径", () => {
	it("间隔 60 秒：算同一段（grouped），但不是半分钟内的续话（cont）", () => {
		const rows = build([m(1, "say", T), m(2, "say", T + 60 * SEC)]);
		expect(rows.map((row) => row.type)).toEqual(["say", "say"]);
		const first = rows[0];
		const second = rows[1];
		if (first?.type !== "say" || second?.type !== "say") throw new Error("应该是两个 say 行");
		// 第一句前面没人说过话
		expect(first.grouped).toBe(false);
		expect(first.cont).toBe(false);
		expect(second.grouped).toBe(true);
		expect(second.cont).toBe(false);
	});

	it("间隔 20 秒：grouped 且 cont（气泡角连起来、时间不画）", () => {
		const rows = build([m(1, "say", T), m(2, "say", T + 20 * SEC)]);
		const second = rows[1];
		if (second?.type !== "say") throw new Error("第二行应该是 say");
		expect(second.grouped).toBe(true);
		expect(second.cont).toBe(true);
	});

	it("间隔 121 秒（> 2 分钟）：两个独立行", () => {
		const rows = build([m(1, "say", T), m(2, "say", T + 121 * SEC)]);
		expect(rows.map((row) => row.type)).toEqual(["say", "say"]);
		const second = rows[1];
		if (second?.type !== "say") throw new Error("第二行应该是 say");
		expect(second.grouped).toBe(false);
		expect(second.cont).toBe(false);
	});

	it("换了人就不合并，哪怕只隔 10 秒", () => {
		const rows = build([m(1, "say", T), m(2, "say", T + 10 * SEC, "shenzhou")]);
		const second = rows[1];
		if (second?.type !== "say") throw new Error("第二行应该是 say");
		expect(second.grouped).toBe(false);
		expect(second.cont).toBe(false);
	});

	it("时间倒流（同一秒内乱序到达）不算续话", () => {
		const rows = build([m(1, "say", T), m(2, "say", T - SEC)]);
		const second = rows[1];
		if (second?.type !== "say") throw new Error("第二行应该是 say");
		expect(second.cont).toBe(false);
	});
});

describe("时间分隔", () => {
	it("间隔超过 30 分钟插一条 divider", () => {
		const rows = build([m(1, "say", T), m(2, "say", T + 31 * MIN)]);
		expect(rows.map((row) => row.type)).toEqual(["say", "divider", "say"]);
		const divider = rows[1];
		if (divider?.type !== "divider") throw new Error("中间应该是 divider");
		// 同一天：文案以「今天」开头，后面跟 HH:MM
		expect(divider.label.startsWith("今天 ")).toBe(true);
	});

	it("不到 30 分钟不插", () => {
		expect(types([m(1, "say", T), m(2, "say", T + 29 * MIN)])).toEqual(["say", "say"]);
	});

	it("跨天必插（哪怕只隔 10 分钟）", () => {
		const midnight = new Date("2026-05-07T00:05:00+08:00").getTime();
		const before = midnight - 10 * MIN;
		expect(types([m(1, "say", before), m(2, "say", midnight)])).toEqual(["say", "divider", "say"]);
	});

	it("分隔之后不再算同一段：grouped 归零", () => {
		const rows = build([m(1, "say", T), m(2, "say", T + 31 * MIN)]);
		const second = rows[2];
		if (second?.type !== "say") throw new Error("最后一行应该是 say");
		expect(second.grouped).toBe(false);
	});
});

describe("note 与其余 kind", () => {
	it("note 单独成行，且打断连发合并", () => {
		const rows = build([m(1, "say", T), m(2, "note", T + SEC), m(3, "say", T + 2 * SEC)]);
		expect(rows.map((row) => row.type)).toEqual(["say", "note", "say"]);
		const last = rows[2];
		if (last?.type !== "say") throw new Error("最后一行应该是 say");
		expect(last.grouped).toBe(false);
	});

	it("未知 kind 不产生行（不画、不占高）", () => {
		expect(types([m(1, "mystery", T)])).toEqual([]);
	});
});

describe("历史过程 kind：过滤，不画成普通行", () => {
	// ADR-081 停止生成这些 kind，但不做数据清洗：库里仍有、`chats(action=read)` 仍读得到，
	// 只是这一屏不显示 —— 画成普通行会被误读成「他说了这句话」。
	for (const kind of ["think", "tool", "work", "step"]) {
		it(`${kind} 不产生行，也不打断前后的连发`, () => {
			const rows = build([m(1, "say", T), m(2, kind, T + SEC), m(3, "say", T + 2 * SEC)]);
			expect(rows.map((row) => row.type)).toEqual(["say", "say"]);
			const second = rows[1];
			if (second?.type !== "say") throw new Error("第二行应该是 say");
			expect(second.message.seq).toBe(3);
			// 过程行是透明的：它没说话，也就不该让下一句「重画头像」。
			expect(second.grouped).toBe(true);
		});
	}

	it("一个频道里只有过程行 → 空屏（不崩、不画占位）", () => {
		expect(types([m(1, "think", T), m(2, "tool", T + SEC)])).toEqual([]);
	});
});

describe("轨迹：run 行挂在触发它的那条消息下面", () => {
	const turn = (seq: number, slug: string, status = "done") => ({
		channelId: "c1",
		seq,
		slug,
		label: slug,
		status,
		startedAt: T,
		stepCount: 3,
		summary: "跑了 1 条命令",
	});

	it("有轨迹的消息后面跟一行 run，里面是那几轮", () => {
		const turns = new Map([[1, [turn(1, "zhiyan"), turn(1, "linyue")]]]);
		const rows = buildRows({ messages: [m(1, "say", T)], turns, now: T + MIN });
		expect(rows.map((row) => row.type)).toEqual(["say", "run"]);
		const run = rows[1];
		if (run?.type !== "run") throw new Error("第二行应该是 run");
		expect(run.seq).toBe(1);
		expect(run.turns.map((item) => item.slug)).toEqual(["zhiyan", "linyue"]);
	});

	it("没有轨迹就不多画一行（说了句话不等于干了件大事）", () => {
		const rows = buildRows({ messages: [m(1, "say", T)], turns: new Map(), now: T + MIN });
		expect(rows.map((row) => row.type)).toEqual(["say"]);
	});

	it("轨迹只挂在自己的 seq 上，不会串到隔壁那条消息", () => {
		const turns = new Map([[2, [turn(2, "zhiyan")]]]);
		const rows = buildRows({ messages: [m(1, "say", T), m(2, "say", T + SEC)], turns, now: T + MIN });
		expect(rows.map((row) => row.type)).toEqual(["say", "say", "run"]);
		const run = rows[2];
		if (run?.type !== "run") throw new Error("最后一行应该是 run");
		expect(run.seq).toBe(2);
	});

	it("系统 note 也能挂轨迹（它同样会叫醒人）", () => {
		const turns = new Map([[1, [turn(1, "zhiyan")]]]);
		const rows = buildRows({ messages: [m(1, "note", T)], turns, now: T + MIN });
		expect(rows.map((row) => row.type)).toEqual(["note", "run"]);
	});
});
