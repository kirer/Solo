/**
 * 「改一条任务，界面上的顶栏数字和全局板会不会自己动」（2.9.21 补的一笔）。
 *
 * 这一笔替真机验：真机上要「改一条任务」得先有人跑起来，而冒烟那套是占位 provider，
 * 任务不会自己变 —— 于是这条链一直没人验到。它要验的其实不是模型，是**推送**：
 * 任务起落改的都是频道文档里的 `tasks`，名册一格不动，指纹只算名册的话一次推送都不
 * 触发，界面就冻在第一份快照上、非刷新不动。
 *
 * 所以这里不用手搓快照、也不假外壳：真装配（`assembleCore`）、真 `read`、真 hub、
 * 真提交总线，改任务走真写入层 `commitTaskNote`，读的是 hub 真写出去的那串 SSE 字节。
 */
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { createApp } from "../../src/app/index.ts";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { ChannelDoc, OWNER_SLUG, type ChannelState } from "../../src/core/channel/types.ts";
import { ensureChannel } from "../../src/core/channel/rules.ts";
import { commitTaskNote } from "../../src/core/channel/write.ts";
import { createStreamHub } from "../../src/interface/http/sse.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

/**
 * 用普通频道 id，不用 `team:*`：组织快照会按 `teams/` 目录滤掉「团队没了的」频道
 * （`withoutGoneTeams`），沙盒里没有团队目录，`team:alpha` 会被整条滤掉 ——
 * 那时任务还在 `tasks` 里，`channels` 里却没有它，全局板就什么都投影不出来。
 */
const TEAM = "alpha";
const ME = "沈舟";
/** 推送去抖 120ms，留两倍余量；忙时补推是 1s 一跳，这里不等它。 */
const SETTLE_MS = 320;

function fakeResponse() {
	const chunks: string[] = [];
	const handlers = new Map<string, () => void>();
	const response = {
		writeHead: () => response,
		write: (chunk: string) => {
			chunks.push(chunk);
			return true;
		},
		on: (event: string, run: () => void) => {
			handlers.set(event, run);
			return response;
		},
		end: () => undefined,
	};
	return {
		response: response as unknown as ServerResponse,
		chunks,
		close: () => handlers.get("close")?.(),
	};
}

/** 一帧里的 org：`chunks` 里除了 retry 帧，就是 `event: org\ndata: {...}`。 */
function lastOrg(chunks: readonly string[]): { tasks?: { status: string }[] } & Record<string, unknown> {
	const frames = chunks
		.join("")
		.split("\n\n")
		.filter((frame) => frame.startsWith("event: org\ndata: "));
	expect(frames.length).toBeGreaterThan(0);
	const last = frames.at(-1) as string;
	return JSON.parse(last.slice("event: org\ndata: ".length)) as { tasks?: { status: string }[] } & Record<string, unknown>;
}

/** 界面那颗数字的口径：只数活的（`open` / `doing` / `blocked`）。 */
function aliveCount(org: { tasks?: { status: string }[] }): number {
	return (org.tasks ?? []).filter((task) => ["open", "doing", "blocked"].includes(task.status)).length;
}

async function setup() {
	const box = await pool.make("core-task-push-");
	const opened = await box.open();
	await box.seedTemplates();
	const shell = await box.assemble(opened);
	await opened.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(doc, ensureChannel(doc, { id: TEAM, title: "alpha", members: [OWNER_SLUG, ME], wakeOnAll: [], at: 1 }));
	}, BACKGROUND_CONTEXT);

	const app = createApp(shell);
	const hub = createStreamHub(shell, app.snapshots, app.read);
	hub.start();
	const client = fakeResponse();
	hub.streamOrg(client.response);
	await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
	return { opened, shell, hub, client };
}

describe("任务变了，界面自己动（推送这一步）", () => {
	test("落一条任务、再改一次状态，org 各推一帧新快照，帧里的条数跟着动", async () => {
		const { shell, hub, client } = await setup();
		try {
			expect(aliveCount(lastOrg(client.chunks))).toBe(0);

			const created = await commitTaskNote(
				{ harness: shell.harness },
				{
					channelId: TEAM,
					at: 100,
					// 建一条**不给 id**（连空串都不行：空串也算「改 t 号叫这个的任务」，
					// 会撞成 `任务不存在：`）。号由写入层现算。
					plan: () => ({
						task: {
							id: "",
							title: "把全局板做出来",
							owner: ME,
							status: "open",
							channelId: TEAM,
							originSeq: 1,
							history: [],
						},
						what: "created",
						text: "把全局板做出来：建了一条",
					}) as never,
				},
				BACKGROUND_CONTEXT,
			);
			if (!created.ok) throw new Error(`种任务失败：${created.message}`);
			await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

			const afterCreate = lastOrg(client.chunks);
			expect(aliveCount(afterCreate)).toBe(1);
			expect(afterCreate.tasks?.[0]?.status).toBe("open");

			const moved = await commitTaskNote(
				{ harness: shell.harness },
				{
					channelId: TEAM,
					at: 200,
					id: "t1",
					expectHistoryLength: 1,
					plan: (current) => ({
						task: { ...(current as never as Record<string, unknown>), status: "doing" } as never,
						what: "status",
						text: "t1：doing",
					}),
				},
				BACKGROUND_CONTEXT,
			);
			if (!moved.ok) throw new Error(`改状态失败：${moved.message}`);
			await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

			const afterMove = lastOrg(client.chunks);
			expect(afterMove.tasks?.[0]?.status).toBe("doing");
			expect(aliveCount(afterMove)).toBe(1);
		} finally {
			client.close();
			hub.close();
		}
	});
});
