/**
 * 壳与内核之间只有这一行字：`[core] http://127.0.0.1:<port>/`。
 * 认错了就是「窗口打开一个空地址」，认宽了就是「拿日志里的别的 URL 当后端」。
 */
import { describe, expect, it } from "vitest";
import { parseReadyLine } from "../../desktop/src/ready-line.ts";
import { resolveFeedUrl } from "../../desktop/src/feed.ts";

describe("后端就绪行", () => {
	it("认出带尾斜杠的地址，前后空白不算数", () => {
		expect(parseReadyLine("[core] http://127.0.0.1:41234/")).toBe("http://127.0.0.1:41234/");
		expect(parseReadyLine("  [core] http://127.0.0.1:7788/\r")).toBe("http://127.0.0.1:7788/");
	});

	it("别的一律不认", () => {
		expect(parseReadyLine("[core] workspace: /tmp/ws")).toBeUndefined();
		expect(parseReadyLine("[core] agents: 知言")).toBeUndefined();
		expect(parseReadyLine("http://127.0.0.1:7788/")).toBeUndefined();
		expect(parseReadyLine("[core] 还没有配置模型：…")).toBeUndefined();
	});
});

describe("更新源地址", () => {
	it("https 放行，http 只认本机", () => {
		expect(resolveFeedUrl("https://updates.example.com/solo/")).toBe("https://updates.example.com/solo/");
		expect(resolveFeedUrl("http://127.0.0.1:8899/")).toBe("http://127.0.0.1:8899/");
		expect(resolveFeedUrl("http://localhost:8899/")).toBe("http://localhost:8899/");
		expect(resolveFeedUrl("http://example.com/solo/")).toBeUndefined();
	});

	it("没给 / 不是 URL 就是没有", () => {
		expect(resolveFeedUrl(undefined)).toBeUndefined();
		expect(resolveFeedUrl("  ")).toBeUndefined();
		expect(resolveFeedUrl("not a url")).toBeUndefined();
	});
});
