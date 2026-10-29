/**
 * 频道 SSE 只认 create / done（外加 error 用来标断线）。
 *
 * P1-3 把服务端的假流式删掉之后，前端的 `token` 监听就成了一段永远不跑的
 * 「纯文本 append 进 Markdown 容器」死代码 —— 它还会让人以为正文是流式写的，
 * 于是去优化一个不存在的问题。这条测试静态扫 `hooks/useStreams.ts`，钉住「只注册这两种事件」。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("../../ui/app/src/hooks/useStreams.ts", import.meta.url)), "utf8");

describe("频道 EventSource 的事件", () => {
	it("只注册 create / done / error，没有 token", () => {
		const events = [...source.matchAll(/addEventListener\("([a-z]+)"/g)].map((match) => match[1]);
		// 同一份文件里还有别的事件监听（click / keydown 等走 addEventListener 的写法不同），
		// 这里只看 EventSource 那一组：create / done 必须都在。
		expect(events).toContain("create");
		expect(events).toContain("done");
		expect(events).not.toContain("token");
	});

	it("没有残留的 delta / 假流式拼接", () => {
		expect(source).not.toContain("payload.delta");
		expect(source).not.toMatch(/createTextNode\(/);
	});
});
