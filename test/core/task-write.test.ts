/**
 * 任务写入的**原子性**与**并发凭据**（2.9.20 第二笔）。
 *
 * 这一笔守的不是「能不能存进去」，是两件更贵的错：
 *
 * 1. **状态改了、聊天流里没记录**。`history` 只有 `{seq, what}`，解释全在那条 note 里；
 *    两者分两次提交，中间一断就是「看板说改成 blocked 了，翻记录什么都没有」——
 *    人只会以为没动过。所以 note 与任务必须在同一次 commit 里，要么都成、要么都不成。
 * 2. **静默覆盖**。两个人同时改同一条，后一个拿旧快照直接写，前一笔就没了，而且不报警。
 *    这里拿「读到的 history 长度」当凭据：对不上就以盘上为准重算（最多三次），
 *    三次还撞就红 —— 宁可报错让人看，不要「反正重试会成功」。
 */
import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import type { CoreRuntime } from "../../src/core/runtime/open.ts";
import { ChannelDoc, spokenKind, tasksOf, type ChannelState, type Message, type Task } from "../../src/core/channel/types.ts";
import { ensureChannel, unreadCount } from "../../src/core/channel/rules.ts";
import { commitTaskNote, settleTaskWrite, TaskWriteConflict, type TaskNotePlan } from "../../src/core/channel/write.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

const TEAM = "team:alpha";
const ME = "沈舟";

type Box = { readonly runtime: CoreRuntime; readonly channelId: string };

async function setup(): Promise<Box> {
	const box = await pool.make("core-task-write-");
	const runtime = await box.open();
	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(doc, ensureChannel(doc, { id: TEAM, title: "alpha", members: ["owner", ME], wakeOnAll: [], at: 1 }));
	}, BACKGROUND_CONTEXT);
	return { runtime, channelId: TEAM };
}

/** 盘上现在的任务与消息，抄成朴素数据（代理出了事务一读就报 "settled overlay"）。 */
async function snapshot(box: Box): Promise<{ tasks: Record<string, Task>; messages: readonly Message[] }> {
	return box.runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		const tasks = tasksOf(doc, box.channelId);
		return {
			tasks: Object.fromEntries(
				Object.entries(tasks).map(([id, task]) => [
					id,
					{ ...task, history: task.history.map((entry) => ({ seq: entry.seq, what: entry.what })) },
				]),
			),
			messages: (doc.messages[box.channelId] ?? []).map((message) => ({ ...message })),
		};
	}, BACKGROUND_CONTEXT);
}

function newTaskPlan(box: Box): TaskNotePlan {
	return {
		task: {
			id: "",
			title: "把看板接上",
			owner: ME,
			status: "open",
			channelId: box.channelId,
			originSeq: 1,
			history: [],
		},
		what: "created",
		text: "t1：建了一条：把看板接上",
	};
}

/** 先落一条任务，返回它落完的样子。 */
async function seedTask(box: Box): Promise<Task> {
	const result = await commitTaskNote(
		{ harness: box.runtime.harness },
		{ channelId: box.channelId, at: 100, plan: () => newTaskPlan(box) },
		BACKGROUND_CONTEXT,
	);
	if (!result.ok) throw new Error(`种任务失败：${result.message}`);
	return result.task;
}

describe("落一条任务 = 一次 commit", () => {
	test("新建：id 现算 t1，history 那一格的 seq 就是那条 note 的 seq", async () => {
		const box = await setup();
		const task = await seedTask(box);
		expect(task.id).toBe("t1");
		expect(task.history).toHaveLength(1);
		expect(task.history[0].what).toBe("created");

		const seen = await snapshot(box);
		const notes = seen.messages.filter((message) => message.noteOf === "task");
		expect(notes).toHaveLength(1);
		expect(task.history[0].seq).toBe(notes[0].seq);
		expect(notes[0].kind).toBe("note");
		expect(notes[0].from).toBe("owner");
		expect(notes[0].text).toBe("t1：建了一条：把看板接上");
		expect(seen.tasks.t1.history).toEqual(task.history);
	});

	test("改一条：history 只追加，前面几格原样留着", async () => {
		const box = await setup();
		await seedTask(box);
		const second = await commitTaskNote(
			{ harness: box.runtime.harness },
			{
				channelId: box.channelId,
				at: 200,
				id: "t1",
				expectHistoryLength: 1,
				plan: (current) => ({
					task: { ...(current as Task), status: "blocked" },
					what: "status",
					text: "t1：blocked：等界面那边定形状",
				}),
			},
			BACKGROUND_CONTEXT,
		);
		expect(second.ok).toBe(true);
		const seen = await snapshot(box);
		expect(seen.tasks.t1.status).toBe("blocked");
		expect(seen.tasks.t1.history.map((entry) => entry.what)).toEqual(["created", "status"]);
		// 第二格指着第二条 note，正文就是「卡在哪」。
		const last = seen.tasks.t1.history[1];
		expect(seen.messages.find((message) => message.seq === last.seq)?.text).toBe("t1：blocked：等界面那边定形状");
	});
});

describe("原子性：要么都成，要么都不成", () => {
	test("算新的时候抛错：任务表和聊天流一个都没动", async () => {
		const box = await setup();
		await seedTask(box);
		const before = await snapshot(box);
		await expect(
			commitTaskNote(
				{ harness: box.runtime.harness },
				{
					channelId: box.channelId,
					at: 300,
					id: "t1",
					expectHistoryLength: 1,
					plan: () => {
						throw new Error("算的时候炸了");
					},
				},
				BACKGROUND_CONTEXT,
			),
		).rejects.toThrow("算的时候炸了");
		const after = await snapshot(box);
		expect(after.tasks).toEqual(before.tasks);
		expect(after.messages).toHaveLength(before.messages.length);
	});

	test("note 落不进去（写到一半抛）：任务状态也不许落", async () => {
		const box = await setup();
		await seedTask(box);
		const before = await snapshot(box);
		// 任务已经算好了，出错发生在写消息那一步之后 —— 事务整体回滚，两样都不许留。
		const task = (await snapshot(box)).tasks.t1;
		await expect(
			box.runtime.harness.commit(async (tx) => {
				const doc = (await tx.doc(ChannelDoc)) as ChannelState;
				doc.tasks[TEAM].t1 = { ...task, status: "done" };
				throw new Error("写完状态、写 note 的时候炸了");
			}, BACKGROUND_CONTEXT),
		).rejects.toThrow("写 note 的时候炸了");
		const after = await snapshot(box);
		expect(after.tasks).toEqual(before.tasks);
		expect(after.tasks.t1.status).toBe("open");
		expect(after.messages).toHaveLength(before.messages.length);
	});

	test("改一条只跑一次 commit：note 和状态在同一次里落", async () => {
		const box = await setup();
		await seedTask(box);
		let commits = 0;
		const counted = {
			commit: (fn: Parameters<CoreRuntime["harness"]["commit"]>[0], ctx: Parameters<CoreRuntime["harness"]["commit"]>[1]) => {
				commits += 1;
				return box.runtime.harness.commit(fn, ctx);
			},
		};
		const result = await commitTaskNote(
			// 只用到 `commit`：拆成两次提交（先落状态、再补 note）这个测试就会数出 2。
			{ harness: counted as unknown as CoreRuntime["harness"] },
			{
				channelId: box.channelId,
				at: 250,
				id: "t1",
				expectHistoryLength: 1,
				plan: (current) => ({ task: { ...(current as Task), status: "blocked" }, what: "status", text: "t1：blocked：等形状" }),
			},
			BACKGROUND_CONTEXT,
		);
		expect(result.ok).toBe(true);
		expect(commits).toBe(1);
	});

	test("拒绝（refuse）时什么都不写", async () => {
		const box = await setup();
		await seedTask(box);
		const before = await snapshot(box);
		const result = await commitTaskNote(
			{ harness: box.runtime.harness },
			{
				channelId: box.channelId,
				at: 300,
				id: "t1",
				expectHistoryLength: 1,
				plan: () => ({ refuse: "说不清卡在哪就还留在 doing" }),
			},
			BACKGROUND_CONTEXT,
		);
		expect(result).toEqual({ ok: false, reason: "refused", message: "说不清卡在哪就还留在 doing" });
		const after = await snapshot(box);
		expect(after.tasks).toEqual(before.tasks);
		expect(after.messages).toHaveLength(before.messages.length);
	});

	test("任务不存在、频道不存在：给一句人话，不落空任务", async () => {
		const box = await setup();
		const noTask = await commitTaskNote(
			{ harness: box.runtime.harness },
			{
				channelId: box.channelId,
				at: 300,
				id: "t9",
				expectHistoryLength: 0,
				plan: (current) => ({ task: current as Task, what: "status", text: "x" }),
			},
			BACKGROUND_CONTEXT,
		);
		expect(noTask).toEqual({ ok: false, reason: "missing", message: "任务不存在：t9" });
		const noChannel = await commitTaskNote(
			{ harness: box.runtime.harness },
			{ channelId: "team:没这个频道", at: 300, plan: () => ({ refuse: "不该走到这" }) },
			BACKGROUND_CONTEXT,
		);
		expect(noChannel.ok).toBe(false);
		const seen = await snapshot(box);
		expect(seen.messages).toHaveLength(0);
		expect(seen.tasks).toEqual({});
	});
});

describe("并发：对不上就重算，三次还撞就红", () => {
	test("两个人同时改同一条：两笔都在，不是一笔盖掉另一笔", async () => {
		const box = await setup();
		await seedTask(box);
		const change = (note: string) =>
			commitTaskNote(
				{ harness: box.runtime.harness },
				{
					channelId: box.channelId,
					at: 400,
					id: "t1",
					expectHistoryLength: 1,
					plan: (current) => ({ task: { ...(current as Task), status: "doing" }, what: "status", text: `t1：doing：${note}` }),
				},
				BACKGROUND_CONTEXT,
			);
		const both = await Promise.all([change("甲改的"), change("乙改的")]);
		expect(both.filter((item) => item.ok)).toHaveLength(2);
		const seen = await snapshot(box);
		expect(seen.tasks.t1.history).toHaveLength(3);
		expect(new Set(seen.tasks.t1.history.map((entry) => entry.seq)).size).toBe(3);
		const texts = seen.messages.filter((message) => message.noteOf === "task").map((message) => message.text);
		expect(texts).toEqual(expect.arrayContaining(["t1：doing：甲改的", "t1：doing：乙改的"]));
	});

	test("重算时看到的是盘上的新状态，不是调用方的旧快照", async () => {
		const box = await setup();
		await seedTask(box);
		// 别人先改了一笔：盘上变成 2 格，调用方还拿着 1。
		await commitTaskNote(
			{ harness: box.runtime.harness },
			{
				channelId: box.channelId,
				at: 200,
				id: "t1",
				expectHistoryLength: 1,
				plan: (current) => ({ task: { ...(current as Task), status: "doing" }, what: "status", text: "t1：doing：先动一手" }),
			},
			BACKGROUND_CONTEXT,
		);
		const seen: { attempt: number; history: number; status: string }[] = [];
		const result = await commitTaskNote(
			{ harness: box.runtime.harness },
			{
				channelId: box.channelId,
				at: 300,
				id: "t1",
				expectHistoryLength: 1,
				plan: (current, attempt) => {
					seen.push({ attempt, history: current?.history.length ?? -1, status: current?.status ?? "?" });
					return { task: { ...(current as Task), status: "blocked" }, what: "status", text: "t1：blocked：等形状" };
				},
			},
			BACKGROUND_CONTEXT,
		);
		expect(result.ok).toBe(true);
		// 第一次没算（对不上），第二次才算计，而且看到的是 2 格 + doing。
		expect(seen).toEqual([{ attempt: 2, history: 2, status: "doing" }]);
		const after = await snapshot(box);
		expect(after.tasks.t1.history).toHaveLength(3);
		expect(after.tasks.t1.status).toBe("blocked");
	});

	test("盘上一直变：一共只试四次，第四次报 TaskWriteConflict", async () => {
		const attempts: { attempt: number; expected: number | undefined }[] = [];
		await expect(
			settleTaskWrite<number>(
				async (attempt, expected) => {
					attempts.push({ attempt, expected });
					// 每次都说「刚被别人改过」，而且盘上又多了一格。
					return { kind: "conflict", onDisk: attempt };
				},
				1,
			),
		).rejects.toBeInstanceOf(TaskWriteConflict);
		// 初读一次 + 重读三次 = 4，**不许再多**；第一次用调用方给的凭据，之后以盘上为准。
		expect(attempts).toEqual([
			{ attempt: 1, expected: 1 },
			{ attempt: 2, expected: 1 },
			{ attempt: 3, expected: 2 },
			{ attempt: 4, expected: 3 },
		]);
	});

	test("撞到第三次之后对上了：按盘上的新长度算，结果照给", async () => {
		const seen: (number | undefined)[] = [];
		const value = await settleTaskWrite<string>(async (attempt, expected) => {
			seen.push(expected);
			if (attempt < 3) return { kind: "conflict", onDisk: attempt };
			return { kind: "done", result: "写进去了" };
		}, 0);
		expect(value).toBe("写进去了");
		// 第一次用调用方的 0，撞了以后换成盘上的 1，再撞换成 2 —— 第三次对上了就写。
		expect(seen).toEqual([0, 1, 2]);
	});
});

describe("写任务不唤醒人", () => {
	test("落完 note：不算发言、未读不涨", async () => {
		const box = await setup();
		await seedTask(box);
		const before = await box.runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			return unreadCount(doc, box.channelId, ME);
		}, BACKGROUND_CONTEXT);
		await commitTaskNote(
			{ harness: box.runtime.harness },
			{
				channelId: box.channelId,
				at: 500,
				id: "t1",
				expectHistoryLength: 1,
				plan: (current) => ({ task: { ...(current as Task), status: "blocked" }, what: "status", text: "t1：blocked：等形状" }),
			},
			BACKGROUND_CONTEXT,
		);
		const after = await box.runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			const notes = (doc.messages[box.channelId] ?? []).filter((message) => message.noteOf === "task");
			return {
				unread: unreadCount(doc, box.channelId, ME),
				spoken: notes.map((message) => spokenKind(message.kind)),
			};
		}, BACKGROUND_CONTEXT);
		expect(after.unread).toBe(before);
		expect(after.spoken.some(Boolean)).toBe(false);
	});
});
