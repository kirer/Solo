/**
 * 局域网地址推导 + IM 钩子纯函数的单元测试。
 */
import { describe, expect, test } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";
import {
	browserUrlOf,
	describeLanAccess,
	isLoopbackHost,
	isWildcardHost,
	lanAddresses,
	lanUrlsOf,
} from "../../src/server/network.ts";
import { composeInboundText, inboundAllowed, postOutbound } from "../../src/server/im.ts";

/** 造一份可控的网卡表（不依赖跑测试的机器）。 */
function interfacesOf(entries: { address: string; internal: boolean; family?: "IPv4" | "IPv6" }[]) {
	return {
		en0: entries.map((entry, index) => ({
			address: entry.address,
			netmask: "255.255.255.0",
			family: entry.family ?? ("IPv4" as const),
			mac: `00:00:00:00:00:0${index}`,
			internal: entry.internal,
			cidr: null,
			scopeid: 0,
		})) as unknown as NetworkInterfaceInfo[],
	};
}

describe("监听地址判定", () => {
	test("回环 / 通配地址识别", () => {
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("127.0.1.2")).toBe(true);
		expect(isLoopbackHost("0.0.0.0")).toBe(false);
		expect(isWildcardHost("0.0.0.0")).toBe(true);
		expect(isWildcardHost("::")).toBe(true);
		expect(isWildcardHost("192.168.1.10")).toBe(false);
	});

	test("监听 0.0.0.0 时列出全部非回环 IPv4，跳过回环与 IPv6", () => {
		const interfaces = interfacesOf([
			{ address: "127.0.0.1", internal: true },
			{ address: "192.168.1.71", internal: false },
			{ address: "10.0.0.8", internal: false },
			{ address: "fe80::1", internal: false, family: "IPv6" },
		]);
		expect(lanAddresses(interfaces)).toEqual(["192.168.1.71", "10.0.0.8"]);
		expect(lanUrlsOf("0.0.0.0", 7788, interfaces)).toEqual([
			"http://192.168.1.71:7788/",
			"http://10.0.0.8:7788/",
		]);
	});

	test("回环监听不输出连不上的局域网地址", () => {
		const interfaces = interfacesOf([{ address: "192.168.1.71", internal: false }]);
		expect(lanUrlsOf("127.0.0.1", 7788, interfaces)).toEqual([]);
	});

	test("指定具体网卡地址时只列它自己", () => {
		expect(lanUrlsOf("192.168.1.71", 7788)).toEqual(["http://192.168.1.71:7788/"]);
	});

	test("浏览器地址：0.0.0.0 退回 127.0.0.1", () => {
		expect(browserUrlOf("0.0.0.0", 7788)).toBe("http://127.0.0.1:7788/");
		expect(browserUrlOf("192.168.1.71", 7788)).toBe("http://192.168.1.71:7788/");
	});

	test("启动提示说清楚「未开启」和「没有局域网」", () => {
		expect(describeLanAccess("127.0.0.1", [])).toContain("--host 0.0.0.0");
		expect(describeLanAccess("0.0.0.0", [])).toContain("非回环 IPv4");
		expect(describeLanAccess("0.0.0.0", ["http://192.168.1.71:7788/"])).toContain("192.168.1.71");
	});
});

describe("IM 钩子", () => {
	const base = { enabled: true, outboundWebhook: "", inboundToken: "secret", accounts: [] };

	test("入站 token 校验：未启用 / 空 token / 不匹配都拒绝", () => {
		expect(inboundAllowed(base, "secret")).toBe(true);
		expect(inboundAllowed(base, "wrong")).toBe(false);
		expect(inboundAllowed({ ...base, enabled: false }, "secret")).toBe(false);
		expect(inboundAllowed({ ...base, inboundToken: "" }, "")).toBe(false);
	});

	test("入站文本带来源标记，便于 CEO 区分谁说的", () => {
		expect(composeInboundText("在吗")).toBe("[IM] 在吗");
		expect(composeInboundText("在吗", "微信")).toBe("[IM · 微信] 在吗");
		expect(composeInboundText("在吗", "  ")).toBe("[IM] 在吗");
	});

	test("出站 webhook 非法时静默跳过（不抛错）", () => {
		expect(() => postOutbound("", { text: "x", conversationId: 1, at: 0 })).not.toThrow();
		expect(() => postOutbound("ftp://nope", { text: "x", conversationId: 1, at: 0 })).not.toThrow();
	});
});
