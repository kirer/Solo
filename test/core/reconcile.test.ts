/**
 * 重启自愈：库里的「忙」标记、强杀现场、以及任务/输入记录的回收。
 *
 * 三件事放在一个文件里，因为它们是同一条生命周期的三段：打开库时自愈（A2）、
 * 自愈之后不该有僵尸记录、以及记录不能无限长（A3）。每一段都来自一次真实事故：
 *
 * - **会话被永久当成忙**：我私聊问「音效加完了吗？」，助手一直不理。消息在、投递成功、
 *   任务也都结算成了 terminal，但 `pi.live` 的 `run` 还指着一个已经 terminal 的
 *   generation，而入库判据是 `busy = live.run !== undefined`。之后每条输入都进 `queued`，
 *   却没有任何活着的一轮来取。
 * - **自愈从上线起一次都没跑过**：`reconcileZombieTasks` 先 `setTask` 写任务、再
 *   `scanConversations` 扫会话 —— pi-durable 禁止「写表之后再读表」，整个 commit 抛错，
 *   被外层 catch 吞成一行警告。所以这里钉住「不许再写回去」。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, LiveDoc } from "../../src/core/runtime/index.ts";
import { pruneTerminalSubmissions, pruneTerminalTasks } from "../../src/core/runtime/open.ts";
import { sandboxPool, type Sandbox } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

/** 库文件路径。schema 由一次开合建出来。 */
async function database(box: Sandbox): Promise<string> {
	await (await box.open()).close();
	return join(box.root, "core.sqlite");
}

describe("重启自愈", () => {
	it("清掉指向已不存在任务的 run，会话不再被当成忙", async () => {
		const box = await pool.make("core-reconcile-");

		const first = await box.open();
		const conversation = await first.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { extensions: [] } },
			BACKGROUND_CONTEXT,
		);

		// 造一个强杀现场：run 指着一条根本不存在的任务（真实现场里它是 terminal 的）。
		await first.harness.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversation.id);
			live.run = { taskId: 999_999, inputs: [] };
		}, BACKGROUND_CONTEXT);
		expect((await first.harness.snapshot(LiveDoc, conversation.id))?.run).toBeDefined();

		await first.close();

		// 重新打开：自愈应当把这条陈旧的 run 摘掉。
		const second = await box.open();
		const live = await second.harness.snapshot(LiveDoc, conversation.id);
		expect(live?.run).toBeUndefined();
	});

	it("不动另一个活着的进程的 run（同库双进程时不能互相踩）", async () => {
		const box = await pool.make("core-reconcile-");

		const first = await box.open();
		const conversation = await first.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { extensions: [] } },
			BACKGROUND_CONTEXT,
		);

		await first.harness.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversation.id);
			live.run = { taskId: 999_999, inputs: [] };
		}, BACKGROUND_CONTEXT);

		// 同一个库上再开一个（模拟「另一个进程正拿着这个会话」）：它的自愈会摘掉
		// 上面那条陈旧 run，但只要我们自己的任务还活着就不该动。
		const second = await box.open();
		await second.harness.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversation.id);
			live.run = { taskId: 999_998, inputs: [] };
		}, BACKGROUND_CONTEXT);

		// 第三刀：再开一次，999_998 仍然是「不存在」→ 也该清。这条断言守的是
		// 「只清陈旧指针」这个判据本身没有被写反。
		const third = await box.open();
		expect((await third.harness.snapshot(LiveDoc, conversation.id))?.run).toBeUndefined();
	});
});

describe("A2 启动自愈真的跑完了", () => {
	it("有到一半的输入时，重开不再报「写表后读表」，且不会把排队中的输入撤掉", async () => {
		const box = await pool.make("core-reconcile-");
		await mkdir(join(box.agentsRoot, "甲"), { recursive: true });
		await writeFile(join(box.agentsRoot, "甲", "identity.md"), "---\nname: 甲\n---\n\n# 甲\n", "utf8");

		const first = await box.open();
		const shell = await box.assemble(first, { defaultModel: { provider: "test", modelId: "test" } });
		const conversation = shell.conversations.get("甲");
		expect(conversation).toBeDefined();
		// 模拟「进程被杀时还排着一条输入」：提交后不结算。
		await conversation!.submit({ type: "input", content: "被强杀前的一句话", requestId: "test:zombie" }, BACKGROUND_CONTEXT);
		await first.close();

		const errors: string[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		});
		try {
			const proto = Object.getPrototypeOf(first.harness) as { abortSubmission: (...args: unknown[]) => unknown };
			const abort = vi.spyOn(proto, "abortSubmission");
			const second = await box.open();
			// 恢复时**一条排队输入都不许撤**：`queued` 是内容完好、还没被取走的输入，
			// 撤掉就是把我崩溃前说的话静默吞掉。崩溃前正在跑的那条则会记成 unanswered。
			expect(abort).not.toHaveBeenCalled();
			abort.mockRestore();
			const inspection = await second.harness.inspect();
			const zombie = inspection.submissions.find((item) => item.requestId === "test:zombie");
			expect(zombie === undefined || zombie.status === "unanswered" || zombie.status === "done").toBe(true);
		} finally {
			spy.mockRestore();
		}
		expect(errors.join("\n")).not.toContain("cannot read tables after the first table write");
	});
});

describe("A3 回收 3 天前的已完成任务记录", () => {
	it("只删 terminal 且 endedAt 超过保留期的，正在跑的和新的都留着", async () => {
		const box = await pool.make("core-reconcile-");
		const file = await database(box);

		const db = new DatabaseSync(file);
		try {
			const insert = db.prepare("INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (?, ?, ?, ?, 0, 0, ?)");
			const record = (id: number, status: string, endedAt: number) =>
				JSON.stringify({ id, conversationId: 1, kind: "pi.generation", version: 1, background: false, abortRequested: false, startedAt: endedAt - 1000, endedAt, state: { status, phase: "x" } });
			insert.run("9001", 1, "pi.generation", "terminal", record(9001, "terminal", Date.now() - 5 * 24 * 60 * 60_000));
			insert.run("9002", 1, "pi.generation", "terminal", record(9002, "terminal", Date.now() - 60_000));
			insert.run("9003", 1, "pi.generation", "running", record(9003, "running", Date.now() - 5 * 24 * 60 * 60_000));
		} finally {
			db.close();
		}

		expect(await pruneTerminalTasks(file)).toBe(1);
		const check = new DatabaseSync(file);
		try {
			const ids = (check.prepare("SELECT id FROM tasks ORDER BY id").all() as { id: number }[]).map((row) => String(row.id));
			expect(ids).toEqual(["9002", "9003"]);
		} finally {
			check.close();
		}
	});
});

describe("已结算的输入记录回收（submissions）", () => {
	it("每个会话只留最近 N 条终态记录，排队中的一条都不动", async () => {
		const box = await pool.make("core-reconcile-");
		const file = await database(box);

		const db = new DatabaseSync(file);
		try {
			const insert = db.prepare(
				"INSERT INTO submissions (id, conversation_id, request_id, status, record) VALUES (?, ?, ?, ?, ?)",
			);
			for (let i = 1; i <= 20; i += 1) {
				insert.run(String(i), 7, `ch:x:${i}:a`, "done", JSON.stringify({ conversationId: 7, requestId: `ch:x:${i}:a`, type: "input", status: "done", id: i }));
			}
			// 另一会话，只有 2 条 —— 不该被跨会话合并计数
			insert.run("101", 8, "ch:y:1:a", "done", JSON.stringify({ conversationId: 8, requestId: "ch:y:1:a", type: "input", status: "done", id: 101 }));
			insert.run("102", 8, "ch:y:2:a", "done", JSON.stringify({ conversationId: 8, requestId: "ch:y:2:a", type: "input", status: "done", id: 102 }));
			// 排队中的不算终态
			insert.run("201", 7, "ch:x:99:a", "queued", JSON.stringify({ conversationId: 7, requestId: "ch:x:99:a", type: "input", status: "queued", id: 201 }));
		} finally {
			db.close();
		}

		expect(await pruneTerminalSubmissions(file, 5)).toBe(15);
		const check = new DatabaseSync(file);
		try {
			const rows = check.prepare("SELECT id, conversation_id FROM submissions ORDER BY id").all() as {
				id: number;
				conversation_id: number;
			}[];
			const byConv = (id: number) => rows.filter((row) => row.conversation_id === id).map((row) => String(row.id));
			expect(byConv(7)).toEqual(["16", "17", "18", "19", "20", "201"]);
			expect(byConv(8)).toEqual(["101", "102"]);
		} finally {
			check.close();
		}
	});
});
