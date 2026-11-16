/**
 * SSE 的**字节合同**。
 *
 * 界面上的一条消息只靠这条流到达：帧格式（`retry: 1500`、`event: create` / `event: org`、
 * `data:` 后面跟一行 JSON，`data` 就是 view 对象本身）以及 `?since=N` 的语义
 * （只补 N+1 起的）都是前后端之间的硬约定。重构 `hub.ts`（连接集合、去抖、游标）时
 * 这一层必须逐字节不变 —— 所以这里直接断言**写出去的字符串**，而不是断言「推了 3 条」。
 */
import { describe, expect, test } from "vitest";
import type { ServerResponse } from "node:http";
import { createStreamHub } from "../../src/interface/http/sse.ts";
import { encodeEvent, retryFrame, sseHeaders } from "../../src/interface/http/sse.ts";
import { OWNER_SLUG, type ChannelState } from "../../src/core/channel/types.ts";
import { appendMessage, ensureChannel } from "../../src/core/channel/rules.ts";
import { emptyDirectory } from "../../src/core/channel/roster.ts";
import type { ChannelSnapshot } from "../../src/app/snapshot.ts";

const ALL = "all";

/** 一个只记 `write` 的假响应；`close()` 手动触发断开，免得保活定时器漏在测试里。 */
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

function stateOf(): ChannelState {
	let state: ChannelState = { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
	state = ensureChannel(state, { id: ALL, title: "全员", members: [OWNER_SLUG, "沈舟"], at: 1 });
	for (const [index, text] of ["一", "二", "三"].entries()) {
		state = appendMessage(state, ALL, { from: OWNER_SLUG, text, at: index + 1 }).state;
	}
	return state;
}

function hubFor(state: ChannelState, read?: unknown) {
	const snapshot: ChannelSnapshot = { identities: [], directory: emptyDirectory(), channels: state };
	const snapshots = {
		channelSnapshot: async () => snapshot,
		snapshot: async () => ({ ...snapshot, teamLeadOf: {}, teamDoingOf: {} }),
	};
	let commits: () => void = () => undefined;
	const shell = {
		harness: {
			// 提交总线是**同步观察者**（1.5.0 起），不是返回取消函数的 `subscribeCommits`：
			// 写成后者的话 `start()` 挂不上，`commit()` 变成空调用，测试全绿但什么也没验。
			observeCommits: (observer: { advance: () => void }) => {
				commits = observer.advance;
				return { detach: () => undefined };
			},
		},
		directory: emptyDirectory(),
	};
	const hub = createStreamHub(shell as never, snapshots as never, read as never);
	hub.start();
	return Object.assign(hub, { commit: () => commits() });
}

/** 等 `prime` / `flush` 那些 `void` 出去的 promise 落地。 */
async function settle(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

/** 一次 `write` 里可能拼了好几帧：按空行切开，去掉开头的 retry 帧。 */
function framesOf(chunks: readonly string[]): string[] {
	return chunks
		.join("")
		.split("\n\n")
		.filter((frame) => frame !== "" && frame !== "retry: 1500");
}

function dataOf(frame: string): unknown {
	return JSON.parse(frame.slice(frame.indexOf("data: ") + "data: ".length));
}

describe("SSE 帧格式", () => {
	test("头与 retry 帧逐字节固定（retry: 1500）", () => {
		const headers = sseHeaders();
		expect(headers["Content-Type"]).toBe("text/event-stream; charset=utf-8");
		expect(headers["Cache-Control"]).toBe("no-cache, no-transform");
		expect(headers["X-Accel-Buffering"]).toBe("no");
		expect(retryFrame()).toBe("retry: 1500\n\n");
		// `data` 就是 view 对象本身（不包 `{type, org}` 那层壳）。
		expect(encodeEvent({ type: "org", org: {} as never })).toBe("event: org\ndata: {}\n\n");
	});
});

describe("频道流", () => {
	test("第一次连：retry 帧 + 全部历史，一条一帧，按 seq 升序", async () => {
		const hub = hubFor(stateOf());
		const client = fakeResponse();
		hub.streamChannel(client.response, ALL);
		await settle();
		expect(client.chunks[0]).toBe("retry: 1500\n\n");
		const frames = framesOf(client.chunks);
		expect(frames).toHaveLength(3);
		for (const frame of frames) expect(frame.startsWith("event: create\ndata: ")).toBe(true);
		expect(frames.map((frame) => (dataOf(frame) as { seq: number }).seq)).toEqual([1, 2, 3]);
		client.close();
		hub.close();
	});

	test("?since=N 只补 N+1 起的（不再重发已有的）", async () => {
		const hub = hubFor(stateOf());
		const client = fakeResponse();
		hub.streamChannel(client.response, ALL, 2);
		await settle();
		const frames = framesOf(client.chunks);
		expect(frames).toHaveLength(1);
		expect((dataOf(frames[0]!) as { seq: number }).seq).toBe(3);
		client.close();
		hub.close();
	});

	test("?since=N 的 N 超过最新一条时只剩 retry 帧", async () => {
		const hub = hubFor(stateOf());
		const client = fakeResponse();
		hub.streamChannel(client.response, ALL, 99);
		await settle();
		expect(client.chunks).toEqual(["retry: 1500\n\n"]);
		client.close();
		hub.close();
	});

	test("消息帧里带的是 view 的九个字段", async () => {
		const hub = hubFor(stateOf());
		const client = fakeResponse();
		hub.streamChannel(client.response, ALL, 2);
		await settle();
		const view = dataOf(framesOf(client.chunks)[0]!) as Record<string, unknown>;
		expect(Object.keys(view).sort()).toMatchInlineSnapshot(`
			[
			  "at",
			  "from",
			  "fromLabel",
			  "fromSlug",
			  "kind",
			  "mentions",
			  "read",
			  "seq",
			  "text",
			]
		`);
		// `from` 是会话 id（数字），`fromSlug` / `fromLabel` 才是人 —— 这是 dto 的合同。
		expect(view.fromSlug).toBe(OWNER_SLUG);
		expect(view.seq).toBe(3);
		expect(view.text).toBe("三");
		client.close();
		hub.close();
	});
});

describe("组织流", () => {
	test("一连上就推一整份 org 快照", async () => {
		const hub = hubFor(stateOf());
		const client = fakeResponse();
		hub.streamOrg(client.response);
		await settle();
		expect(client.chunks[0]).toBe("retry: 1500\n\n");
		const frames = framesOf(client.chunks);
		expect(frames).toHaveLength(1);
		expect(frames[0]!.startsWith("event: org\ndata: ")).toBe(true);
		client.close();
		hub.close();
	});

	test("第二个浏览器接进来也拿得到快照（指纹去重不能吃掉首屏）", async () => {
		const hub = hubFor(stateOf());
		const first = fakeResponse();
		hub.streamOrg(first.response);
		await settle();
		const second = fakeResponse();
		hub.streamOrg(second.response);
		await settle();
		expect(framesOf(second.chunks)).toHaveLength(1);
		first.close();
		second.close();
		hub.close();
	});

	/**
	 * 任务那一格：全局板靠 org 推送活着。
	 *
	 * 病根是「改了板上的东西、指纹没变」—— 起一条、改状态、划掉动的是频道文档里的
	 * `tasks`，名册一格不动；指纹只算 `people` 的话一次推送都不触发，界面冻在第一份快照上。
	 * 这一组直接看**推了几帧、帧里的值是什么**，不看指纹函数内部。
	 */
	function boardTask(): Record<string, unknown> {
		return {
			id: "t1",
			title: "把全局板做出来",
			owner: OWNER_SLUG,
			status: "open",
			channelId: ALL,
			originSeq: 1,
			history: [{ seq: 1, what: "created" }],
			changedAt: 100,
			note: "建了一条：把全局板做出来",
		};
	}

	function boardFor(task: Record<string, unknown>) {
		const org = { workspace: { name: "Solo" }, people: [], tasks: [task] };
		return { readOrg: async () => org, personOfChannel: async () => undefined, readTurns: async () => ({ turns: [] }) };
	}

	async function waitFlush(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 200));
	}

	test("任务改了状态：再推一帧，帧里是新状态", async () => {
		const task = boardTask();
		const hub = hubFor(stateOf(), boardFor(task));
		const client = fakeResponse();
		hub.streamOrg(client.response);
		await settle();
		expect(framesOf(client.chunks)).toHaveLength(1);

		task.status = "doing";
		hub.commit();
		await waitFlush();
		const frames = framesOf(client.chunks);
		expect(frames).toHaveLength(2);
		expect(frames[1]).toContain('"status":"doing"');
		client.close();
		hub.close();
	});

	test("只补了一句 note（状态没变、changedAt 变了）：也再推一帧", async () => {
		const task = boardTask();
		const hub = hubFor(stateOf(), boardFor(task));
		const client = fakeResponse();
		hub.streamOrg(client.response);
		await settle();
		expect(framesOf(client.chunks)).toHaveLength(1);

		task.changedAt = 900;
		hub.commit();
		await waitFlush();
		expect(framesOf(client.chunks)).toHaveLength(2);
		client.close();
		hub.close();
	});

	test("任务一格没动就不重推（指纹不能因为装了 tasks 就每次提交都推）", async () => {
		const hub = hubFor(stateOf(), boardFor(boardTask()));
		const client = fakeResponse();
		hub.streamOrg(client.response);
		await settle();
		hub.commit();
		await waitFlush();
		expect(framesOf(client.chunks)).toHaveLength(1);
		client.close();
		hub.close();
	});
	test("内容没变就不重推：提交总线响了也一样", async () => {
		const hub = hubFor(stateOf());
		const client = fakeResponse();
		hub.streamOrg(client.response);
		await settle();
		hub.commit();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(framesOf(client.chunks)).toHaveLength(1);
		client.close();
		hub.close();
	});
});
