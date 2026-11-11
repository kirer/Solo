/**
 * 内存里不裁消息 —— 钉住这条，因为踩过一次。
 *
 * 2026-11-11 那版在 `applyMessage` / `loadEarlier` 里把 `detail.messages` 裁到 1000 条，
 * 条件是「整段历史都取完（`hasMoreAbove === false`）」。听上去安全，实际是把 4000 条永久弄丢：
 *
 * - 翻到第 1 条之后 `hasMoreAbove === false`，裁剪开跑，内存只剩第 4001–5000 条；
 * - 用户再往上翻 —— `loadEarlier` 第一句 `if (!hasMoreAbove) return`，直接被挡死；
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
import { getState, loadEarlier, openChannel, patch, unreadBeforeOf } from "../../ui/app/src/state/store.ts";
import { buildRows } from "../../ui/app/src/stream/model.ts";

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
		hasMoreAbove: true,
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
			JSON.stringify({ channel: { id: "c1" }, members: [], messages, hasMoreAbove: from > 1 }),
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
		// 造一段「服务端还有更早的」历史：内存 4001–5000，hasMoreAbove 为真。
		patch({ currentId: "c1", detail: detailOf(4001, 5000), hasMoreAbove: true, loadingEarlier: false });

		// 一直往前翻，直到服务端说没有了。靠真 `loadEarlier` 翻，不自己拼数组。
		for (let page = 0; page < 8 && getState().hasMoreAbove; page += 1) {
			await loadEarlier();
		}
		expect(fetchMock).toHaveBeenCalledTimes(4);

		// 收尾：把 hasMoreAbove 打回「没有更早的了」—— 这就是当初触发裁剪的那一下。
		patch({ hasMoreAbove: false });

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

describe("未读条数口径（D 组）", () => {
	const message = (seq: number, fromSlug: string, kind: string) => ({ seq, fromSlug, kind }) as never;

	it("自己发的不算未读：列表 3 条，进去也是 3 条", () => {
		// 现场：别人说 3 句，我回了 3 句，列表写 3，进去横幅写 6 —— 多出来的正是我的话。
		const list = [
			message(11, "lin", "chat"),
			message(12, "lin", "chat"),
			message(13, "owner", "chat"),
			message(14, "lin", "chat"),
			message(15, "owner", "chat"),
			message(16, "owner", "chat"),
		];
		const rows = buildRows({ messages: list, unreadBefore: 10, me: "owner", now: 0 });
		const banner = rows.find((row) => row.type === "unread");
		expect(banner).toBeDefined();
		expect((banner as { count: number }).count).toBe(3);
	});

	it("留痕不算未读；一条都没有就不画横幅", () => {
		const rows = buildRows({
			messages: [message(11, "owner", "chat"), message(12, "lin", "note")],
			unreadBefore: 10,
			me: "owner",
			now: 0,
		});
		expect(rows.some((row) => row.type === "unread")).toBe(false);
	});
});

/**
 * 「能不能往上翻」这条判据本身。
 *
 * 起因：程砚-2 把 `loadEarlier` 的判据删掉、把写回改成恒 `true`、把 `openChannel` 存成取反，
 * 三组反向测试全绿 —— 代码是对的，错在「接错了没人发现」。症状是往上翻不动、或者原地转圈。
 * 所以这里不看「翻了多少条」，只盯这三处接线。
 */
describe("`hasMoreAbove` 的接线", () => {
	it("服务端说上面没有了，就不许再发请求（不原地转圈）", async () => {
		patch({ currentId: "c1", detail: detailOf(51, 100), hasMoreAbove: false, loadingEarlier: false });
		fetchMock.mockClear();
		await loadEarlier();
		// 判据被删掉时会去要 `before=51` —— 把手里这一屏**再要一遍**（一页 30 条，
		// 正好从自己的最早一条起），拿回来一模一样，于是「翻页」翻了个寂寞，这就是原地转圈。
		for (const call of fetchMock.mock.calls) {
			const url = new URL(String(call[0]), "http://local");
			expect(url.searchParams.get("before")).not.toBe("51");
		}
	});

	it("写回的是服务端说的那个值，不是恒真", async () => {
		// 页里只有 1..50，服务端却回 `hasMoreAbove: false`（历史到头了）。
		fetchMock.mockImplementationOnce(async () => {
			const messages: Message[] = [];
			for (let seq = 1; seq <= 50; seq += 1) messages.push(msg(seq));
			return new Response(JSON.stringify({ channel: { id: "c1" }, members: [], messages, hasMoreAbove: false }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		patch({ currentId: "c1", detail: detailOf(51, 150), hasMoreAbove: true, loadingEarlier: false });
		await loadEarlier();
		expect(getState().hasMoreAbove).toBe(false);
	});

	it("`openChannel` 把详情里的值原样存进去，不取反", async () => {
		fetchMock.mockImplementationOnce(async () =>
			new Response(JSON.stringify({ channel: { id: "c2", title: "x", kind: "group" }, members: [], messages: [], hasMoreAbove: true, readMark: 0 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await openChannel("c2");
		expect(getState().hasMoreAbove).toBe(true);
	});
});
