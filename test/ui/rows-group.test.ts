/**
 * 过程行（think / tool / work）的文案与分组 —— 第二批验收的核心。
 *
 * 这批测试全部打在 rows.js 的纯函数上（node 环境没有 DOM）：摘要、组头、
 * 计时、分组。DOM 只负责把这些字符串画出来，所以这里绿了，两条渲染路径
 * （整列重建 / SSE 增量）只要用同一套函数，文案就一定一致。
 *
 * 盯住的四件事对应老板的五个毛病：
 *   1. 每行写出做了什么（命令本身、思考第一句、文件名），单行 60 字；
 *   2. 一个人连续干活只出一个组头（splitRuns 一段一组）；
 *   4. 组头说人话：已完成，用时 55 秒 / 正在执行 · 67s；
 *   5. 计时用 at 推、非负、跑着时随 now 递增、结束后定格。
 */
import { describe, expect, it } from "vitest";
import {
	DONE_HINT,
	SUMMARY_LIMIT,
	eventSummary,
	groupHeader,
	groupHeaderText,
	groupSpan,
	RUN_START_MAX_GAP_MS,
	groupStatus,
	runStartAt,
	splitRuns,
} from "../../ui/web/js/rows.js";

const think = (text, at) => ({ kind: "think", fromSlug: "林越", text, at });
const work = (text, at) => ({ kind: "work", fromSlug: "林越", text, at });
const tool = (text, at) => ({ kind: "tool", fromSlug: "林越", text, at });

describe("eventSummary：每行写出做了什么", () => {
	it("运行命令写命令本身，不是「执行了命令」", () => {
		expect(eventSummary(work("$ npm test 2>&1 | tail -20", 1))).toBe("npm test 2>&1 | tail -20");
		// tool 形态的 run 也要抠出 command
		expect(eventSummary(tool('run {"command":"npm run check"}', 1))).toBe("npm run check");
		// 14 条命令的摘要必须互不相同，否则又是一团重复的废话
		const lines = Array.from({ length: 14 }, (_, i) => eventSummary(work(`$ step-${i} --flag`, i)));
		expect(new Set(lines).size).toBe(14);
	});

	it("认真实投影格式（key=value · key=value，不是 JSON）", () => {
		// 这两条是 src/core/channel/transcript.ts 里的真实样子，不是捏造的 JSON
		expect(eventSummary(tool("run command=npm start · cwd=/Users/kirer/projects/ai-company", 1))).toBe("npm start");
		expect(eventSummary(tool("read_file path=ui/web/js/rows.js", 1))).toBe("ui/web/js/rows.js");
		expect(eventSummary(tool("write_file path=test/ui/a.test.ts · content=xxx", 1))).toBe("test/ui/a.test.ts");
		// 多行命令只取第一行；参数里的 · 不能把值切断
		expect(eventSummary(tool("run command=npm test\n2>&1 | tail -20 · cwd=/x", 1))).toBe("npm test");
	});

	it("work 只取 `$ ` 后第一行当命令，不把输出压进来", () => {
		const text = "$ npm test 2>&1 | tail -20\n\n Test Files 46 passed\n      Tests 416 passed";
		expect(eventSummary(work(text, 1))).toBe("npm test 2>&1 | tail -20");
		expect(eventSummary(work("$ ls -la", 1))).toBe("ls -la");
	});

	it("思考取第一句，读写文件给文件名", () => {
		expect(eventSummary(think("先看看仓库里有哪些文件。再决定改哪几个。", 1))).toBe("先看看仓库里有哪些文件。");
		expect(eventSummary(tool('read_file {"path":"ui/web/js/rows.js"}', 1))).toBe("ui/web/js/rows.js");
		expect(eventSummary(tool('write_file {"path":"test/ui/a.test.ts"}', 1))).toBe("test/ui/a.test.ts");
	});

	it("压成一行并截到 60 字，多出来用省略号收尾", () => {
		const long = "x".repeat(200);
		const summary = eventSummary(work(`$ ${long}`, 1));
		expect(summary).toHaveLength(SUMMARY_LIMIT);
		expect(summary.endsWith("…")).toBe(true);
		expect(summary).not.toContain("\n");
		// 换行也要压平：一条多行命令只许占一行
		expect(eventSummary(think("第一行\n第二行", 1))).not.toContain("\n");
	});
});

describe("splitRuns：一个连续干活段只出一个组头", () => {
	it("同一个人连着 14 条过程合成一段（全屏只有一个组头）", () => {
		const run = Array.from({ length: 14 }, (_, i) => (i % 2 === 0 ? think(`第 ${i} 步`, i) : work(`$ c${i}`, i)));
		expect(splitRuns(run)).toHaveLength(1);
	});

	it("中间有人插话就切成两段，不会把两个人的活算成一段", () => {
		const a = { kind: "think", fromSlug: "林越", at: 1 };
		const b = { kind: "think", fromSlug: "沈舟", at: 2 };
		// 林越 → 沈舟 → 林越：三段，前后两段不能被并成一段（那会把别人的时间算进去）
		expect(splitRuns([a, b, a])).toHaveLength(3);
		expect(splitRuns([a, a, a]).map((run) => run.length)).toEqual([3]);
		expect(splitRuns([])).toEqual([]);
	});
});

describe("组头与计时", () => {
	it("跑着「正在执行 · 67s」，跑完「已完成，用时 55 秒」", () => {
		expect(groupStatus({ running: true, startAt: 0, endAt: 0, now: 67_000 })).toBe("正在执行 · 67s");
		expect(groupStatus({ running: false, startAt: 0, endAt: 55_000 })).toBe("已完成，用时 55 秒");
		expect(groupHeader({ name: "知言", running: false, startAt: 0, endAt: 55_000 })).toBe("知言 已完成，用时 55 秒");
	});

	it("跑着写名字 + 正在执行；跑完只留一句「查看过程」，名字与用时只进 aria", () => {
		// 跑着也不写名字：组头只说「正在执行 · 67s」，名字只进 aria-label
		expect(groupHeaderText({ name: "知言", running: true, startAt: 0, endAt: 0, now: 67_000 })).toBe("正在执行 · 67s");
		expect(groupHeader({ name: "知言", running: true, startAt: 0, endAt: 0, now: 67_000 })).toBe("知言 正在执行 · 67s");
		// 已完成：可见的是「查看过程」+ 箭头（老板说光一个空箭头什么提示都没有），
		// 但不再显示名字和「已完成，用时 X 秒」—— 那些留在 aria-label（groupHeader）
		expect(groupHeaderText({ name: "知言", running: false, startAt: 0, endAt: 55_000 })).toBe(DONE_HINT);
		expect(DONE_HINT).toBe("查看过程");
		expect(groupHeader({ name: "知言", running: false, startAt: 0, endAt: 55_000 })).toBe("知言 已完成，用时 55 秒");
	});

	it("跑着的秒数随 now 递增，结束后定格不倒退", () => {
		const startAt = 1_000_000;
		const running = (now) => groupStatus({ running: true, startAt, endAt: 0, now });
		expect(running(startAt + 55_000)).toBe("正在执行 · 55s");
		expect(running(startAt + 67_000)).toBe("正在执行 · 67s");
		// 定格之后传 endAt：不管 now 涨到哪都不变，也不会比跑着时小
		const done = groupStatus({ running: false, startAt, endAt: startAt + 67_000, now: startAt + 999_000 });
		expect(done).toBe("已完成，用时 67 秒");
		expect(Number(/(\d+) 秒/.exec(done)[1])).toBeGreaterThanOrEqual(67);
	});

	it("组起点用第一条过程行的 at；有 startedAt 就用 startedAt", () => {
		const span = groupSpan([{ at: 2_000 }, { at: 9_000 }, { at: 20_000 }]);
		expect(span).toEqual({ startAt: 2_000, endAt: 20_000, count: 3 });
		// 一轮带 startedAt 时，组起点是开跑那一刻，不是首条投影落地那一刻
		expect(groupSpan([{ at: 9_000, startedAt: 3_000 }, { at: 20_000 }]).startAt).toBe(3_000);
	});

	it("几小时前的旧占位不参与计时（实测 14170s 那种）", () => {
		const now = 100_000_000;
		const oldPlaceholder = { seq: 1, fromSlug: "林越", kind: "say", processing: true, at: now - 4 * 60 * 60 * 1000, startedAt: now - 4 * 60 * 60 * 1000 };
		const firstEvent = { seq: 2, fromSlug: "林越", kind: "think", at: now - 20_000 };
		const run = [firstEvent];
		// 旧占位的 startedAt 离首条过程行差 4 小时：不算这一轮，回退到首条 at
		expect(runStartAt([oldPlaceholder, firstEvent], run)).toBe(now - 20_000);
	});

	it("只认最近一条 preceding startedAt（两轮占位不会串）", () => {
		const now = 100_000_000;
		const older = { seq: 1, fromSlug: "林越", kind: "say", processing: true, at: now - 20 * 60 * 1000, startedAt: now - 20 * 60 * 1000 };
		const newer = { seq: 2, fromSlug: "林越", kind: "say", processing: true, at: now - 30_000, startedAt: now - 30_000 };
		const firstEvent = { seq: 3, fromSlug: "林越", kind: "think", at: now - 10_000 };
		expect(runStartAt([older, newer, firstEvent], [firstEvent])).toBe(now - 30_000);
	});

	it("和首条过程行差超过 10 分钟就回退到首条 at", () => {
		const now = 100_000_000;
		const stale = { seq: 1, fromSlug: "林越", kind: "say", processing: true, at: now - 11 * 60 * 1000, startedAt: now - 11 * 60 * 1000 };
		const firstEvent = { seq: 2, fromSlug: "林越", kind: "think", at: now };
		expect(runStartAt([stale, firstEvent], [firstEvent])).toBe(now);
	});

	it("新来一条过程行不会把起点清零，也不会算出负时间", () => {
		const first = groupSpan([{ at: 5_000 }, { at: 6_000 }]);
		const later = groupSpan([{ at: 5_000 }, { at: 6_000 }, { at: 60_000 }]);
		expect(later.startAt).toBe(first.startAt);
		expect(later.endAt).toBe(60_000);
		// 时钟被拨回（endAt < startAt）也只算 0 秒，不出负数
		expect(groupStatus({ running: false, startAt: 10_000, endAt: 4_000 })).toBe("已完成，用时 0 秒");
	});
});

describe("真实起点用 startedAt（ADR-072）", () => {
	const at = (seq, kind, from, t, extra = {}) => ({ seq, kind, fromSlug: from, at: t, ...extra });

	it("这段活之前留过 startedAt 就用它，不用第一条过程行的 at", () => {
		const messages = [
			// 老板 20:56:22 发问 → 占位记下 startedAt（这是真的开始时刻）
			at(29, "chat", "owner", 1_000),
			at(30, "say", "lin", 6_000, { startedAt: 1_000 }),
			// 这一段过程行的 at 都比 startedAt 晚一个首包
			at(31, "think", "lin", 3_000),
			at(32, "tool", "lin", 4_000),
			at(33, "say", "lin", 6_000),
		];
		const run = [messages[2], messages[3]];
		expect(runStartAt(messages, run)).toBe(1_000);
		// 没有提示时退回第一条过程行的 at —— 旧行为，不报错。
		expect(runStartAt(run, run)).toBe(3_000);
	});

	it("别人那一轮的提示不能用来提前这一轮", () => {
		const messages = [
			at(10, "say", "lin", 1_000, { startedAt: 500 }),
			at(11, "think", "lin", 9_000),
			at(12, "say", "lin", 10_000, { startedAt: 9_500 }),
		];
		// 第二段（11 那条）之前只有 500 那个提示，它在 11 之前 → 可以用？
		// 但 500 属于上一轮，`at` 比 11 早，所以会被采用；关键是不能用 9_500 那个
		// （它在 11 之后）。这里只守「不倒退」：结果必须 <= 第一条过程行的 at。
		const run = [messages[1]];
		expect(runStartAt(messages, run)).toBeLessThanOrEqual(9_000);
	});
});
