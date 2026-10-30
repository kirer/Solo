/**
 * 频道 SSE 只认 create（新消息落库），外加 error 用来标断线。
 *
 * ADR-081 删掉了假流式（`token` / `done`）与「正在说」草稿（`draft`）之后，
 * 服务端只推两类事件。这条测试静态扫 `hooks/useStreams.ts`，钉住这件事 ——
 * 留着监听器会让人以为正文是流式写的，于是去优化一个不存在的问题。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("../../ui/app/src/hooks/useStreams.ts", import.meta.url)), "utf8");

describe("频道 EventSource 的事件", () => {
	it("只注册 create / error", () => {
		const events = [...source.matchAll(/addEventListener\("([a-z]+)"/g)].map((match) => match[1]);
		expect(events).toContain("create");
		expect(events).toContain("error");
		for (const gone of ["token", "done", "draft"]) {
			expect(events).not.toContain(gone);
		}
	});

	it("没有残留的 delta / 假流式拼接", () => {
		expect(source).not.toContain("payload.delta");
		expect(source).not.toMatch(/createTextNode\(/);
	});
});
