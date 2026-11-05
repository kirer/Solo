/**
 * 重启把一轮掐断之后：底座接着做，频道里留一句痕（ADR-044 / ADR-074）。
 *
 * 1.5.0 的调度器在 open 时会把上次 `running` 的任务改回 `pending` 并计一次 restart，
 * 重放时按 checkpoint 继续。所以 `openCore` **只报现场、不结算任务**；装配层留痕后
 * 调 `harness.resume()` 让底座把这一轮跑完。
 *
 * 另一半是「排队输入没人取」：崩溃恰好发生在上一轮结算之后、下一轮开始之前时，
 * `queued` 输入留在 inbox 里，没有任何活任务来取。`openCore` 把它报成 `backlog`，
 * 装配层发一条 `continue` 接上（`continue` 会先把 inbox 里的排队项放进这一轮）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, LiveDoc } from "../../src/core/runtime/index.ts";
import { ChannelDoc, type ChannelState } from "../../src/core/channel/types.ts";
import { writeTeam } from "../../src/core/team/doc.ts";
import { sandboxPool, type Sandbox } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

async function person(root: string, slug: string, header: string): Promise<void> {
	await mkdir(join(root, slug), { recursive: true });
	await writeFile(join(root, slug, "identity.md"), `---\nname: ${slug}\n${header}---\n\n做事的。\n`, "utf8");
}

async function setup() {
	const box = await pool.make("resume-");
	await person(box.agentsRoot, "程一", "title: 开发\nmanager: owner\nteam: alpha\n");
	await writeTeam(box.teamsRoot, { slug: "alpha", name: "Alpha", lead: "程一", body: "目标：把东西做出来。" });
	const runtime = await box.open();
	const shell = await box.assemble(runtime);
	return { box, runtime, shell };
}

/**
 * 造一条「上次进程停在 generation 里」的任务记录。
 *
 * 真正的强杀现场是：任务 `running`，open 时被底座改成 `pending` 并 `restarts + 1`。
 * 这里直接把改完之后的样子写进库（`pending` + `restarts: 1`），不用真的杀进程。
 */
async function seedCutOffGeneration(box: Sandbox, conversationId: number): Promise<void> {
	const db = new DatabaseSync(box.layout.databasePath);
	try {
		const record = {
			id: 9001,
			conversationId,
			kind: "pi.generation",
			version: 2,
			input: {},
			background: false,
			abortRequested: false,
			startedAt: Date.now() - 5_000,
			restarts: 1,
			state: { status: "pending", checkpoint: { phase: "request", attempt: 0 } },
		};
		db.prepare(
			"INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (?, ?, ?, ?, 0, 0, ?)",
		).run("9001", conversationId, "pi.generation", "pending", JSON.stringify(record));
	} finally {
		db.close();
	}
}

describe("重启现场：谁的这一轮断了", () => {
	it("被切断的 generation 会被报成 interrupted（任务原样留着，等底座重放）", async () => {
		const { box, runtime, shell } = await setup();
		const conversation = shell.conversations.get("程一");
		expect(conversation).toBeDefined();
		await runtime.close();
		await seedCutOffGeneration(box, Number(conversation?.id));

		const reopened = await box.open();
		expect(reopened.interrupted).toContain(Number(conversation?.id));
		// 不许再替底座杀任务：它还要按 checkpoint 重放。
		const inspection = await reopened.harness.inspect();
		const task = inspection.tasks.find((item) => String(item.record.id) === "9001");
		expect(task?.record.state.status).toBe("pending");
	});

	it("没有被打断的库：一个人都不报（不会每次重启都留痕）", async () => {
		const { box, runtime } = await setup();
		await runtime.close();
		expect((await box.open()).interrupted).toEqual([]);
	});

	it("run 指向不存在的任务：清掉，并把会话报成 backlog 而不是 interrupted", async () => {
		const { box, runtime, shell } = await setup();
		const conversation = shell.conversations.get("程一");
		await runtime.harness.commit(async (tx) => {
			const doc = await tx.doc(LiveDoc, conversation?.id as never);
			(doc as unknown as { run: unknown }).run = { taskId: 1, inputs: [] };
		}, BACKGROUND_CONTEXT);
		await runtime.close();

		const reopened = await box.open();
		expect(reopened.interrupted).toEqual([]);
		const live = await reopened.harness.snapshot(LiveDoc, conversation?.id as never, BACKGROUND_CONTEXT);
		expect(live?.run).toBeUndefined();
	});
});

describe("装配层：留痕但不叫醒", () => {
	it("在当时的频道里留一句痕；不再塞一条输入进正在重放的那一轮", async () => {
		const { box, runtime, shell } = await setup();
		const conversation = shell.conversations.get("程一");
		// 先让「他」被叫过一次：唤醒记录是重启后判断「当时在哪儿干活」的唯一线索。
		await shell.postAs({ channelId: "team:alpha", from: "owner", text: "@程一 把首版做出来。" }, BACKGROUND_CONTEXT);

		// 先等这一轮真的以「没答上来」收场（没有模型），再数；否则第二次装配会把它算成新增。
		await vi.waitFor(async () => {
			const state = (await shell.channels(BACKGROUND_CONTEXT)) as ChannelState;
			expect((state.messages["team:alpha"] ?? []).some((item) => item.text.includes("没答上来"))).toBe(true);
		});
		const before = (await shell.channels(BACKGROUND_CONTEXT)).messages["team:alpha"] ?? [];
		const unansweredBefore = before.filter((item) => item.text.includes("没答上来")).length;

		const again = await box.assemble(runtime, { interrupted: [Number(conversation?.id)] });
		const state = (await again.channels(BACKGROUND_CONTEXT)) as ChannelState;
		const notes = (state.messages["team:alpha"] ?? []).filter((item) => item.text.includes("被打断了"));
		expect(notes).toHaveLength(1);
		expect(notes[0]?.text).toContain("程一");
		expect(notes[0]?.kind).toBe("note");
		// 没有再叫醒他：没有模型时，被叫醒的一轮会立刻以「没答上来」收场。
		const unansweredAfter = (state.messages["team:alpha"] ?? []).filter((item) =>
			item.text.includes("没答上来"),
		).length;
		expect(unansweredAfter).toBe(unansweredBefore);
	});
});

describe("装配层：接上没人取的排队输入", () => {
	it("`continue` 会把 queued 输入带进新的一轮（没有模型时以 no_model 收场）", async () => {
		const { box, runtime, shell } = await setup();
		const conversation = shell.conversations.get("程一");
		const conversationId = Number(conversation?.id);
		await runtime.close();

		const db = new DatabaseSync(box.layout.databasePath);
		try {
			db.prepare(
				"INSERT INTO submissions (id, conversation_id, request_id, status, record) VALUES (?, ?, ?, ?, ?)",
			).run(
				"7001",
				conversationId,
				"test:queued",
				"queued",
				JSON.stringify({
					id: 7001,
					conversationId,
					requestId: "test:queued",
					type: "input",
					status: "queued",
					content: "崩溃前排在后面的一句",
				}),
			);
		} finally {
			db.close();
		}

		const reopened = await box.open();
		expect(reopened.backlog).toContain(conversationId);

		const proto = Object.getPrototypeOf(conversation) as {
			submit: (draft: unknown, ctx: unknown) => Promise<unknown>;
		};
		const submit = vi.spyOn(proto, "submit");
		await box.assemble(reopened, { backlog: reopened.backlog });

		// 装配层确实发了 `continue`（底座会先把 inbox 里的排队项放进这一轮）。
		expect(submit).toHaveBeenCalledWith(expect.objectContaining({ type: "continue" }), expect.anything());
		submit.mockRestore();
	});
});
