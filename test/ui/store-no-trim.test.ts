/**
 * 内存里不裁消息、未读起点、未读口径、`hasMoreAbove` 的接线 —— 这四组钉的是同一件事：
 * **界面这一侧对「上面还有没有」的理解，必须和服务端说的完全一致。**
 *
 * 来由：`8e0125d` 删 `loadAround` / `unreadBeforeOf` 时把这个文件整份删了（196 行）。
 * 删的理由只对了一行 import —— 里面 9 条测试跟那两个函数无关，其中「messages 不裁」
 * 是 2026-11-11 顾行抓到「裁掉 4000 条、再也拉不回来」之后立的守卫。
 * 程砚-2 审计点名要照单补回来，这一份就是那 9 条（+1 条他建议新加的 C3）。
 *
 * 两条写法上的硬要求（吃过亏）：
 *
 * 1. **假后端不许手写 JSON**：一律用真的 `channelDetail()` 造详情。上一版手写 JSON，
 *    服务端把 `hasMore` 改名成 `hasMoreAbove` 之后假后端还在回旧字段，测试照样绿 ——
 *    绿的是过期的契约。
 * 2. 断言直接打在 store 上（`getState()`），不去复活已经被删掉的 helper。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelDetail } from "../../src/app/project.ts";
import type { Channel, ChannelState } from "../../src/core/channel/types.ts";
import type { Message } from "../../ui/app/src/api/types.ts";
import { getState, loadEarlier, openChannel, patch } from "../../ui/app/src/state/store.ts";
import { buildRows } from "../../ui/app/src/stream/model.ts";

const AT = 1_760_000_000_000;
const CH = "group:c1";

function channelOf(id: string, title: string): Channel {
	return { id, title, members: ["owner", "lin"], wakeOnAll: [], createdAt: AT };
}

const directory = {
	slugToConversation: { owner: 0, lin: 1 },
	conversationToSlug: { "0": "owner", "1": "lin" },
	wake: {},
	labels: { lin: "林越" },
};

/** 后端：`count` 条消息（`from` 交替，跟真频道一样有人有己）。 */
function backendOf(count: number, id = CH): ChannelState {
	const channel = channelOf(id, "5000 条");
	return {
		channels: { [id]: channel },
		messages: {
			[id]: Array.from({ length: count }, (_, index) => ({
				seq: index + 1,
				at: AT + index * 1000,
				from: index % 2 === 0 ? "lin" : "owner",
				kind: "chat" as const,
				text: `第 ${String(index + 1)} 条`,
				mentions: [],
				read: true,
			})),
		},
		nextSeq: { [id]: count + 1 },
		readMarks: {},
	};
}

let backend: ChannelState;
/** 这一次测试里假后端收到的全部请求路径。 */
let calls: string[] = [];

/** 把 `fetch` 换成「查内存里的后端」，路径解析与真路由一致（照 `stream-later-e2e.test.ts`）。 */
function installFetch(): void {
	calls = [];
	vi.stubGlobal(
		"fetch",
		async (input: string | URL | Request): Promise<Response> => {
			const path = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push(path);
			const url = new URL(path, "http://localhost");
			const json = (body: unknown): Response =>
				new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
			// 频道列表（`openChannel` 之后会刷一次，用来清未读徽标）。
			if (url.pathname === "/api/channels") return json({ channels: [] });
			// 标记已读（`readToEnd` 顺手做的，不 await）。
			if (url.pathname.endsWith("/read")) return json({ ok: true });
			// 私聊打开时会顺手拉对方轮次 —— 群里不会走，但留着，免得某个用例一换 id 就冒出未处理拒绝。
			if (url.pathname.startsWith("/api/people/")) return json({ turns: [] });
			const id = decodeURIComponent(url.pathname.replace(/^\/api\/channels\//, ""));
			const channel = backend.channels[id];
			if (channel === undefined) return new Response("{}", { status: 404 });
			const options: { limit?: number; before?: number; after?: number } = {};
			const limit = url.searchParams.get("limit");
			const before = url.searchParams.get("before");
			const after = url.searchParams.get("after");
			if (limit !== null) options.limit = Number(limit);
			if (before !== null) options.before = Number(before);
			if (after !== null) options.after = Number(after);
			return json(channelDetail(backend, channel, directory, { ...options, viewer: "owner", assistants: [] }));
		},
	);
}

beforeEach(() => {
	backend = backendOf(0);
	installFetch();
	// store 是进程内的单例：每个用例先把「当前频道 / 详情 / 上下界」清干净，
	// 否则上一条用例残留的 `hasMoreAbove` 会让这一条以为「上面还有」。
	patch({ currentId: null, detail: null, hasMoreAbove: false, loadingEarlier: false, unreadBefore: null, channels: [] });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** 拿真 `channelDetail()` 造一页详情（不手写 JSON）。 */
function detailOf(from: number, to: number, readMark?: number) {
	const channel = backend.channels[CH];
	if (channel === undefined) throw new Error("后端里没有这个频道");
	const options: { limit: number; before: number; readMark?: number } = { limit: to - from + 1, before: to + 1 };
	if (readMark !== undefined) options.readMark = readMark;
	return channelDetail(backend, channel, directory, { ...options, viewer: "owner", assistants: [] });
}

/** 一条最小消息：只填 `buildRows` 真正读的字段。 */
function rowMessage(seq: number, fromSlug: string, kind: string, noteOf?: string): Message {
	return { seq, at: AT + seq * 1000, fromSlug, fromLabel: fromSlug, kind, text: `第 ${seq} 条`, ...(noteOf === undefined ? {} : { noteOf }) } as unknown as Message;
}

/* ── A 组：messages 不裁 ───────────────────────────────────────────── */

describe("messages 不裁", () => {
	it("A1 翻到第 1 条之后，内存里还是整整 5000 条，一条都没少", async () => {
		backend = backendOf(5000);
		await openChannel(CH);
		// 一直往前翻，直到服务端说没有了 —— 靠真 `loadEarlier` 翻，不自己拼数组。
		for (let round = 0; round < 40 && getState().hasMoreAbove; round += 1) {
			await loadEarlier(200);
		}
		expect(getState().hasMoreAbove).toBe(false);

		// 收尾：把 hasMoreAbove 打回「没有更早的了」—— 2026-11-11 那版就是在这一下之后开始裁的。
		patch({ hasMoreAbove: false });

		const messages = getState().detail?.messages ?? [];
		// 关键断言：内存里还是 1..5000 全部。裁过就会少掉一大截，而且再也拉不回来
		// （`loadEarlier` 第一句 `if (!hasMoreAbove) return`，那 4000 条永久丢失 = 验收 E1）。
		expect(messages.length).toBe(5000);
		expect(messages[0]?.seq).toBe(1);
		expect(messages.at(-1)?.seq).toBe(5000);
		// 31 页都真的走了后端，不是本地拼出来的。
		expect(calls.filter((item) => item.includes("before=")).length).toBe(25);
	});
});

/* ── B 组：未读起点 ───────────────────────────────────────────────── */

describe("未读横幅的起点（线只能由服务端的 readMark 给）", () => {
	/** 列表说这个频道有未读、而且「当前不在这个频道」—— 这两个条件凑齐才会给 `-1` 占位。 */
	function listed(unread: number): void {
		patch({
			currentId: "group:other",
			channels: [
				{
					id: CH,
					kind: "group",
					title: "5000 条",
					unread,
					mentions: 0,
					preview: "",
					lastAt: AT,
					lastSeq: 40,
					memberCount: 2,
					members: ["lin"],
				},
			],
		});
	}

	it("B1 有未读时线用服务端的 readMark（37），不是 -1、也不是页尾那条", async () => {
		backend = backendOf(40);
		backend.readMarks = { owner: { [CH]: 37 } };
		listed(3);
		await openChannel(CH);
		expect(getState().unreadBefore).toBe(37);
	});

	it("B2 列表说没未读 → 线保持 null，一条都不画", async () => {
		backend = backendOf(40);
		backend.readMarks = { owner: { [CH]: 40 } };
		listed(0);
		await openChannel(CH);
		expect(getState().unreadBefore).toBe(null);
	});

	it("B3 整页都是新的（readMark 400 < 页内最早 401）时照实给 400，不 clamp 到页首", async () => {
		backend = backendOf(440);
		backend.readMarks = { owner: { [CH]: 400 } };
		listed(40);
		await openChannel(CH);
		const first = getState().detail?.messages[0]?.seq;
		expect(first).toBe(401);
		// 夹到页首就会写 401 —— 横幅顶到最上面、条数虚报整屏。
		expect(getState().unreadBefore).toBe(400);
	});
});

/* ── C 组：未读条数口径 ───────────────────────────────────────────── */

describe("未读条数口径（必须和侧栏徽章一致）", () => {
	it("C1 自己发的不算未读：列表 3 条，进去也是 3 条", () => {
		const rows = buildRows({
			messages: [
				rowMessage(11, "lin", "chat"),
				rowMessage(12, "lin", "chat"),
				rowMessage(13, "owner", "chat"),
				rowMessage(14, "lin", "chat"),
				rowMessage(15, "owner", "chat"),
				rowMessage(16, "owner", "chat"),
			],
			unreadBefore: 10,
			now: 0,
		});
		const banner = rows.find((row) => row.type === "unread");
		expect(banner).toBeDefined();
		expect((banner as { count: number }).count).toBe(3);
	});

	it("C2 留痕不算未读；一条都没有就不画横幅", () => {
		const rows = buildRows({
			messages: [rowMessage(11, "owner", "chat"), rowMessage(12, "lin", "note")],
			unreadBefore: 10,
			now: 0,
		});
		expect(rows.some((row) => row.type === "unread")).toBe(false);
	});

	it("C3 后台命令的留痕会成行，但不许计进 count", () => {
		const rows = buildRows({
			messages: [rowMessage(11, "lin", "chat"), rowMessage(12, "lin", "note", "run")],
			unreadBefore: 10,
			now: 0,
		});
		// 留痕那一行在（折成一行可点开），但它不算「新消息」。
		expect(rows.some((row) => row.type === "note")).toBe(true);
		const banner = rows.find((row) => row.type === "unread");
		expect((banner as { count: number }).count).toBe(1);
	});
});

/* ── D 组：hasMoreAbove 的接线 ────────────────────────────────────── */

describe("`hasMoreAbove` 的接线（代码对、接线错那三组）", () => {
	it("D1 服务端说上面没有了，就不许再发请求（不原地转圈）", async () => {
		backend = backendOf(100);
		patch({ currentId: CH, detail: detailOf(51, 100), hasMoreAbove: false, loadingEarlier: false });
		calls = [];
		await loadEarlier();
		// 判据被删掉时会去要 `before=51` —— 把手里这一屏再要一遍，翻页翻了个寂寞。
		for (const path of calls) {
			expect(new URL(path, "http://local").searchParams.get("before")).not.toBe("51");
		}
	});

	it("D2 写回的是服务端说的那个值，不是恒真", async () => {
		// 手里这页是 51..150，可服务端只到第 50 条：这一翻就到头了，`hasMoreAbove` 必须变假。
		backend = backendOf(150);
		patch({ currentId: CH, detail: detailOf(51, 150), hasMoreAbove: true, loadingEarlier: false });
		backend = backendOf(50);
		await loadEarlier(200);
		expect(getState().hasMoreAbove).toBe(false);
	});

	it("D3 `openChannel` 把详情里的值原样存进去，不取反", async () => {
		backend = backendOf(100);
		await openChannel(CH);
		// 100 条、首页 40 条 → 上面还有 60 条。
		expect(getState().hasMoreAbove).toBe(true);
	});
});
