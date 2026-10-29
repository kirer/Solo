/**
 * 启动自愈（A2）与任务记录回收（A3）。
 *
 * A2 的背景值得写下来：`reconcileZombieTasks` 里先 `setTask` 写任务、再 `scanConversations`
 * 扫会话 —— pi-durable 明确禁止「写表之后再读表」，于是整个 commit 抛错、被外层 catch 吞成
 * 一行警告。也就是说**这套自愈从上线起一次都没真正跑过**。这个测试守的就是「不许再写回去」。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { createRegistry, setupModels, BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { openCore, pruneTerminalSubmissions, pruneTerminalTasks, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { assembleCore } from "../../src/core/shell/assemble.ts";

const roots: string[] = [];
const runtimes: CoreRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function freshWs(): Promise<string> {
	const ws = await mkdtemp(join(tmpdir(), "core-reconcile-"));
	roots.push(ws);
	return ws;
}

describe("A2 启动自愈真的跑完了", () => {
	it("有排队中的输入时，重开不再报「写表后读表」，且那条输入被结算掉", async () => {
		const ws = await freshWs();
		await mkdir(join(ws, "agents", "甲"), { recursive: true });
		await writeFile(join(ws, "agents", "甲", "identity.md"), "---\nname: 甲\n---\n\n# 甲\n", "utf8");
		const { models } = setupModels(process.env, { workspace: ws });
		const first = await openCore({ databasePath: join(ws, "core.sqlite"), models, registry: createRegistry() });
		runtimes.push(first);
		const shell = await assembleCore(first.harness, first.registry, {
			agentsRoot: join(ws, "agents"),
			projectsRoot: join(ws, "projects"),
			defaultModel: { provider: "test", modelId: "test" },
		});
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
			const second = await openCore({ databasePath: join(ws, "core.sqlite"), models, registry: createRegistry() });
			runtimes.push(second);
			const inspection = await second.harness.inspect();
			const zombie = inspection.submissions.find((item) => item.requestId === "test:zombie");
			// 要么被撤掉、要么被结算成 unanswered —— 不能还挂在 queued/placed 上。
			expect(zombie?.status === "queued" || zombie?.status === "placed").toBe(false);
		} finally {
			spy.mockRestore();
		}
		expect(errors.join("\n")).not.toContain("cannot read tables after the first table write");
	});
});

describe("A3 回收 3 天前的已完成任务记录", () => {
	it("只删 terminal 且 endedAt 超过保留期的，正在跑的和新的都留着", async () => {
		const ws = await freshWs();
		const { models } = setupModels(process.env, { workspace: ws });
		// 先开一次把 schema 建出来
		const first = await openCore({ databasePath: join(ws, "core.sqlite"), models, registry: createRegistry() });
		await first.close();

		const db = new DatabaseSync(join(ws, "core.sqlite"));
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

		expect(await pruneTerminalTasks(join(ws, "core.sqlite"))).toBe(1);
		const check = new DatabaseSync(join(ws, "core.sqlite"));
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
		const ws = await freshWs();
		const { models } = setupModels(process.env, { workspace: ws });
		const first = await openCore({ databasePath: join(ws, "core.sqlite"), models, registry: createRegistry() });
		await first.close();

		const db = new DatabaseSync(join(ws, "core.sqlite"));
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

		expect(await pruneTerminalSubmissions(join(ws, "core.sqlite"), 5)).toBe(15);
		const check = new DatabaseSync(join(ws, "core.sqlite"));
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
