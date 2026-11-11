import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDetail, Message } from "../../ui/app/src/api/types.ts";
import { getState, loadAround, patch } from "../../ui/app/src/state/store.ts";

const msg = (seq: number) => ({ seq, at: 1_700_000_000_000 + seq, from: 2, fromSlug: "lin", kind: "chat", text: `第 ${String(seq)} 条`, mentions: [], read: true }) as unknown as Message;

function detailOf(from: number, to: number): ChannelDetail {
	const messages: Message[] = [];
	for (let seq = from; seq <= to; seq += 1) messages.push(msg(seq));
	return { channel: { id: "c1", title: "5000 条", kind: "group" }, members: [], messages, hasMoreAbove: true, readMark: 0 } as unknown as ChannelDetail;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn(async (path: string) => {
		const url = new URL(path, "http://local");
		const around = Number(url.searchParams.get("around"));
		// 服务端行为：目标上下各半页（limit 60）。
		const messages: Message[] = [];
		for (let seq = Math.max(1, around - 30); seq <= around + 29; seq += 1) messages.push(msg(seq));
		return new Response(JSON.stringify({ channel: { id: "c1" }, members: [], messages, hasMoreAbove: Math.max(1, around - 30) > 1 }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("跳到不在手里的那条消息（around）", () => {
	it("目标在几百条以外：只换成一页，不把中间几千条灌回内存", async () => {
		patch({ currentId: "c1", detail: detailOf(4950, 5000), hasMoreAbove: true, loadingEarlier: false, unreadBefore: 7 });
		const before = getState().detail?.messages.length ?? 0;
		const ok = await loadAround(100);
		expect(ok).toBe(true);
		// 只发一次请求，带的是 around=100，不是一路 before 翻页。
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("around=100");
		const messages = getState().detail?.messages ?? [];
		expect(messages.some((message) => message.seq === 100)).toBe(true);
		// 一页 60 条上下，不是 5000 条。
		expect(messages.length).toBeLessThanOrEqual(60);
		expect(messages.length).toBeGreaterThanOrEqual(before <= 60 ? 0 : 1);
		// 未读起点是「进频道那一刻」的线，跳一下不该改。
		expect(getState().unreadBefore).toBe(7);
	});

	it("服务端也没有这一条（被删了）：返回 false，屏不动", async () => {
		fetchMock.mockImplementationOnce(async () =>
			new Response(JSON.stringify({ channel: { id: "c1" }, members: [], messages: [msg(1)], hasMoreAbove: false }), { status: 200, headers: { "content-type": "application/json" } }),
		);
		patch({ currentId: "c1", detail: detailOf(4950, 5000), hasMoreAbove: true, loadingEarlier: false });
		const before = getState().detail;
		const ok = await loadAround(999_999);
		expect(ok).toBe(false);
		// 屏没被换成那一页无关的消息。
		expect(getState().detail).toBe(before);
	});

	it("请求失败：返回 false，不抛错、屏不动", async () => {
		fetchMock.mockImplementationOnce(async () => new Response("boom", { status: 500 }));
		patch({ currentId: "c1", detail: detailOf(4950, 5000), hasMoreAbove: true, loadingEarlier: false });
		const before = getState().detail;
		const ok = await loadAround(100);
		expect(ok).toBe(false);
		expect(getState().detail).toBe(before);
	});

	it("拉回来之前人已经切走了：不把旧频道的页盖上去", async () => {
		patch({ currentId: "c1", detail: detailOf(4950, 5000), hasMoreAbove: true, loadingEarlier: false });
		const pending = loadAround(100);
		patch({ currentId: "c2" });
		expect(await pending).toBe(false);
	});
});
