/**
 * 异步 `run`：起一条后台命令，跑完把结果发回频道并叫醒起跑的人。
 *
 * 钉四件会悄悄坏掉的事：
 * 1. 跑完真的回调了（不是「返回 PID 就完了」）—— 那是旧行为，也是这次要修的东西。
 * 2. 到点真的杀掉（否则一条命令能挂一整天）。
 * 3. 记录文件用完就删；重启时能认出上一轮遗留的活并杀掉。
 * 4. `note` 默认不叫醒人，但显式 `wakeTo` 时叫醒 —— 结果只是躺在频道里没人看等于没回来。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, type Conversation } from "../../src/core/runtime/index.ts";
import { sweepRunJobs, startRunJob, type RunOutcome } from "../../src/core/channel/jobs.ts";
import { createChannelFlow } from "../../src/core/channel/post.ts";
import { appendMessage, ensureChannel } from "../../src/core/channel/rules.ts";
import { ChannelDoc, OWNER, type ChannelState } from "../../src/core/channel/types.ts";
import { SEED_TEXT } from "./catalog.ts";
import { createCoreTools } from "../../src/core/channel/tools/index.ts";
import { wireChannel } from "../../src/core/channel/wiring.ts";
import { emptyDirectory } from "../../src/core/channel/roster.ts";
import { dmId } from "../../src/core/channel/types.ts";
import { sandboxPool } from "./support.ts";

let dir = "";

/** 能活够久的命令：Windows 没有 `sleep`，用 ping 凑时间。 */
const LONG_COMMAND = process.platform === "win32" ? "ping -n 60 127.0.0.1" : "sleep 30";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "core-run-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** 等一个结果，超时就失败（后台回调是异步的，测试不能靠 sleep 猜）。 */
function outcomeOf(start: (onDone: (outcome: RunOutcome) => Promise<void>) => Promise<unknown>): Promise<RunOutcome> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("等不到后台命令的结果")), 15_000);
		void start(async (outcome) => {
			clearTimeout(timer);
			resolve(outcome);
		}).catch(reject);
	});
}

describe("后台命令", () => {
	it("跑完把退出码和输出交回来，记录用完就删", async () => {
		const outcome = await outcomeOf((onDone) =>
			startRunJob({ dir, slug: "林越", channelId: "c1", command: "echo hello", cwd: dir, onDone }),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.timedOut).toBe(false);
		// 不用中文：Windows 的 cmd 输出编码会把它变成乱码。
		expect(outcome.log).toContain("hello");
		// 记录只在跑的时候存在：留着它，下次启动会把它当成孤儿再报一遍。
		expect((await readdir(dir)).filter((name) => name.endsWith(".json"))).toEqual([]);
	});

	it("到点就杀掉，并说是超时", async () => {
		const outcome = await outcomeOf((onDone) =>
			startRunJob({ dir, slug: "林越", channelId: "c1", command: LONG_COMMAND, cwd: dir, limitMs: 150, onDone }),
		);
		expect(outcome.timedOut).toBe(true);
		if (process.platform === "win32") {
			// Windows 没有信号：taskkill 之后 close 报的是退出码，不是 null。
			expect(outcome.code).not.toBe(0);
		} else {
			expect(outcome.code).toBeNull();
		}
	});

	it("起不来也算跑完（回一句原因，不是静默消失）", async () => {
		const outcome = await outcomeOf((onDone) =>
			startRunJob({ dir, slug: "林越", channelId: "c1", command: "echo x", cwd: join(dir, "没有这个目录"), onDone }),
		);
		expect(outcome.code).not.toBe(0);
		// 原因写进日志里：静默消失的「起不来」没法排查。
		expect(await readFile(outcome.logPath, "utf8")).toContain("起不来");
	});

	it("重启时清掉上一轮遗留的活：活着的杀掉，记录删掉", async () => {
		await mkdir(dir, { recursive: true });
		// 一个真的活着、且活得够久的进程，冒充「上一轮起的命令」。
		const alive = await startRunJob({
			dir,
			slug: "林越",
			channelId: "c1",
			command: LONG_COMMAND,
			cwd: dir,
			onDone: async () => undefined,
		});
		const record = JSON.parse(await readFile(join(dir, `${alive.id}.json`), "utf8")) as { pid: number };
		// 再补一条早就死了的（pid 用一个不可能存在的号）。
		await writeFile(
			join(dir, "1000-dead.json"),
			JSON.stringify({ id: "1000-dead", slug: "苏禾", channelId: "c2", command: "make", pid: 999_999, startedAt: 1 }),
			"utf8",
		);

		const stale = await sweepRunJobs(dir);
		expect(stale).toHaveLength(2);
		expect(stale.find((item) => item.job.id === "1000-dead")?.killed).toBe(false);
		const live = stale.find((item) => item.job.id === alive.id);
		expect(live?.killed).toBe(true);
		expect(record.pid).toBeGreaterThan(0);
		// 杀掉之后进程真的不在了。
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(() => process.kill(record.pid, 0)).toThrow();
		expect((await readdir(dir)).filter((name) => name.endsWith(".json"))).toEqual([]);
	});
});

const pool = sandboxPool();

afterEach(() => pool.cleanup());

describe("note 的唤醒", () => {
	it("默认不叫醒任何人", async () => {
		const runtime = await (await pool.make("core-run-post-")).open();
		await runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			Object.assign(doc, ensureChannel(doc, { id: "c1", title: "群", members: [OWNER, "a"], wakeOnAll: ["a"], at: 1 }));
		}, BACKGROUND_CONTEXT);
		const submitted: string[] = [];
		const state = async () => (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		const flow = createChannelFlow({
			harness: runtime.harness,
			conversationOf: async () =>
				({ id: "1", submit: async (input: { content: string }) => void submitted.push(input.content) }) as unknown as Conversation,
		});
		const result = await flow.publish(
			await state(),
			{ channelId: "c1", from: OWNER, text: "@a 留痕", at: 2, kind: "note" },
			BACKGROUND_CONTEXT,
		);
		expect(result.delivery.delivered).toEqual([]);
		expect(submitted).toEqual([]);

		// 同一句话，显式给了收件人：他就该被叫醒。
		const woken = await flow.publish(
			await state(),
			{ channelId: "c1", from: OWNER, text: "后台命令跑完了", at: 3, kind: "note", wakeTo: ["a"] },
			BACKGROUND_CONTEXT,
		);
		expect(woken.delivery.delivered).toEqual(["a"]);
		expect(submitted).toHaveLength(1);
	});
});

describe("run 工具的 background 分支", () => {
	it("立刻返回，跑完把结果作为 note 发回起跑的频道", async () => {
		const box = await pool.make("core-run-tool-");
		const me = "沈舟";
		const conversation = 7;
		await mkdir(join(box.agentsRoot, me), { recursive: true });
		await writeFile(join(box.agentsRoot, me, "identity.md"), "---\nname: 沈舟\n---\n\n干活。\n", "utf8");
		const runtime = await box.open();
		const channelId = dmId(OWNER, me);
		await runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			Object.assign(doc, ensureChannel(doc, { id: channelId, title: "沈舟", members: [OWNER, me], at: 1 }));
			const first = appendMessage(doc, channelId, { from: OWNER, text: "跑一下测试", at: 2 });
			doc.messages[channelId] = [first.message];
			doc.nextSeq[channelId] = first.message.seq + 1;
		}, BACKGROUND_CONTEXT);

		const tools = createCoreTools({
			harness: runtime.harness,
			layout: box.layout,
			text: SEED_TEXT,
			directory: async () => ({
				...emptyDirectory(),
				slugToConversation: { [me]: conversation },
				conversationToSlug: { [String(conversation)]: me },
				wake: {
					[String(conversation)]: {
						reply: { channelId, seq: 1, from: OWNER, at: 2 },
						task: { channelId, seq: 1, from: OWNER, at: 2 },
					},
				},
			}),
			saveDirectory: async () => undefined,
			wiring: wireChannel({ harness: runtime.harness, layout: box.layout }),
		} as never);
		const run = tools.find((item) => item.name === "run");
		expect(run).toBeDefined();
		const execute = async (args: Record<string, unknown>): Promise<string> => {
			const result = await run?.execute(args as never, { conversationId: conversation } as never, BACKGROUND_CONTEXT);
			const output = result?.output as readonly { text?: string }[] | undefined;
			return output?.[0]?.text ?? "";
		};

		// 带颜色的一行：命令输出里的 ANSI 转义不能进频道正文（界面和提示词都会被它污染）。
		const reply = await execute({ command: "printf '\\033[90m跑完了\\033[0m'", background: true });
		expect(reply).toContain("后台运行");

		// 跑完是异步的：等频道里出现那条结果，而不是 sleep 猜。
		const deadline = Date.now() + 10_000;
		let landed: { kind?: string; noteOf?: string; from: string; text: string; mentions: readonly string[] } | undefined;
		while (Date.now() < deadline && landed === undefined) {
			const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
			landed = (state.messages[channelId] ?? []).find((message) => message.text.includes("跑完了") && message.kind === "note");
			if (landed === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(landed, "后台命令的结果没有回到频道里").toBeDefined();
		expect(landed?.from).toBe(OWNER);
		expect(landed?.text).toContain("跑完了");
		expect(landed?.text).toContain("退出码 0");
		// 洗掉了控制序列：正文里一个 `\u001b` 都不该有。
		expect(landed?.text).not.toContain("\u001b");
		// 带上种类：界面据此把它收成一行（点开才看全文）。
		expect(landed?.noteOf).toBe("run");
		// 起跑的人被记进 mentions：不然这条结果只是躺在频道里。
		expect(landed?.mentions).toContain(me);
	});
});
