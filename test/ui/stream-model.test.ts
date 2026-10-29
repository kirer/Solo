/**
 * 「屏幕上一行一行是什么」—— `ui/app/src/stream/model.ts` 的 `buildRows`。
 *
 * 重构前这件事混在「造 DOM 结点」的流程里，顺序、分组、占位、分隔各自散在几百行
 * 命令式代码中，症状是「过程行跑到头像上面」「同一段活画成两组」「刷新后少了几句」。
 * 抽成纯函数之后规则可以单独钉住：
 *
 *   1. **过程行归属它后面那句话** —— rows 里 say 在 events 之前（先结论后细节）；
 *   2. **同一段活只画一个组头** —— 攒着的过程行按人收成一组；
 *   3. **同一人半分钟内连发算一段** —— grouped / cont 两个标记的口径。
 *
 * 写的时候核对过真实语义，两处与「想当然」不同，测试按代码来：
 *   - 过程行缓冲是**按人**的（`buffers: Map<slug, Message[]>`），所以中间插了**别人的
 *     一句话**并不会把同一个人的过程行切成两组；真正的切分点是「他自己开口」「note」
 *     「处理中占位」「时间分隔」（后三者走 `flushAll`）。
 *   - 结尾还攒着过程行时，`runningSlug` 没传的话**最后一个**攒着的 slug 算「还在跑」，
 *     于是顺带返回一条底部活动行。所以「不丢」这件事同时意味着 activity 非 null。
 */
import { describe, expect, it } from "vitest";
import { buildRows } from "../../ui/app/src/stream/model.ts";
import { PLACEHOLDER_TTL_MS } from "../../ui/app/src/rows.ts";

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
	processing?: boolean;
	startedAt?: number;
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

const build = (messages: Msg[], extra: { channelKind?: string; runningSlug?: string; now?: number } = {}) =>
	buildRows({
		messages,
		channelKind: extra.channelKind ?? "dm",
		...(extra.runningSlug === undefined ? {} : { runningSlug: extra.runningSlug }),
		now: extra.now ?? T + 60 * MIN,
	});

const types = (messages: Msg[]) => build(messages).rows.map((row) => row.type);

describe("同一人连发：grouped / cont 的口径", () => {
	it("间隔 60 秒：算同一段（grouped），但不是半分钟内的续话（cont）", () => {
		const { rows } = build([m(1, "say", T), m(2, "say", T + 60 * SEC)]);
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
		const { rows } = build([m(1, "say", T), m(2, "say", T + 20 * SEC)]);
		const second = rows[1];
		if (second?.type !== "say") throw new Error("第二行应该是 say");
		expect(second.grouped).toBe(true);
		expect(second.cont).toBe(true);
	});

	it("间隔 121 秒（> 2 分钟）：两个独立行", () => {
		const { rows } = build([m(1, "say", T), m(2, "say", T + 121 * SEC)]);
		expect(rows.map((row) => row.type)).toEqual(["say", "say"]);
		const second = rows[1];
		if (second?.type !== "say") throw new Error("第二行应该是 say");
		expect(second.grouped).toBe(false);
		expect(second.cont).toBe(false);
	});

	it("换了人就不合并，哪怕只隔 10 秒", () => {
		const { rows } = build([m(1, "say", T), m(2, "say", T + 10 * SEC, "shenzhou")]);
		const second = rows[1];
		if (second?.type !== "say") throw new Error("第二行应该是 say");
		expect(second.grouped).toBe(false);
		expect(second.cont).toBe(false);
	});
});

describe("过程行归属它后面那句话", () => {
	it("先 think 再说：rows 里 say 在前、events 在后", () => {
		const { rows } = build([m(1, "think", T), m(2, "say", T + 5 * SEC)]);
		expect(rows.map((row) => row.type)).toEqual(["say", "events"]);
		const [sayRow, eventsRow] = rows;
		if (sayRow?.type !== "say" || eventsRow?.type !== "events") throw new Error("顺序不对");
		expect(sayRow.message.seq).toBe(2);
		expect(eventsRow.entries.map((entry) => entry.seq)).toEqual([1]);
		// 这句话说完了，这一组不再是「正在跑」
		expect(eventsRow.running).toBe(false);
	});
});

describe("一段活只画一个组头", () => {
	it("同一个人连着 3 条过程行收成一个 events 组", () => {
		const { rows } = build([
			m(1, "think", T),
			m(2, "tool", T + SEC),
			m(3, "work", T + 2 * SEC),
			m(4, "say", T + 3 * SEC),
		]);
		expect(rows.map((row) => row.type)).toEqual(["say", "events"]);
		const group = rows[1];
		if (group?.type !== "events") throw new Error("第二行应该是 events");
		expect(group.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
		expect(group.slug).toBe("zhiyan");
	});

	it("别人的一句话不会把同一个人的过程行切成两组（缓冲按人分）", () => {
		const { rows } = build([
			m(1, "think", T, "linyue"),
			m(2, "say", T + SEC, "shenzhou"),
			m(3, "think", T + 2 * SEC, "linyue"),
			m(4, "say", T + 3 * SEC, "linyue"),
		]);
		// 沈舟那句照常成行；林越的两条 think 仍收在同一组里
		expect(rows.map((row) => row.type)).toEqual(["say", "say", "events"]);
		const group = rows[2];
		if (group?.type !== "events") throw new Error("最后一行应该是 events");
		expect(group.slug).toBe("linyue");
		expect(group.entries.map((entry) => entry.seq)).toEqual([1, 3]);
	});

	it("他自己开口就切开：两组各一条", () => {
		const { rows } = build([
			m(1, "think", T),
			m(2, "say", T + SEC),
			m(3, "think", T + 2 * SEC),
			m(4, "say", T + 3 * SEC),
		]);
		expect(rows.map((row) => row.type)).toEqual(["say", "events", "say", "events"]);
		for (const row of rows) {
			if (row.type === "events") expect(row.entries).toHaveLength(1);
		}
	});

	it("note 是硬边界（flushAll）：它前后的过程行分成两组", () => {
		const { rows } = build([
			m(1, "think", T),
			m(2, "note", T + SEC),
			m(3, "think", T + 2 * SEC),
			m(4, "say", T + 3 * SEC),
		]);
		expect(rows.map((row) => row.type)).toEqual(["events", "note", "say", "events"]);
	});
});

describe("时间分隔", () => {
	it("间隔超过 30 分钟插一条 divider", () => {
		const { rows } = build([m(1, "say", T), m(2, "say", T + 31 * MIN)]);
		expect(rows.map((row) => row.type)).toEqual(["say", "divider", "say"]);
		const divider = rows[1];
		if (divider?.type !== "divider") throw new Error("中间应该是 divider");
		// 同一天：文案以「今天」开头，后面跟 HH:MM
		expect(divider.label.startsWith("今天 ")).toBe(true);
	});

	it("不到 30 分钟不插", () => {
		const { rows } = build([m(1, "say", T), m(2, "say", T + 29 * MIN)]);
		expect(rows.map((row) => row.type)).toEqual(["say", "say"]);
	});
});

describe("处理中占位", () => {
	const placeholder = (seq: number, at: number): Msg => ({
		...m(seq, "say", at),
		text: "开始处理",
		processing: true,
		startedAt: at,
	});

	it("超过 PLACEHOLDER_TTL_MS 的占位不产生行", () => {
		const ph = placeholder(1, T);
		const { rows } = build([ph], { now: T + PLACEHOLDER_TTL_MS + 1 });
		expect(rows).toEqual([]);
	});

	it("还活着的占位画一行，计时起点用 startedAt", () => {
		const ph = { ...placeholder(1, T), startedAt: T - 5 * SEC };
		const { rows } = build([ph], { now: T + MIN });
		expect(rows.map((row) => row.type)).toEqual(["processing"]);
		const row = rows[0];
		if (row?.type !== "processing") throw new Error("应该是 processing 行");
		expect(row.startAt).toBe(T - 5 * SEC);
	});
});

describe("其余口径", () => {
	it("未知 kind 不产生行（不画、不占高）", () => {
		expect(types([m(1, "mystery", T)])).toEqual([]);
	});

	it("结尾还攒着过程行 → 生成一个 events 行，并给出底部活动行（不丢）", () => {
		const { rows, activity } = build([m(1, "think", T)]);
		expect(rows.map((row) => row.type)).toEqual(["events"]);
		const group = rows[0];
		if (group?.type !== "events") throw new Error("应该是 events 行");
		expect(group.entries.map((entry) => entry.seq)).toEqual([1]);
		// 没传 runningSlug：最后一个攒着的 slug 算「还在跑」
		expect(group.running).toBe(true);
		expect(activity?.slug).toBe("zhiyan");
		expect(activity?.phrase).toBe("在想事情");
	});

	it("明确传了 runningSlug 时，收尾的组按它在不在跑来定", () => {
		const messages = [m(1, "think", T, "linyue")];
		const running = build(messages, { runningSlug: "linyue", now: T + MIN });
		const idle = build(messages, { runningSlug: "shenzhou", now: T + MIN });
		const runningGroup = running.rows[0];
		const idleGroup = idle.rows[0];
		if (runningGroup?.type !== "events" || idleGroup?.type !== "events") throw new Error("应该是 events 行");
		expect(runningGroup.running).toBe(true);
		expect(idleGroup.running).toBe(false);
		expect(running.activity).not.toBeNull();
		expect(idle.activity).toBeNull();
	});
});
