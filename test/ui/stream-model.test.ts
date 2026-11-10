/**
 * 「屏幕上一行一行是什么」—— `ui/app/src/stream/model.ts` 的 `buildRows`。
 *
 * 这里只剩三件事：**同一人连发算一段**（grouped / cont 两个标记）、**时间分隔**与
 * **正在跑的那一轮**（`live` 行）。过程（思考 / 命令 / 文件）只进「后台任务」面板，
 * 聊天流里不画（ADR-062）。
 *
 * 消息只有 `chat` / `note` 两种 kind：旧数据（过程行、旧语义标签）由投影层归一
 * （ADR-061），这一层不需要认识它们。
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
	kind: "chat" | "note";
	text: string;
	noteOf?: string;
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
		const rows = build([m(1, "chat", T), m(2, "chat", T + 60 * SEC)]);
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
		const rows = build([m(1, "chat", T), m(2, "chat", T + 20 * SEC)]);
		const second = rows[1];
		if (second?.type !== "say") throw new Error("第二行应该是 say");
		expect(second.grouped).toBe(true);
		expect(second.cont).toBe(true);
	});

	it("间隔 121 秒（> 2 分钟）：两个独立行", () => {
		const rows = build([m(1, "chat", T), m(2, "chat", T + 121 * SEC)]);
		expect(rows.map((row) => row.type)).toEqual(["say", "say"]);
		const second = rows[1];
		if (second?.type !== "say") throw new Error("第二行应该是 say");
		expect(second.grouped).toBe(false);
		expect(second.cont).toBe(false);
	});

	it("换了人就不合并，哪怕只隔 10 秒", () => {
		const rows = build([m(1, "chat", T), m(2, "chat", T + 10 * SEC, "shenzhou")]);
		const second = rows[1];
		if (second?.type !== "say") throw new Error("第二行应该是 say");
		expect(second.grouped).toBe(false);
		expect(second.cont).toBe(false);
	});

	it("时间倒流（同一秒内乱序到达）不算续话", () => {
		const rows = build([m(1, "chat", T), m(2, "chat", T - SEC)]);
		const second = rows[1];
		if (second?.type !== "say") throw new Error("第二行应该是 say");
		expect(second.cont).toBe(false);
	});
});

describe("时间分隔", () => {
	it("间隔超过 30 分钟插一条 divider", () => {
		const rows = build([m(1, "chat", T), m(2, "chat", T + 31 * MIN)]);
		expect(rows.map((row) => row.type)).toEqual(["say", "divider", "say"]);
		const divider = rows[1];
		if (divider?.type !== "divider") throw new Error("中间应该是 divider");
		// 同一天：文案以「今天」开头，后面跟 HH:MM
		expect(divider.label.startsWith("今天 ")).toBe(true);
	});

	it("不到 30 分钟不插", () => {
		expect(types([m(1, "chat", T), m(2, "chat", T + 29 * MIN)])).toEqual(["say", "say"]);
	});

	it("跨天必插（哪怕只隔 10 分钟）", () => {
		// 用本地时间构造：CI 跑在 UTC，写死 +08:00 的话这两个时刻会落在同一天。
		const midnight = new Date(2026, 4, 7, 0, 5, 0).getTime();
		const before = midnight - 10 * MIN;
		expect(types([m(1, "chat", before), m(2, "chat", midnight)])).toEqual(["say", "divider", "say"]);
	});

	it("分隔之后不再算同一段：grouped 归零", () => {
		const rows = build([m(1, "chat", T), m(2, "chat", T + 31 * MIN)]);
		const second = rows[2];
		if (second?.type !== "say") throw new Error("最后一行应该是 say");
		expect(second.grouped).toBe(false);
	});
});

describe("note 与其余 kind", () => {
	// ADR-047：系统留痕与沉淀账本不进聊天流；后台命令那条折成一行留着。
	it("系统留痕不画，也不打断连发合并", () => {
		const rows = build([m(1, "chat", T), m(2, "note", T + SEC), m(3, "chat", T + 2 * SEC)]);
		expect(rows.map((row) => row.type)).toEqual(["say", "say"]);
		const last = rows[1];
		if (last?.type !== "say") throw new Error("第二行应该是 say");
		expect(last.grouped).toBe(true);
	});

	it("后台命令跑完的留痕（noteOf=run）照旧单独成行", () => {
		const run = { ...m(2, "note", T + SEC), noteOf: "run" };
		const rows = build([m(1, "chat", T), run, m(3, "chat", T + 2 * SEC)]);
		expect(rows.map((row) => row.type)).toEqual(["say", "note", "say"]);
	});

});

describe("正在跑的那一轮：live 行（派生，不是消息）", () => {
	const turn = (channelId: string, seq: number, startedAt: number, slug = "linyue") => ({
		channelId,
		seq,
		slug,
		label: slug,
		status: "running",
		startedAt,
		stepCount: 3,
		summary: "运行 1 条命令",
	});

	it("没有人在跑：只有消息", () => {
		const rows = buildRows({ messages: [m(1, "chat", T)], running: [], now: T + MIN });
		expect(rows.map((row) => row.type)).toEqual(["say"]);
	});

	it("跑着的那一轮插在触发消息之后（位置就是回复将来会落的地方）", () => {
		const rows = buildRows({
			messages: [m(1, "chat", T), m(2, "chat", T + 2 * MIN)],
			running: [turn("team:alpha", 1, T + MIN)],
			now: T + 3 * MIN,
		});
		expect(rows.map((row) => row.type)).toEqual(["say", "live", "say"]);
		const live = rows[1];
		if (live?.type !== "live") throw new Error("中间应该是 live 行");
		expect(live.turn.seq).toBe(1);
	});

	it("回话之后就不再画：同一件事不能同时出现占位和真回复", () => {
		const rows = buildRows({
			messages: [m(1, "chat", T)],
			running: [{ ...turn("team:alpha", 1, T + MIN), replySeq: 2, status: "done" }],
			now: T + 3 * MIN,
		});
		expect(rows.map((row) => row.type)).toEqual(["say"]);
	});

	it("trace 的结算帧比 create 慢半拍时：他已经说过话，就不再画占位", () => {
		const rows = buildRows({
			messages: [m(1, "chat", T, "owner"), m(2, "chat", T + MIN, "linyue")],
			running: [turn("team:alpha", 1, T)],
			now: T + 3 * MIN,
		});
		expect(rows.map((row) => row.type)).toEqual(["say", "say"]);
	});

	it("同时叫醒两个人：两条占位，按开始时间排", () => {
		const rows = buildRows({
			messages: [m(1, "chat", T, "owner")],
			running: [turn("team:alpha", 1, T + 2 * SEC, "shen"), turn("team:alpha", 1, T + SEC, "linyue")],
			now: T + 3 * MIN,
		});
		expect(rows.map((row) => row.type)).toEqual(["say", "live", "live"]);
		const slugs = rows.flatMap((row) => (row.type === "live" ? [row.turn.slug] : []));
		expect(slugs).toEqual(["linyue", "shen"]);
	});

	it("时间分隔属于它下面那条消息：占位插在分隔之前", () => {
		const rows = buildRows({
			messages: [m(1, "chat", T), m(2, "chat", T + 60 * MIN)],
			running: [turn("team:alpha", 5, T + 40 * MIN)],
			now: T + 90 * MIN,
		});
		expect(rows.map((row) => row.type)).toEqual(["say", "live", "divider", "say"]);
	});
});

describe("「以下是新的」那条线", () => {
	it("插在第一条没读过的消息前面，条数按它之后的算", () => {
		const rows = buildRows({
			messages: [m(1, "chat", T), m(2, "chat", T + MIN), m(3, "chat", T + 2 * MIN)],
			unreadBefore: 1,
			now: T + 3 * MIN,
		});
		expect(rows.map((row) => row.type)).toEqual(["say", "unread", "say", "say"]);
		const line = rows.find((row) => row.type === "unread");
		expect(line?.type === "unread" ? line.count : undefined).toBe(2);
	});

	it("只画一条：中间夹着几条也不重复插", () => {
		const rows = buildRows({
			messages: [m(1, "chat", T), m(2, "chat", T + MIN), m(3, "chat", T + 40 * MIN)],
			unreadBefore: 1,
			now: T + 50 * MIN,
		});
		expect(rows.filter((row) => row.type === "unread")).toHaveLength(1);
	});

	it("全是新的（起点 -1）：线在最前面", () => {
		const rows = buildRows({ messages: [m(1, "chat", T), m(2, "chat", T + MIN)], unreadBefore: -1, now: T + MIN });
		expect(rows[0]?.type).toBe("unread");
	});

	it("没有未读（不给起点）：一条都不插", () => {
		const rows = buildRows({ messages: [m(1, "chat", T)], now: T });
		expect(rows.some((row) => row.type === "unread")).toBe(false);
	});

	it("起点已经是最后一条：不插（差几条就空线，不如不画）", () => {
		const rows = buildRows({ messages: [m(1, "chat", T), m(2, "chat", T + MIN)], unreadBefore: 2, now: T + MIN });
		expect(rows.some((row) => row.type === "unread")).toBe(false);
	});

	it("系统留痕不算未读、也不当起点", () => {
		const rows = buildRows({
			messages: [m(1, "chat", T), m(2, "note", T + SEC), m(3, "chat", T + 2 * SEC)],
			unreadBefore: 1,
			now: T + 3 * SEC,
		});
		// 那条 note 不是 run 留痕，不画；未读只剩 seq 3 这一条。
		const line = rows.find((row) => row.type === "unread");
		expect(line?.type === "unread" ? line.count : undefined).toBe(1);
	});
});
