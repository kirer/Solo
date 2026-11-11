/**
 * `loadLater` 端到端（虚拟化重做 2026-11-11）：真 store + 真后端取页，只把网络换成内存。
 *
 * 上一个文件是「照抄一遍判断逻辑」，那只能证明我抄得对；这个文件跑的是**真的那段代码**：
 * `openChannel` → `applyMessage`（窗口不贴底时的分支）→ `loadLater` → 窗口接上。
 *
 * 为什么这条路非跑不可：它是这次唯一一条「新加的、从没被任何界面走过」的链。
 * 不跑通就发版，等于发一段没人执行过的代码。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelDetail } from "../../src/app/project.ts";
import type { Channel, ChannelState } from "../../src/core/channel/types.ts";

const AT = 1_700_000_000_000;
const CHANNEL_ID = "dm:lin-owner";
const PAGE = 40;

const channel: Channel = { id: CHANNEL_ID, title: "林越", members: ["owner", "lin"], wakeOnAll: [], createdAt: AT };

function backendState(count: number): ChannelState {
	return {
		channels: { [CHANNEL_ID]: channel },
		messages: {
			[CHANNEL_ID]: Array.from({ length: count }, (_, index) => ({
				seq: index + 1,
				at: AT + index * 1000,
				from: index % 2 === 0 ? "lin" : "owner",
				kind: "chat" as const,
				text: `第 ${String(index + 1)} 条`,
				mentions: [],
				read: true,
			})),
		},
		nextSeq: { [CHANNEL_ID]: count + 1 },
		readMarks: {},
	};
}

const directory = {
	slugToConversation: { owner: 0, lin: 1 },
	conversationToSlug: { "0": "owner", "1": "lin" },
	wake: {},
	labels: { lin: "林越" },
};

/** 让「后端」多出几条新消息（模拟别人在 A 窗口里说话）。 */
let backend: ChannelState;

/** 把 `fetch` 换成「查内存里的后端」，路径解析与真路由一致。 */
function installFetch(): { calls: string[] } {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		async (input: string | URL | Request): Promise<Response> => {
			const path = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push(path);
			const url = new URL(path, "http://localhost");
			const options: { limit?: number; before?: number; after?: number } = {};
			const limit = url.searchParams.get("limit");
			const before = url.searchParams.get("before");
			const after = url.searchParams.get("after");
			if (limit !== null) options.limit = Number(limit);
			if (before !== null) options.before = Number(before);
			if (after !== null) options.after = Number(after);
			// 私聊被打开时会顺手拉对方的任务列表（`loadPersonRuns`，不 await）。这里必须一起应答：
			// 返回一个空 `turns`，否则那条请求会抛 `result.turns is not iterable` 变成未处理拒绝 ——
			// 测试里看起来是绿的，实际是藏了一个错。
			if (url.pathname.startsWith("/api/people/") && url.pathname.endsWith("/turns")) {
				return new Response(JSON.stringify({ turns: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			const detail = channelDetail(backend, channel, directory, { ...options, viewer: "owner", assistants: [] });
			return new Response(JSON.stringify(detail), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	);
	return { calls };
}

/** 从后端「推」一条新消息到前端（SSE 那一层的样子）。 */
function push(seq: number, text: string) {
	const messages = backend.messages[CHANNEL_ID] ?? [];
	messages.push({ seq, at: AT + seq * 1000, from: "lin", kind: "chat", text, mentions: [], read: true });
	backend.nextSeq[CHANNEL_ID] = seq + 1;
	return { seq, at: AT + seq * 1000, fromSlug: "lin", text, kind: "chat" as const, mentions: [], read: true };
}

type Store = typeof import("../../ui/app/src/state/store.ts");
let store: Store;

beforeEach(async () => {
	vi.resetModules();
	backend = backendState(120);
	installFetch();
	store = await import("../../ui/app/src/state/store.ts");
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const windowSeqs = (): number[] => (store.getState().detail?.messages ?? []).map((message) => message.seq);

describe("贴底时不预留缝：新消息直接进窗口", () => {
	it("进频道 → 窗口贴底（unseenAfter 为 null）→ 来一条新消息就并进窗口", async () => {
		await store.openChannel(CHANNEL_ID);
		expect(store.getState().unseenAfter).toBeNull();
		expect(windowSeqs().at(-1)).toBe(120);

		store.applyMessage(CHANNEL_ID, push(121, "新来的一条") as never);
		expect(windowSeqs().at(-1)).toBe(121);
		expect(store.getState().unseenAfter).toBeNull();
	});
});

describe("不贴底时留一条缝，位置不许被拽走（验收第 26 条）", () => {
	it("用户往上翻了 → 新消息不进窗口，只记 hasLater", async () => {
		await store.openChannel(CHANNEL_ID);
		// 用户往上翻：界面在这一次结算里把窗口标成「不贴底」，缝开在窗口的最新一条上。
		store.patch({ unseenAfter: 120, hasLater: false });
		const before = windowSeqs();

		store.applyMessage(CHANNEL_ID, push(121, "别人说的") as never);
		store.applyMessage(CHANNEL_ID, push(122, "别人又说的") as never);

		// 窗口一条都没变 —— 用户眼前那屏不动，这就是「B 里任何东西都不许动」。
		expect(windowSeqs()).toEqual(before);
		expect(store.getState().hasLater).toBe(true);
		expect(store.getState().unseenAfter).toBe(120);
	});

	it("往下翻到窗口下界 → loadLater 把那一页接上，缝归位", async () => {
		await store.openChannel(CHANNEL_ID);
		store.patch({ unseenAfter: 120, hasLater: false });
		store.applyMessage(CHANNEL_ID, push(121, "别人说的") as never);
		store.applyMessage(CHANNEL_ID, push(122, "别人又说的") as never);

		await store.loadLater(PAGE);

		// 接上了 121、122 两条，且是一条不多一条不少。
		expect(windowSeqs().at(-2)).toBe(121);
		expect(windowSeqs().at(-1)).toBe(122);
		expect(store.getState().unseenAfter).toBeNull();
		expect(store.getState().hasLater).toBe(false);
	});

	it("接上之后又回到贴底状态：再来的新消息重新直接进窗口", async () => {
		await store.openChannel(CHANNEL_ID);
		store.patch({ unseenAfter: 120, hasLater: false });
		store.applyMessage(CHANNEL_ID, push(121, "一") as never);
		await store.loadLater(PAGE);

		store.applyMessage(CHANNEL_ID, push(122, "二") as never);
		expect(windowSeqs().at(-1)).toBe(122);
	});

	it("接页过程中切走频道 → 旧频道的数据不许并进新频道", async () => {
		await store.openChannel(CHANNEL_ID);
		store.patch({ unseenAfter: 120, hasLater: false });
		store.applyMessage(CHANNEL_ID, push(121, "一条") as never);

		const pending = store.loadLater(PAGE);
		store.openChannel(null);
		await pending;

		expect(store.getState().detail).toBeNull();
	});

	it("接页失败 → laterError 置真，不静默、不假装成功", async () => {
		await store.openChannel(CHANNEL_ID);
		store.patch({ unseenAfter: 120, hasLater: false });
		store.applyMessage(CHANNEL_ID, push(121, "一条") as never);

		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "断了" }), { status: 500 }));
		await store.loadLater(PAGE);

		expect(store.getState().laterError).toBe(true);
		// 缝还在：失败不许把「下面还有东西」这件事抹掉。
		expect(store.getState().unseenAfter).toBe(120);
	});
});

/**
 * 未处理拒绝必须是空的。
 *
 * 这一条是被打回来的原因写下来的：这个文件的**第一版 6 条全绿**，但底下压着 6 个
 * 未处理拒绝（私聊打开时顺手拉对方的任务列表，那条请求撞上了假的 `fetch`，抛在
 * 没人 await 的地方）。vitest 当时只在输出里打一行「Errors 6 errors」，退出码照样 0 ——
 * 「全绿」和「有错」同时成立。这次要防的就是这个。
 *
 * 所以这里不靠眼睛看输出，靠**断言**：收集 `unhandledRejection`，每条用例结束前必须是 0。
 */
describe("整个过程不许有未处理拒绝（绿着藏错比红更坏）", () => {
	const rejections: unknown[] = [];
	const record = (reason: unknown): void => {
		rejections.push(reason);
	};

	beforeEach(() => {
		rejections.length = 0;
		process.on("unhandledRejection", record);
	});

	afterEach(() => {
		process.off("unhandledRejection", record);
	});

	/** 让挂起的微任务 / 定时器跑完，未处理的拒绝才有机会冒出来。 */
	const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

	it("走一遍完整链路（进频道 → 来新消息 → 接页）之后，未处理拒绝为 0", async () => {
		await store.openChannel(CHANNEL_ID);
		store.patch({ unseenAfter: 120, hasLater: false });
		store.applyMessage(CHANNEL_ID, push(121, "一条") as never);
		await store.loadLater(PAGE);
		await drain();

		// 失败时把原因原样打到断言里 —— 光说「有 1 个拒绝」等于没说。
		expect(rejections.map((reason) => String(reason))).toEqual([]);
	});

	it("接页失败的那条路也不许漏出未处理拒绝", async () => {
		await store.openChannel(CHANNEL_ID);
		store.patch({ unseenAfter: 120, hasLater: false });
		store.applyMessage(CHANNEL_ID, push(121, "一条") as never);
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "断了" }), { status: 500 }));
		await store.loadLater(PAGE);
		await drain();

		expect(rejections.map((reason) => String(reason))).toEqual([]);
	});
});
