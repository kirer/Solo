/**
 * 内存里不裁消息 —— 钉住这条，因为踩过一次。
 *
 * 2026-11-11 那版在 `applyMessage` / `loadEarlier` 里把 `detail.messages` 裁到 1000 条，
 * 条件是「整段历史都取完（`hasMore === false`）」。听上去安全，实际是把 4000 条永久弄丢：
 *
 * - 翻到第 1 条之后 `hasMore === false`，裁剪开跑，内存只剩第 4001–5000 条；
 * - 用户再往上翻 —— `loadEarlier` 第一句 `if (!hasMore) return`，直接被挡死；
 * - 那 4000 条再也拉不回来，正是验收 E1 禁止的「明明有却说没有了」。
 *
 * 顾行当场抓出来，Solo 让回滚。这条测试就是用来挡住「下一版又有人加回去」的：
 * 它不测「裁得好不好」，它测**裁了没有** —— 只要有人再往 `messages` 上动手，
 * 「翻到第 1 条之后内存里还是 5000 条」这条就红。
 *
 * 真要省内存，等虚拟化本体上来裁 **DOM**（渲染窗口），不是裁 `messages`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDetail, Message } from "../../ui/app/src/api/types.ts";
import { getState, loadEarlier, patch, unreadBeforeOf } from "../../ui/app/src/state/store.ts";

/** 造第 `seq` 条消息。只填 store 真正读的字段。 */
function msg(seq: number): Message {
	return {
		seq,
		at: 1_760_000_000_000 + seq * 1000,
		fromSlug: "owner",
		fromLabel: "老板",
		kind: "chat",
		text: `第 ${String(seq)} 条`,
	} as Message;
}

/** 一个装着 `from..to`（含两端）的频道详情。 */
function detailOf(from: number, to: number): ChannelDetail {
	const messages: Message[] = [];
	for (let seq = from; seq <= to; seq += 1) messages.push(msg(seq));
	return {
		channel: { id: "c1", title: "5000 条", kind: "group" },
		members: [],
		messages,
		hasMore: true,
		readMark: 0,
	} as unknown as ChannelDetail;
}

/**
 * 假后端：只认 `?before=`，一页 1000 条，翻到第 1 条就说没有了。
 * 真 `fetch` 在 node 里要不了相对路径（`ERR_INVALID_URL`），所以直接替掉。
 */
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn(async (path: string) => {
		const before = Number(new URL(path, "http://local").searchParams.get("before") ?? 1);
		const to = before - 1;
		const from = Math.max(1, to - 999);
		const messages: Message[] = [];
		for (let seq = from; seq <= to; seq += 1) messages.push(msg(seq));
		return new Response(
			JSON.stringify({ channel: { id: "c1" }, members: [], messages, hasMore: from > 1 }),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	});
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("messages 不裁", () => {
	it("翻到第 1 条之后，内存里还是整整 5000 条，一条都没少", async () => {
		// 造一段「服务端还有更早的」历史：内存 4001–5000，hasMore 为真。
		patch({ currentId: "c1", detail: detailOf(4001, 5000), hasMore: true, loadingEarlier: false });

		// 一直往前翻，直到服务端说没有了。靠真 `loadEarlier` 翻，不自己拼数组。
		for (let page = 0; page < 8 && getState().hasMore; page += 1) {
			await loadEarlier();
		}
		expect(fetchMock).toHaveBeenCalledTimes(4);

		// 收尾：把 hasMore 打回「没有更早的了」—— 这就是当初触发裁剪的那一下。
		patch({ hasMore: false });

		const messages = getState().detail?.messages ?? [];
		// 关键断言：内存里还是 1..5000 全部。裁过就会少掉一大截。
		expect(messages.length).toBe(5000);
		expect(messages[0]?.seq).toBe(1);
		expect(messages.at(-1)?.seq).toBe(5000);
	});
});

/**
 * 未读横幅插哪儿 —— 曾经插错过，插在首屏最顶上、条数按整屏虚报。
 *
 * 错法：切频道那一刻拿「当前屏最后一条的 seq」当未读起点。可那一句之前 `detail` 已经被
 * 清成 `null` 了，取到的永远是 `undefined`，退化成 `-1`，于是「第一个 seq > -1」就是整页第一条 ——
 * 横幅顶在最上面，条数等于屏幕上所有消息。
 *
 * 真起点只有服务端知道（它手里有我的已读水位）。这里钉住界面这一侧：
 * 列表说有未读就用详情给的 `readMark`；列表说没有就还是 `null`，一点都不变。
 */
describe("未读横幅的起点", () => {
	it("有未读时用服务端给的 readMark，不是 -1、也不是页尾那条", () => {
		const detail = { ...detailOf(1, 40), readMark: 37 };
		expect(unreadBeforeOf(-1, detail)).toBe(37);
	});

	it("没未读时保持 null —— 这条线不画，行为跟以前一模一样", () => {
		const detail = { ...detailOf(1, 40), readMark: 40 };
		expect(unreadBeforeOf(null, detail)).toBe(null);
	});

	it("整页都是新的（readMark 比这一页最早那条还小）也照实给，不糊成页首", () => {
		const detail = { ...detailOf(401, 440), readMark: 400 };
		expect(unreadBeforeOf(-1, detail)).toBe(400);
	});
});
