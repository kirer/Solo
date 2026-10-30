/**
 * SSE 编码：**字节级**断言，不是「跑通了」。
 *
 * 这份格式是浏览器的合同（`EventSource` 只认这几行），漂一个字母浏览器就静默不派发事件 ——
 * 单测是唯一能廉价盯住它的地方。事件名被换掉（比如有人把 `create` 改名）也必须在这里炸：
 * 前端 `useStreams.ts` 按名字订阅，改名等于断流。
 */
import { describe, expect, it } from "vitest";
import {
	KEEP_ALIVE_MS,
	RETRY_MS,
	encodeEvent,
	keepAliveFrame,
	retryFrame,
	sseHeaders,
} from "../../src/core/interface/http/sse.ts";
import type { ViewMessage, ViewOrg } from "../../src/core/view/dto.ts";

const AT = 1_700_000_000_000;

function message(overrides: Partial<ViewMessage> = {}): ViewMessage {
	return {
		seq: 7,
		at: AT,
		from: 1,
		fromSlug: "assistant",
		fromLabel: "助理",
		kind: "chat",
		text: "在",
		mentions: [],
		read: false,
		...overrides,
	};
}

describe("sseHeaders", () => {
	it("是 text/event-stream，且禁止代理攒包/压缩", () => {
		const headers = sseHeaders();
		expect(headers["Content-Type"]).toBe("text/event-stream; charset=utf-8");
		expect(headers["Cache-Control"]).toContain("no-cache");
		expect(headers["Cache-Control"]).toContain("no-transform");
		expect(headers["X-Accel-Buffering"]).toBe("no");
	});
});

describe("retry / keep-alive", () => {
	it("retry 帧是 `retry: <ms>\\n\\n`，且毫秒数与常量一致", () => {
		expect(retryFrame()).toBe(`retry: ${RETRY_MS}\n\n`);
		expect(RETRY_MS).toBe(1500);
	});

	it("保活帧是注释行（浏览器会忽略），并且比代理的空闲阈值短", () => {
		expect(keepAliveFrame()).toBe(": ping\n\n");
		expect(KEEP_ALIVE_MS).toBe(15_000);
		expect(KEEP_ALIVE_MS).toBeLessThan(30_000);
	});
});

describe("encodeEvent", () => {
	it("频道事件叫 create，data 是这条消息的 JSON", () => {
		const piece = encodeEvent({ type: "create", message: message() });
		expect(piece).toBe(`event: create\ndata: ${JSON.stringify(message())}\n\n`);
		// 一段必须以空行结尾，否则浏览器不会派发。
		expect(piece.endsWith("\n\n")).toBe(true);
		expect(piece.split("\n").filter((line) => line !== "")).toHaveLength(2);
	});

	it("组织事件叫 org，data 是整份快照", () => {
		const org: ViewOrg = {
			company: { name: "一人公司" },
			people: [
				{
					slug: "assistant",
					label: "助理",
					title: "助理",
					body: "# 助理",
				},
			],
		};
		const piece = encodeEvent({ type: "org", org });
		expect(piece).toBe(`event: org\ndata: ${JSON.stringify(org)}\n\n`);
	});

	it("正文里有换行也不会把一段拆成两段（data 只有一行）", () => {
		const piece = encodeEvent({ type: "create", message: message({ text: "第一行\n第二行\n\n第三行" }) });
		expect(piece.match(/^data: /gm)).toHaveLength(1);
		expect(piece.match(/^event: /gm)).toHaveLength(1);
		expect(piece.endsWith("\n\n")).toBe(true);
		// JSON 里的换行必须是转义过的两字符 `\n`，不能是真换行。
		expect(piece).toContain("\\n");
	});

	it("`data` 之后没有多余空格或列（浏览器对 `data:` 后的空格有约定：会被吃掉一个）", () => {
		const piece = encodeEvent({ type: "create", message: message() });
		expect(piece.startsWith(`event: create\ndata: {"`)).toBe(true);
	});
});
