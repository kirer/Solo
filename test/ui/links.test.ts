/**
 * 正文外链：什么算「外链」。
 *
 * 判错了的后果是相反的两种：把站内路径也拦下来 → 点了没反应；把 `javascript:` 当外链
 * → 交给内置浏览器（它会被 iframe 挡掉，但没必要走到那一步）。所以这里只钉一条线：
 * **只认 `http(s)://`**。
 */
import { describe, expect, it } from "vitest";
import { builtinLink } from "../../ui/app/src/lib/links.ts";

describe("正文外链", () => {
	it("http / https 算", () => {
		expect(builtinLink("https://example.com/a?b=1")).toBe(true);
		expect(builtinLink("http://127.0.0.1:7788/")).toBe(true);
		expect(builtinLink("  HTTPS://EXAMPLE.COM  ")).toBe(true);
	});

	it("站内路径、锚点、相对路径不算", () => {
		expect(builtinLink("/channels/1")).toBe(false);
		expect(builtinLink("#section")).toBe(false);
		expect(builtinLink("./doc.md")).toBe(false);
	});

	it("别的协议不算", () => {
		expect(builtinLink("javascript:alert(1)")).toBe(false);
		expect(builtinLink("mailto:hi@example.com")).toBe(false);
		expect(builtinLink("//example.com")).toBe(false);
	});
});
