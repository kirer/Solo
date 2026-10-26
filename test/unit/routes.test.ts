/**
 * 路由匹配器的测试。
 *
 * 这里刻意测的是**匹配语义**而不是「某个端点返回什么」：后者由
 * `test/e2e/platform-api.test.ts` 覆盖。匹配器出错的表现是「某个端点
 * 悄悄变成 404」，而那类回归只在真机点页面时才发现，代价很高。
 */
import { describe, expect, test } from "vitest";
import { matchRoute, type Route } from "../../src/server/routes.ts";

const handler = (): void => undefined;

function routes(): readonly Route[] {
	return [
		{ pattern: "/api/org", method: "GET", handler },
		{ pattern: "/api/models", method: "POST", handler },
		{ pattern: "/api/models", method: ["PATCH", "PUT"], handler },
		{ pattern: "/api/models", method: "DELETE", handler },
		{ pattern: "/api/models", handler },
		{ pattern: "/api/channels", method: "GET", handler },
		{ pattern: "/api/channels/:id/mentionable", method: "GET", handler },
		{ pattern: "/api/channels/:id/read", method: "POST", handler },
		{ pattern: "/api/channels/:id/messages", method: "POST", handler },
		{ pattern: "/api/channels/:id", method: "GET", handler },
		{ pattern: "/uploads/*rest", handler },
		{ pattern: "*rest", handler },
	];
}

const indexOf = (method: string, path: string): number | undefined => {
	const match = matchRoute(routes(), method, path);
	if (match === undefined) return undefined;
	const label = `${match.route.pattern}#${String(match.route.method ?? "*")}`;
	return routes().findIndex((route) => `${route.pattern}#${String(route.method ?? "*")}` === label);
};

describe("字面量路径", () => {
	test("方法与路径都命中", () => {
		expect(indexOf("GET", "/api/org")).toBe(0);
	});

	test("方法是**精确**比较（大小写不同不算）", () => {
		// 精确比较的意义：`get` 不该被当成 `GET`。这里落到全局兜底而不是报错，
		// 因为 `*rest` 不声明 method。真正的 405 由同路径的兜底路由负责。
		expect(indexOf("get", "/api/models")).toBe(4);
	});

	test("尾部斜杠等价", () => {
		expect(indexOf("GET", "/api/org/")).toBe(0);
	});

	test("路径长一段不算命中", () => {
		// 落到 `*rest` 而不是 `/api/org`
		expect(indexOf("GET", "/api/org/x")).toBe(routes().length - 1);
	});
});

describe("同路径不同方法", () => {
	test("POST 命中 POST 那条", () => {
		expect(indexOf("POST", "/api/models")).toBe(1);
	});

	test("PATCH 与 PUT 共用一条", () => {
		expect(indexOf("PATCH", "/api/models")).toBe(2);
		expect(indexOf("PUT", "/api/models")).toBe(2);
	});

	test("DELETE 命中自己那条", () => {
		expect(indexOf("DELETE", "/api/models")).toBe(3);
	});

	test("方法都不对时落到无 method 的兜底（给 405 而不是 404）", () => {
		expect(indexOf("GET", "/api/models")).toBe(4);
	});
});

describe("参数与通配", () => {
	test("`:id` 捕获一段", () => {
		const match = matchRoute(routes(), "GET", "/api/channels/dm:161");
		expect(match?.params.id).toBe("dm:161");
	});

	test("具体的写在通配前面才不会被抢走", () => {
		// `/mentionable` 必须命中那条专用的，而不是 `/api/channels/:id`
		expect(indexOf("GET", "/api/channels/dm:161/mentionable")).toBe(6);
		expect(indexOf("GET", "/api/channels/dm:161")).toBe(9);
	});

	test("`decodeURIComponent` 对中文频道 id 生效", () => {
		const match = matchRoute(routes(), "GET", `/api/channels/${encodeURIComponent("proj:坦克")}`);
		expect(match?.params.id).toBe("proj:坦克");
	});

	test("非法百分号编码原样返回，不抛", () => {
		const match = matchRoute(routes(), "GET", "/api/channels/%zz");
		expect(match?.params.id).toBe("%zz");
	});

	test("`*rest` 吃掉剩余全部（含斜杠）", () => {
		const match = matchRoute(routes(), "GET", "/uploads/abc123/%E6%96%87%E4%BB%B6.txt");
		expect(match?.params.rest).toBe("abc123/%E6%96%87%E4%BB%B6.txt");
	});

	test("`*rest` 也能匹配空尾巴", () => {
		// `/uploads` 少了最后一段，通配吃空串——`serveUpload` 会因此报 404，
		// 这是对的：`/uploads` 本身不是一个附件。
		const match = matchRoute(routes(), "GET", "/uploads");
		expect(match?.route.pattern).toBe("/uploads/*rest");
		expect(match?.params.rest).toBe("");
	});
});

describe("兜底", () => {
	test("任何路径都有兜底，不会 undefined", () => {
		expect(indexOf("GET", "/whatever/deep/path.css")).toBe(routes().length - 1);
	});

	test("空表返回 undefined（调用方给 404）", () => {
		expect(matchRoute([], "GET", "/api/org")).toBeUndefined();
	});
});
