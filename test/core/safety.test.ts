import { describe, expect, it } from "vitest";
import { clip, resolveInWorkspace } from "../../src/core/channel/tools/index.ts";

/**
 * 两个「护栏」的单元契约：路径围栏与长文本裁剪。
 *
 * 它们都不是业务规则，而是**防止代价失控**的两道闸：
 * - 围栏拦的是写错路径（`../..`），它会静默改到别人的文件夹里；
 * - 裁剪拦的是把一整屏编译日志塞进一条消息 / 一段上下文。
 *
 * 两者都在工具内部，平时只有真跑工具才会执行到 —— 所以单测直接测函数。
 */
describe("resolveInWorkspace", () => {
	const root = "/tmp/ws";

	it("工作区内的相对路径原样给出", () => {
		expect(resolveInWorkspace(root, "a.txt")).toBe("/tmp/ws/a.txt");
		expect(resolveInWorkspace(root, "teams/dino/README.md")).toBe("/tmp/ws/teams/dino/README.md");
		expect(resolveInWorkspace(root, "./a/../b.txt")).toBe("/tmp/ws/b.txt");
	});

	it("工作区根本身可以（列出目录时用得到）", () => {
		expect(resolveInWorkspace(root, ".")).toBe("/tmp/ws");
	});

	it("越界一律拒绝，不返回一个「差不多」的路径", () => {
		expect(resolveInWorkspace(root, "../etc/passwd")).toBeUndefined();
		expect(resolveInWorkspace(root, "/etc/passwd")).toBeUndefined();
		expect(resolveInWorkspace(root, "agents/../../x")).toBeUndefined();
	});

	it("同前缀的兄弟目录不算工作区内", () => {
		// `/tmp/ws-other` 以 `/tmp/ws` 开头，按字符串前缀判断会漏；必须比到分隔符。
		expect(resolveInWorkspace(root, "../ws-other/secret.txt")).toBeUndefined();
	});
});

describe("clip", () => {
	it("没超限就一个字不动", () => {
		const source = "短输出";
		expect(clip(source, 100)).toBe(source);
	});

	it("超限时留头留尾，并说清楚省略了多少", () => {
		const source = `${"头".repeat(500)}${"中".repeat(2000)}${"尾".repeat(500)}`;
		const clipped = clip(source, 1_000);
		expect(clipped.length).toBeLessThan(1_100);
		expect(clipped.startsWith("头")).toBe(true);
		// 尾巴必须保住：命令输出的结论（测试摘要、报错栈）都在结尾。
		expect(clipped.endsWith("尾")).toBe(true);
		expect(clipped).toContain("省略");
	});

	it("裁剪结果不会因为多次调用而继续塌缩", () => {
		const source = "x".repeat(10_000);
		const once = clip(source, 1_000);
		expect(clip(once, 1_000)).toBe(once);
	});
});
