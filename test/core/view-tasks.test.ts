/**
 * 任务实体有没有通到界面上（2.9.20 补的一笔）。
 *
 * 这一笔守的是「存进去了、界面永远读不到」这类静默空洞：任务真写进了 `ChannelDoc`，
 * 但 `channelDetail()` 不投影 `tasks`，界面读 `detail.tasks` 永远是 `undefined` ——
 * 功能等于没发，而且**所有测试都绿**。
 *
 * 所以这里不从手写的 state 起步：走 `commitTaskNote()` 真落一条，再从
 * `channelDetail()` 的返回值里读回来。中间少一环就红。
 */
import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import type { CoreRuntime } from "../../src/core/runtime/open.ts";
import { ChannelDoc, type ChannelState } from "../../src/core/channel/types.ts";
import { ensureChannel } from "../../src/core/channel/rules.ts";
import { commitTaskNote, type TaskNotePlan } from "../../src/core/channel/write.ts";
import { createRead } from "../../src/app/read.ts";
import { channelDetail, workspaceTasks } from "../../src/app/project.ts";
import type { DirectoryState } from "../../src/core/channel/roster.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

const TEAM = "team:alpha";
const OTHER_TEAM = "team:beta";
const ME = "沈舟";

const directory: DirectoryState = {
	slugToConversation: { owner: 0, [ME]: 1 },
	conversationToSlug: { "0": "owner", "1": ME },
	wake: {},
	labels: { [ME]: "沈舟" },
};

type Box = { readonly runtime: CoreRuntime; readonly channelId: string };

async function setup(): Promise<Box> {
	const box = await pool.make("core-view-tasks-");
	const runtime = await box.open();
	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(
			doc,
			ensureChannel(doc, { id: TEAM, title: "alpha", members: ["owner", ME], wakeOnAll: [], at: 1 }),
		);
		Object.assign(
			doc,
			ensureChannel(doc, { id: OTHER_TEAM, title: "beta", members: ["owner", ME], wakeOnAll: [], at: 2 }),
		);
	}, BACKGROUND_CONTEXT);
	return { runtime, channelId: TEAM };
}

/** 落一条真任务（走写入层，不手搓 state）。 */
async function addTask(
	box: Box,
	fields: { title: string; accept?: string; goal?: string; channelId?: string },
): Promise<void> {
	const channelId = fields.channelId ?? box.channelId;
	const plan = (): TaskNotePlan => ({
		task: {
			id: "",
			title: fields.title,
			owner: ME,
			status: "open",
			channelId,
			originSeq: 1,
			history: [],
			...(fields.goal === undefined ? {} : { goal: fields.goal }),
			...(fields.accept === undefined ? {} : { accept: fields.accept }),
		},
		what: "created",
		text: `${fields.title}：建了一条`,
	});
	const result = await commitTaskNote({ harness: box.runtime.harness }, { channelId, at: 100, plan }, BACKGROUND_CONTEXT);
	if (!result.ok) throw new Error(`种任务失败：${result.message}`);
}

/** 盘上现在的 state，交给投影。 */
async function detailOf(box: Box, channelId = box.channelId) {
	const state = (await box.runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
	const channel = state.channels[channelId];
	if (channel === undefined) throw new Error(`没有频道 ${channelId}`);
	return { state, detail: channelDetail(state, channel, directory, {}) };
}

describe("频道详情里的任务板", () => {
	test("一条都没有时，detail 上干脆没有 tasks 这个键", async () => {
		const box = await setup();
		const { detail } = await detailOf(box);
		expect("tasks" in detail).toBe(false);
	});

	test("真落一条，从 detail 读得回来：标题、状态、负责人、起源、流水", async () => {
		const box = await setup();
		await addTask(box, { title: "把连接池调到 20", accept: "压测不报错", goal: "压测要过" });
		const { detail } = await detailOf(box);

		const task = detail.tasks?.t1;
		expect(task).toBeDefined();
		expect(task?.title).toBe("把连接池调到 20");
		expect(task?.status).toBe("open");
		expect(task?.owner).toBe(ME);
		expect(task?.goal).toBe("压测要过");
		expect(task?.accept).toBe("压测不报错");
		expect(task?.channelId).toBe(TEAM);
		expect(task?.originSeq).toBe(1);
		expect(task?.history).toHaveLength(1);
		expect(task?.history[0].what).toBe("created");
	});

	test("没写验收的，detail 里就没有 accept 这个键 —— 「缺什么」读得出来", async () => {
		const box = await setup();
		await addTask(box, { title: "把连接池调到 20" });
		const { detail } = await detailOf(box);
		const task = detail.tasks?.t1;
		expect(task).toBeDefined();
		expect(task !== undefined && "accept" in task).toBe(false);
	});

	test("改了状态，detail 读到的是盘上现在的样子，不是建时的快照", async () => {
		const box = await setup();
		await addTask(box, { title: "把连接池调到 20" });
		const second = await commitTaskNote(
			{ harness: box.runtime.harness },
			{
				channelId: box.channelId,
				at: 200,
				id: "t1",
				expectHistoryLength: 1,
				plan: (current) => ({
					task: { ...(current as NonNullable<typeof current>), status: "blocked" },
					what: "status",
					text: "t1：blocked：等界面那边定形状",
				}),
			},
			BACKGROUND_CONTEXT,
		);
		expect(second.ok).toBe(true);

		const { detail } = await detailOf(box);
		expect(detail.tasks?.t1.status).toBe("blocked");
		expect(detail.tasks?.t1.history.map((entry) => entry.what)).toEqual(["created", "status"]);
	});

	test("别的频道的任务不混进来", async () => {
		const box = await setup();
		await addTask(box, { title: "alpha 的活" });
		await addTask(box, { title: "beta 的活", channelId: OTHER_TEAM });

		// id 是**频道内**递增的：两个频道各自从 t1 数起，所以这里靠标题分谁是谁。
		const alpha = (await detailOf(box)).detail.tasks ?? {};
		const beta = (await detailOf(box, OTHER_TEAM)).detail.tasks ?? {};
		expect(Object.keys(alpha)).toEqual(["t1"]);
		expect(Object.keys(beta)).toEqual(["t1"]);
		expect(alpha.t1.title).toBe("alpha 的活");
		expect(beta.t1.title).toBe("beta 的活");
	});

	test("投影是抄出来的：改 detail 里那份，盘上的任务不动", async () => {
		const box = await setup();
		await addTask(box, { title: "把连接池调到 20" });
		const { state, detail } = await detailOf(box);
		const task = detail.tasks?.t1;
		expect(task).toBeDefined();
		if (task !== undefined) {
			task.title = "被界面改掉的名字";
			task.history.push({ seq: 999, what: "status" });
		}
		expect(state.tasks?.[TEAM]?.t1.title).toBe("把连接池调到 20");
		expect(state.tasks?.[TEAM]?.t1.history).toHaveLength(1);
	});
});

/**
 * 全局板（2.9.21 补的一格）。
 *
 * 病根：板按频道分，老板得挨个频道翻才看得全 —— 「做了但等于没做」。这一格把
 * 所有频道的活摊成一条数组，顶栏那个常驻入口吃它。
 *
 * 两条规矩跟 detail 那条一致：**一条都没有就没有这个键**、**逐格复制**（代理出事务
 * 再读会报 settled overlay）。另外一条是这次单独定的：**不筛状态** —— `done` / `dropped`
 * 也给，筛不筛是界面的事，核心替界面筛等于逼下一个人来改核心。
 */
describe("全局板：所有频道的活一处看全", () => {
	/** 走真写入层把一条任务改成某个状态。 */
	async function moveTo(box: Box, channelId: string, id: string, status: "doing" | "done" | "dropped") {
		const state = (await box.runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		const length = state.tasks?.[channelId]?.[id]?.history.length ?? 0;
		const result = await commitTaskNote(
			{ harness: box.runtime.harness },
			{
				channelId,
				at: 300,
				id,
				expectHistoryLength: length,
				plan: (current) => ({
					task: { ...(current as NonNullable<typeof current>), status },
					what: "status",
					text: `${id}：${status}${status === "dropped" ? "：不做了" : ""}`,
				}),
			},
			BACKGROUND_CONTEXT,
		);
		if (!result.ok) throw new Error(`改状态失败：${result.message}`);
	}

	async function stateOf(box: Box): Promise<ChannelState> {
		return (await box.runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
	}

	test("两个频道的活都在一处，done 和 dropped 也不筛掉", async () => {
		const box = await setup();
		await addTask(box, { title: "alpha 的活" });
		await addTask(box, { title: "beta 的活", channelId: OTHER_TEAM });
		await moveTo(box, TEAM, "t1", "dropped");
		await moveTo(box, OTHER_TEAM, "t1", "doing");
		await moveTo(box, OTHER_TEAM, "t1", "done");

		const tasks = workspaceTasks(await stateOf(box));
		expect(tasks).toHaveLength(2);
		expect(tasks?.map((task) => [task.channelId, task.title, task.status])).toEqual([
			[TEAM, "alpha 的活", "dropped"],
			[OTHER_TEAM, "beta 的活", "done"],
		]);
	});

	test("一条活都没有时，不补空数组（跟 detail 上那条一个规矩）", async () => {
		const box = await setup();
		expect(workspaceTasks(await stateOf(box))).toBeUndefined();
	});

	test("投影是抄出来的：改全局板里那份，盘上的任务不动", async () => {
		const box = await setup();
		await addTask(box, { title: "把连接池调到 20" });
		const state = await stateOf(box);
		const tasks = workspaceTasks(state);
		expect(tasks).toHaveLength(1);
		const first = tasks?.[0];
		if (first !== undefined) {
			first.title = "被界面改掉的名字";
			first.history.push({ seq: 999, what: "status" });
		}
		expect(state.tasks?.[TEAM]?.t1.title).toBe("把连接池调到 20");
		expect(state.tasks?.[TEAM]?.t1.history).toHaveLength(1);
	});

	test("组织快照真的接上了这一格：readOrg 返回的 tasks 就是盘上那些活", async () => {
		const box = await setup();
		await addTask(box, { title: "alpha 的活" });
		await addTask(box, { title: "beta 的活", channelId: OTHER_TEAM });
		const state = await stateOf(box);

		// 假外壳：会话里没人跑（liveMaps 两个 Map 都空），只喂真实那份频道状态。
		const shell = {
			harness: { snapshot: async () => undefined, conversation: async () => ({ entries: async () => ({ items: [] }) }) },
			registry: { snapshot: () => ({ tools: () => [] }) },
			labelOf: (slug: string) => slug,
		};
		const snapshots = {
			snapshot: async () => ({ identities: [], directory, channels: state, assistants: [] }),
		};
		const org = await createRead(shell as never, snapshots as never).readOrg();
		expect(org.tasks?.map((task) => task.title)).toEqual(["alpha 的活", "beta 的活"]);
	});

	test("组织快照里一条活都没有时，org 上干脆没有 tasks 这个键", async () => {
		const box = await setup();
		const state = await stateOf(box);
		const shell = {
			harness: { snapshot: async () => undefined, conversation: async () => ({ entries: async () => ({ items: [] }) }) },
			registry: { snapshot: () => ({ tools: () => [] }) },
			labelOf: (slug: string) => slug,
		};
		const snapshots = {
			snapshot: async () => ({ identities: [], directory, channels: state, assistants: [] }),
		};
		const org = await createRead(shell as never, snapshots as never).readOrg();
		expect("tasks" in org).toBe(false);
	});
});
