/**
 * 任务实体的形状（2.9.20 第一笔）。
 *
 * 这一笔只加「存」：`ChannelState.tasks` 一个可选键、`Task` 的形状、读侧入口。
 * 钉死两条，因为它们的错法都是静默的：
 *
 * 1. **读不补键**。老机器的文档里没有 `tasks`，读侧一律走 `tasksOf()`。谁哪天图省事
 *    在读数的地方写 `state.tasks ??= {}`，就等于「读一条消息」顺手改了文档 ——
 *    下一次提交会写一份空表上盘，而没有任何测试会红。这里拿真库比 revision 条数。
 * 2. **id 不填空号**。任务只 `dropped`、不删除，所以「最大 +1」永远不撞号；反过来
 *    一旦有人改成填补缺号，一条旧消息里的 `t3` 就会指向另一件活。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import {
	ChannelDoc,
	emptyChannelState,
	nextTaskIdOf,
	tasksOf,
	type ChannelState,
	type Task,
} from "../../src/core/channel/types.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

const TEAM = "team:alpha";

function task(id: string, overrides: Partial<Task> = {}): Task {
	return {
		id,
		title: `${id} 的那件活`,
		owner: "a",
		status: "open",
		channelId: TEAM,
		originSeq: 1,
		history: [{ seq: 1, what: "created" }],
		...overrides,
	};
}

/** 老文档：这四个键，**没有 `tasks`**。 */
function legacyState(): ChannelState {
	return { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
}

/** `core.channels` 在盘上有几条 revision（读、写都数得到，但不读缓存）。 */
function revisions(file: string): number {
	const db = new DatabaseSync(file);
	const row = db
		.prepare(
			`select count(*) as n from document_revisions r join documents d on d.id = r.document_id
			 where json_extract(d.record, '$.kind') = ?`,
		)
		.get("core.channels") as { n: number } | undefined;
	db.close();
	return row?.n ?? 0;
}

describe("形状", () => {
	test("空状态带一张空任务表，且每次都是新对象", () => {
		const a = emptyChannelState();
		const b = emptyChannelState();
		expect(a.tasks).toEqual({});
		expect(a.tasks).not.toBe(b.tasks);
	});

	test("`tasksOf` 认老文档：给空表，且不给 state 补键", () => {
		const state = legacyState();
		expect(Object.hasOwn(state, "tasks")).toBe(false);
		expect(tasksOf(state, TEAM)).toEqual({});
		// 读一次不改文档：补了键，下一次提交就会把这张空表写上去。
		expect(Object.hasOwn(state, "tasks")).toBe(false);
	});

	test("`tasksOf` 有就照给，不复制", () => {
		const table = { t1: task("t1") };
		const state: ChannelState = { ...legacyState(), tasks: { [TEAM]: table } };
		expect(tasksOf(state, TEAM)).toBe(table);
		// 频道 id 不认识 / 那个频道还没建过任务，都当空表。
		expect(tasksOf(state, "team:beta")).toEqual({});
	});
});

describe("任务 id", () => {
	test("空表从 t1 起", () => {
		expect(nextTaskIdOf({})).toBe("t1");
	});

	test("取最大编号 +1，不填补缺号", () => {
		expect(nextTaskIdOf({ t1: task("t1"), t3: task("t3") })).toBe("t4");
		expect(nextTaskIdOf({ t2: task("t2"), t9: task("t9") })).toBe("t10");
	});

	test("认不出的 id 跳过，不参与编号", () => {
		expect(nextTaskIdOf({ "task9": task("task9"), "": task(""), t2: task("t2") })).toBe("t3");
	});
});

describe("老文档：读出来是空，盘上不长东西", () => {
	test("落一份没有 `tasks` 的文档，重启后读一次：还是空，revision 一条没多", async () => {
		const box = await pool.make("core-task-store-");
		const file = box.layout.databasePath;
		const runtime = await box.open();
		await runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			Object.assign(doc, legacyState());
			// 真老文档里根本没有这个键 —— 不是「空表」，是「没这个字段」。
			delete doc.tasks;
		}, BACKGROUND_CONTEXT);
		await runtime.close();
		const before = revisions(file);
		expect(before).toBeGreaterThan(0);

		// 重启，只读：这是升级后第一次打开界面会走的那条路。
		const again = await box.open();
		const seen = await again.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			// 先读表、再看键 —— 顺序反了这条就抓不到「读的时候把键补上」：
			// 先算 hasTasks 的话，任务表里补键这件事发生在它之后，永远看着是干净的。
			// 事务一关就读不了代理，所以只把朴素数据带出来。
			const ids = Object.keys(tasksOf(doc, TEAM));
			return { ids, hasTasks: Object.hasOwn(doc, "tasks") };
		}, BACKGROUND_CONTEXT);
		expect(seen.hasTasks).toBe(false);
		expect(seen.ids).toEqual([]);
		// 读一次不能落盘：多一条 revision 就是「打开界面改了文档」。
		expect(revisions(file)).toBe(before);
		await again.close();
	});
});
