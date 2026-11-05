/**
 * 真 kill -9：答案已经提交、收尾任务还没跑，重启后频道里仍然有那句话（ADR-077）。
 *
 * 这是 Phase 5 的核心证据。宿主旧路径靠结算回调补发，进程一死回调就没了；现在
 * 收尾是 `afterRun` 创建的 durable task，重启后由底座重放。
 *
 * 另一个窗口：消息已经落盘、任务终态还没提交 —— 重放必须认出「同一句已经说过」，
 * 不能把结论发两遍。
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { ChannelDoc, type ChannelState } from "../../src/core/channel/types.ts";
import { sandboxPool, type Sandbox } from "./support.ts";

const here = dirname(fileURLToPath(import.meta.url));
const childScript = join(here, "..", "fixtures", "turn-report-child.ts");
const pool = sandboxPool();

afterEach(async () => {
	await pool.cleanup();
});

type Seeded = {
	readonly taskId: number;
	readonly conversationId: number;
	readonly channelId: string;
	readonly answer: string;
};

/** 起子进程，等它把 durable 状态写好，然后杀；返回同一个工作区（父进程重启它）。 */
async function seedThenKill(posted: boolean): Promise<{ box: Sandbox; seeded: Seeded }> {
	const box = await pool.make("crash-turn-report-");
	await box.seedTemplates();
	// 装配会按文件夹开会话；这个人的会话是子进程建好的，这里只需要一个身份目录。
	await mkdir(join(box.agentsRoot, "林越"), { recursive: true });
	await writeFile(
		join(box.agentsRoot, "林越", "identity.md"),
		"---\nname: 林越\ntitle: 测试\n---\n\n测试用。\n",
		"utf8",
	);

	const child = spawn(process.execPath, ["--experimental-strip-types", childScript], {
		env: {
			...process.env,
			CRASH_DB: box.layout.databasePath,
			...(posted ? { SEED_POSTED: "1" } : {}),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	let seeded: Seeded | undefined;
	let output = "";
	const ready = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`子进程没写好现场：\n${output}`)), 20_000);
		const onData = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			for (const line of output.split("\n")) {
				if (!line.startsWith("TURN_REPORT ")) continue;
				seeded = JSON.parse(line.slice("TURN_REPORT ".length)) as Seeded;
			}
			if (seeded !== undefined) {
				clearTimeout(timer);
				resolve();
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("exit", (code) => {
			if (seeded === undefined) reject(new Error(`子进程提前退出（${String(code)}）：\n${output}`));
		});
	});

	await ready;
	child.kill("SIGKILL");
	await new Promise<void>((resolve) => child.on("exit", () => resolve()));
	return { box, seeded: seeded as Seeded };
}

function answersIn(state: ChannelState, channelId: string, answer: string) {
	return (state.messages[channelId] ?? []).filter((item) => item.from === "林越" && item.text === answer);
}

describe("kill -9：答完写回频道（ADR-077）", () => {
	it("任务还在 pending → 重启后跑完，频道里多出一句", async () => {
		const { box, seeded } = await seedThenKill(false);
		const runtime = await box.open();
		await box.assemble(runtime);

		const settled = await runtime.harness.waitForTask(seeded.taskId as never, BACKGROUND_CONTEXT);
		expect(settled.state.status).toBe("terminal");
		expect(settled.state.outcome).toMatchObject({ status: "completed", result: { answer: expect.any(String) } });

		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		expect(answersIn(state, seeded.channelId, seeded.answer)).toHaveLength(1);
	}, 30_000);

	it("消息已经落盘、终态还没提交 → 重放不双发", async () => {
		const { box, seeded } = await seedThenKill(true);
		const runtime = await box.open();
		await box.assemble(runtime);

		await runtime.harness.waitForTask(seeded.taskId as never, BACKGROUND_CONTEXT);

		const state = (await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		expect(answersIn(state, seeded.channelId, seeded.answer)).toHaveLength(1);
	}, 30_000);
});
