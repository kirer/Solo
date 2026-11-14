/**
 * 任务看板的形状（2.9.20）。接口还没实现，这里锁的是**界面上的三句话和一条排序**：
 * 顶上「在做 N 条、卡住 M 条」、抽屉里一条一行、做完的折成一行 —— 板上只剩活的。
 *
 * 数据用 `task-board-demo.ts` 那份假数据，它故意把五种状态和两种缺字段都排进去了，
 * 所以这一份测试同时也在验「缺字段时界面说什么」。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { demoTasks } from "../../ui/app/src/panels/task-board-demo.ts";
import { boardTasks, channelTasks } from "../../ui/app/src/panels/task-board-source.ts";
import {
	blockedReason,
	boardOf,
	doneLine,
	doneProof,
	idleLabel,
	type BoardTask,
	topLine,
} from "../../ui/app/src/panels/task-board-model.ts";

// 本地时间 2026-11-15 14:00 —— `doneToday` 的边界是本地 0 点，所以不能写 UTC 字符串。
const now = new Date(2026, 10, 15, 14, 0, 0).getTime();

const task = (patch: Partial<BoardTask> = {}): BoardTask => ({
	id: "t1",
	title: "一件事",
	owner: "shenchi",
	ownerLabel: "沈迟",
	status: "doing",
	channelId: "team:Solo",
	channelTitle: "Solo",
	originSeq: 1,
	changedAt: now,
	...patch,
});

describe("boardOf", () => {
	it("板上只有活的：done 和 dropped 一条都不进去", () => {
		const board = boardOf(demoTasks(now), now);
		expect(board.live.map((item) => item.id)).not.toContain("t2");
		expect(board.live.map((item) => item.id)).not.toContain("t4");
		expect(board.live.every((item) => item.status !== "done" && item.status !== "dropped")).toBe(true);
	});

	it("卡住的排最前，组内最久没动的在前", () => {
		const board = boardOf(demoTasks(now), now);
		expect(board.live.slice(0, 2).map((item) => item.id)).toEqual(["t3", "t8"]);
		// 两条 doing：t5 十二分钟前、t6 四十秒前
		expect(board.live.slice(2, 4).map((item) => item.id)).toEqual(["t5", "t6"]);
		expect(board.live.at(-1)?.id).toBe("t7");
	});

	it("今天的 done 折进 doneToday，昨天的不算、也不回到板上", () => {
		const board = boardOf(demoTasks(now), now);
		// t2 三小时前（今天 11:00）算；t1 二十小时前（昨天 18:00）不算。
		expect(board.doneToday.map((item) => item.id)).toEqual(["t2"]);
		expect(board.doneTodayCount).toBe(1);
	});

	it("dropped 不进任何计数", () => {
		const board = boardOf(demoTasks(now), now);
		expect(board.live.length + board.doneTodayCount).toBe(6);
		expect(boardOf([task({ status: "dropped", note: "不做了" })], now).empty).toBe(true);
	});

	it("计数只数板的上的，不做别的推断", () => {
		const board = boardOf(demoTasks(now), now);
		expect(board.doing).toBe(2);
		expect(board.blocked).toBe(2);
		expect(board.pending).toBe(1);
	});
});

describe("顶上那一行和完成那一行", () => {
	it("有活时是「在做 N 条 · 卡住 M 条」", () => {
		expect(topLine(boardOf(demoTasks(now), now))).toBe("在做 2 条 · 卡住 2 条 · 待办 1 条");
	});

	it("只有待办时不写「在做 0 条」", () => {
		expect(topLine(boardOf([task({ status: "open" }), task({ id: "t2", status: "open" })], now))).toBe("待办 2 条");
	});

	it("一条活的都没有时不留「在看板」的空话", () => {
		const board = boardOf([], now);
		expect(topLine(board)).toBe("板上没有活");
		expect(doneLine(board)).toBe("");
	});

	it("完成那一行是「今天完成 K 条」，0 条时不给这一行", () => {
		expect(doneLine(boardOf(demoTasks(now), now))).toBe("今天完成 1 条");
	});
});

describe("多久没动", () => {
	it("分钟 / 小时 / 天 / 刚动过", () => {
		expect(idleLabel(task({ changedAt: now - 20_000 }), now)).toBe("刚动过");
		expect(idleLabel(task({ changedAt: now - 12 * 60_000 }), now)).toBe("12 分钟没动");
		expect(idleLabel(task({ changedAt: now - 5 * 3_600_000 }), now)).toBe("5 小时没动");
		expect(idleLabel(task({ changedAt: now - 3 * 86_400_000 }), now)).toBe("3 天没动");
	});

	it("时钟偏了（未来时刻）按「刚动过」算，不写负数", () => {
		expect(idleLabel(task({ changedAt: now + 60_000 }), now)).toBe("刚动过");
	});
});

describe("缺字段时界面说什么", () => {
	it("blocked 没写原因 → 「没写原因」", () => {
		expect(blockedReason(task({ status: "blocked" }))).toBe("没写原因");
		expect(blockedReason(task({ status: "blocked", note: "   " }))).toBe("没写原因");
		expect(blockedReason(task({ status: "blocked", note: "等老板批窗口" }))).toBe("等老板批窗口");
	});

	it("done 没写凭据 → 「没写凭据」", () => {
		expect(doneProof(task({ status: "done" }))).toBe("没写凭据");
		expect(doneProof(task({ status: "done", note: "测试 12 条全过" }))).toBe("测试 12 条全过");
	});
});

/**
 * 形状的最后一层：组件用到的类名和 CSS 里的必须一一对上。
 *
 * 这一条防的是「改了 class 名、忘了改样式」——那种错 tsc 看不见，要等真机上看到
 * 一行没有间距的字才发现。
 *
 * 扫**两个**文件：`board.css` 现在两头都在用 —— 板子本体在 `TaskBoard.tsx`，
 * 装它的那一层（`.board-page`）在 `RightPanel.tsx`。只扫一个就会把另一个的类
 * 当成「没人用」。
 */
describe("类名和样式对得上", () => {
	const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
	const tsx = [
		read("../../ui/app/src/panels/TaskBoard.tsx"),
		read("../../ui/app/src/panels/RightPanel.tsx"),
	].join("\n");
	const css = read("../../ui/app/src/styles/board.css");

	// 只看 `board*` 的类：`RightPanel.tsx` 是别人的文件，它自己的 `detail`、`prof-card`
	// 归它自己的样式管，混进来只会逼着 `board.css` 去认领不属于它的类名。
	const used = new Set(
		[...tsx.matchAll(/className="([^"]+)"/g)]
			.flatMap((match) => match[1]!.split(/\s+/))
			.filter((name) => name === "board" || name.startsWith("board-")),
	);
	// `.board` 自己也是根节点的一个类，所以正则要允许没有后缀那一支。
	const defined = new Set([...css.matchAll(/\.(board(?:-[a-z-]+)?)/g)].map((match) => match[1]!));

	it("组件写的每个类都有样式", () => {
		expect(used.size).toBeGreaterThan(5);
		for (const name of used) expect(defined, `${name} 没有样式`).toContain(name);
	});

	it("CSS 里没有没人用的类", () => {
		for (const name of defined) expect(used, `${name} 没人用`).toContain(name);
	});

	it("样式表在 index.css 里被引了", () => {
		expect(read("../../ui/app/src/styles/index.css")).toContain('@import "./board.css";');
	});
});

/**
 * 频道里存的 `Task` → 看板要的 `BoardTask`。
 *
 * 这一段是「接口接上」那一刻唯一会变的地方：路远那边给 `ViewChannelDetail` 加上
 * `tasks` 之后，`boardTasks()` 拿到的就是真数据，这四条的结论不许变。
 */
describe("从频道数据翻成一行", () => {
	const detail = {
		channel: { title: "Solo" },
		members: [
			{ slug: "owner", label: "老板" },
			{ slug: "luyuan", label: "路远" },
		],
		messages: [
			{ seq: 70, at: 1_700_000_000_000, text: "路口那条我接了，先复现" },
			{ seq: 91, at: 1_700_000_600_000, text: "## 卡住了\n等老板批窗口" },
		],
		tasks: {
			t7: {
				id: "t7",
				title: "任务看板挂载",
				owner: "luyuan",
				status: "doing" as const,
				channelId: "group:solo",
				originSeq: 70,
				accept: "右栏点开能看到三条",
				history: [
					{ seq: 70, what: "created" },
					{ seq: 91, what: "status" },
				],
			},
		},
	};

	it("没有 tasks 就是空表，不补键", () => {
		expect(channelTasks({ channel: { title: "Solo" } })).toEqual([]);
		expect(boardTasks({ channel: { title: "Solo" } }, 0)).toEqual([]);
		expect(boardTasks(null, 0)).toEqual([]);
	});

	it("名字、频道名、起源 seq 都对上", () => {
		const [row] = boardTasks(detail, 1_700_000_650_000);
		expect(row).toMatchObject({
			id: "t7",
			title: "任务看板挂载",
			owner: "luyuan",
			ownerLabel: "路远",
			status: "doing",
			channelId: "group:solo",
			channelTitle: "Solo",
			originSeq: 70,
			accept: "右栏点开能看到三条",
		});
	});

	it("多久没动按最后一次变更那条消息算，note 取它的第一行", () => {
		const [row] = boardTasks(detail, 1_700_000_650_000);
		// 变更那条是 seq 91（600 秒那一条），不是起源那条。
		expect(row!.changedAt).toBe(1_700_000_600_000);
		// `## 卡住了` 的井号要剥掉，否则板上会原样写出「## 卡住了」。
		expect(row!.note).toBe("卡住了");
	});

	it("人调走了、消息不在这一页 → 用 slug 顶名、按刚动过算，不许算成 1970 年", () => {
		const sparse = {
			channel: { title: "Solo" },
			members: [],
			messages: [],
			tasks: {
				t1: {
					id: "t1",
					title: "派出去的人已经不在这个频道",
					owner: "gone",
					status: "open" as const,
					channelId: "group:solo",
					originSeq: 5,
					history: [{ seq: 999, what: "created" }],
				},
			},
		};
		const now = 1_700_000_000_000;
		const [row] = boardTasks(sparse, now);
		expect(row!.ownerLabel).toBe("gone");
		expect(row!.changedAt).toBe(now);
		expect(row!.note).toBeUndefined();
	});
});
