/**
 * 来源闸：谁能写这个服务。
 *
 * 两种断言分开写：
 * - 纯函数（`hostAllowed` / `originAllowed`）—— 判据本身，最便宜也最该被钉住的；
 * - 真 HTTP（`serveCore({ port: 0 })`）—— 判据有没有真的接在请求入口上。
 *   只测纯函数的话，函数再对、`handle()` 忘了调用也是全绿。
 */
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostAllowed, originAllowed } from "../../src/interface/http/origin-guard.ts";
import type { CoreShell } from "../../src/shell/assemble.ts";
import { serveCore, type CoreServer } from "../../src/shell/serve.ts";
import { sandboxPool } from "./support.ts";

const SELF = ["http://127.0.0.1:7788", "http://localhost:7788"];

describe("hostAllowed：Host 头必须是本服务自己", () => {
	it("合法：监听地址的几种写法都认，大小写与末尾点不影响", () => {
		expect(hostAllowed("127.0.0.1:7788", SELF.map((item) => item.slice("http://".length)))).toBe(true);
		expect(hostAllowed("LOCALHOST:7788", ["localhost:7788"])).toBe(true);
		expect(hostAllowed("localhost.:7788", ["localhost:7788"])).toBe(true);
	});

	it("非法：别的域名、别的端口、缺失、空串都不认（DNS rebinding 就靠这一条拦）", () => {
		const allowed = ["127.0.0.1:7788", "localhost:7788"];
		expect(hostAllowed("evil.example:7788", allowed)).toBe(false);
		expect(hostAllowed("127.0.0.1:7789", allowed)).toBe(false);
		expect(hostAllowed(undefined, allowed)).toBe(false);
		expect(hostAllowed("", allowed)).toBe(false);
	});
});

describe("originAllowed：写请求的来源", () => {
	it("同源放行", () => {
		expect(originAllowed("http://127.0.0.1:7788", undefined, SELF)).toBe(true);
		expect(originAllowed("http://LOCALHOST:7788", undefined, SELF)).toBe(true);
	});

	it("跨源与 null 拒绝（沙箱 iframe / file:// 页面都是 null）", () => {
		expect(originAllowed("http://evil.example", undefined, SELF)).toBe(false);
		expect(originAllowed("http://127.0.0.1:7789", undefined, SELF)).toBe(false);
		expect(originAllowed("null", undefined, SELF)).toBe(false);
	});

	it("Origin 缺失时看 Sec-Fetch-Site：同源/无标头放行，跨站拒绝", () => {
		expect(originAllowed(undefined, "same-origin", SELF)).toBe(true);
		expect(originAllowed(undefined, "none", SELF)).toBe(true);
		expect(originAllowed(undefined, undefined, SELF)).toBe(true); // curl / 脚本
		expect(originAllowed(undefined, "cross-site", SELF)).toBe(false);
		expect(originAllowed(undefined, "same-site", SELF)).toBe(false);
	});
});

const pool = sandboxPool();
const servers: CoreServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close().catch(() => undefined);
	await pool.cleanup();
});

async function setup(): Promise<{ shell: CoreShell; port: number; root: string; layout: import("../../src/core/layout.ts").Layout }> {
	const box = await pool.make("core-http-guard-");
	const runtime = await box.open();
	const shell = await box.assemble(runtime, { defaultModel: { provider: "test", modelId: "test" } });
	const server = await serveCore({ shell, port: 0 });
	servers.push(server);
	return { shell, port: server.port, root: box.root, layout: box.layout };
}

/** 原始 http 请求：需要自己写 Host / Origin / Sec-Fetch-Site，fetch 不让设这些。 */
function call(
	port: number,
	options: { method?: string; path: string; host?: string; origin?: string; fetchSite?: string; type?: string; body?: string },
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port,
				method: options.method ?? "GET",
				path: options.path,
				headers: {
					...(options.host === undefined ? {} : { host: options.host }),
					...(options.origin === undefined ? {} : { origin: options.origin }),
					...(options.fetchSite === undefined ? {} : { "sec-fetch-site": options.fetchSite }),
					...(options.type === undefined ? {} : { "content-type": options.type }),
				},
			},
			(response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					body += chunk;
				});
				response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
			},
		);
		req.on("error", reject);
		req.end(options.body);
	});
}

describe("来源闸接在请求入口上（真 HTTP）", () => {
	it("跨源 Origin 的写请求 403，且消息没落库", async () => {
		const { shell, port } = await setup();
		const blocked = await call(port, {
			method: "POST",
			path: "/api/channels/all/messages",
			origin: "http://evil.example",
			type: "application/json",
			body: JSON.stringify({ text: "所有人停下" }),
		});
		expect(blocked.status).toBe(403);
		// 闸在 handler 之前：消息一条都不该落库。
		const state = await shell.channels();
		expect(state.messages.all ?? []).toHaveLength(0);
	});

	it("Host 不是本服务的读请求也 403（DNS rebinding 走的是读）", async () => {
		const { port } = await setup();
		const blocked = await call(port, { path: "/api/org", host: "evil.example:7788" });
		expect(blocked.status).toBe(403);
	});

	it("同源写请求正常通过", async () => {
		const { port } = await setup();
		const ok = await call(port, {
			method: "POST",
			path: "/api/channels/all/messages",
			origin: `http://127.0.0.1:${port}`,
			type: "application/json",
			body: JSON.stringify({ text: "在" }),
		});
		expect(ok.status).toBe(200);
	});

	it("表单式绕过（text/plain 正文）415", async () => {
		const { port } = await setup();
		const rejected = await call(port, {
			method: "POST",
			path: "/api/channels/all/messages",
			type: "text/plain",
			body: JSON.stringify({ text: "x" }),
		});
		expect(rejected.status).toBe(415);
	});

	it("没有正文的 POST（脚本点已读）不需要 content-type", async () => {
		const { port } = await setup();
		const ok = await call(port, { method: "POST", path: "/api/channels/all/read", body: "" });
		expect(ok.status).toBe(200);
	});
});

describe("① 隧道域名口子：SOLO_ALLOWED_HOSTS", () => {
	it("默认不认隧道域名，配了环境变量才放行（端口按当前端口补）", async () => {
		const { port } = await setup();
		expect((await call(port, { path: "/api/org", host: `tunnel.example:${port}` })).status).toBe(403);
		process.env.SOLO_ALLOWED_HOSTS = "tunnel.example, other.example:9999";
		try {
			expect((await call(port, { path: "/api/org", host: `tunnel.example:${port}` })).status).toBe(200);
			// 显式写了端口的条目按原样认（隧道常常就是另一个端口）。
			expect((await call(port, { path: "/api/org", host: "other.example:9999" })).status).toBe(200);
			// 没在清单里的域名照旧拒。
			expect((await call(port, { path: "/api/org", host: "evil.example:9999" })).status).toBe(403);
		} finally {
			delete process.env.SOLO_ALLOWED_HOSTS;
		}
	});

	it("https 的 Origin（隧道页面）也放行，未登记域名仍 403", async () => {
		const { port } = await setup();
		process.env.SOLO_ALLOWED_HOSTS = "tunnel.example";
		try {
			// cloudflared 转过来：Host 不带端口，Origin 是 https 且省掉 443。
			const ok = await call(port, {
				method: "POST",
				path: "/api/channels/all/messages",
				host: "tunnel.example",
				origin: "https://tunnel.example",
				type: "application/json",
				body: JSON.stringify({ text: "从隧道发" }),
			});
			expect(ok.status).toBe(200);
			const blocked = await call(port, {
				method: "POST",
				path: "/api/channels/all/messages",
				host: "tunnel.example",
				origin: "https://evil.example",
				type: "application/json",
				body: JSON.stringify({ text: "x" }),
			});
			expect(blocked.status).toBe(403);
		} finally {
			delete process.env.SOLO_ALLOWED_HOSTS;
		}
	});
});

describe("② 发消息的 from 默认只认我", () => {
	it("请求里写 from 不生效，落库的是 owner", async () => {
		const { shell, port } = await setup();
		const sent = await call(port, {
			method: "POST",
			path: "/api/channels/all/messages",
			type: "application/json",
			body: JSON.stringify({ text: "所有人停下", from: "知言" }),
		});
		expect(sent.status).toBe(200);
		const state = await shell.channels();
		const last = (state.messages.all ?? []).at(-1);
		expect(last?.from).toBe("owner");
	});

});

describe("③ 已读位置夹到上界（越界请求不能把以后的消息都吃掉）", () => {
	it("seq=999999 之后来一条新消息，未读仍然是 1", async () => {
		const { shell, port } = await setup();
		await call(port, {
			method: "POST",
			path: "/api/channels/all/messages",
			type: "application/json",
			body: JSON.stringify({ text: "第一条" }),
		});
		await call(port, { method: "POST", path: "/api/channels/all/read", type: "application/json", body: JSON.stringify({ seq: 999_999 }) });
		await call(port, {
			method: "POST",
			path: "/api/channels/all/messages",
			type: "application/json",
			body: JSON.stringify({ text: "新的" }),
		});
		// 已读标记只能落在「当时最后一条」，不能被 999999 直接吃掉。
		const state = await shell.channels();
		expect(state.readMarks.owner?.all).toBe(1);
	});
});

describe("④ 正文限长与诊断落盘", () => {
	it("2MB 的 JSON 正文 413，不写成 500", async () => {
		const { port } = await setup();
		const huge = JSON.stringify({ kind: "x", entries: "A".repeat(2_000_000) });
		const rejected = await call(port, { method: "POST", path: "/api/diag", type: "application/json", body: huge });
		expect(rejected.status).toBe(413);
	});

	it("空正文的跨站诊断写入也 415（没有正文也有副作用）", async () => {
		const { port } = await setup();
		const rejected = await call(port, { method: "POST", path: "/api/diag", type: "text/plain", body: "" });
		expect(rejected.status).toBe(415);
	});

	it("正常大小的诊断条目落盘，entries 超 4KB 会被截断", async () => {
		const { port, layout } = await setup();
		const ok = await call(port, {
			method: "POST",
			path: "/api/diag",
			type: "application/json",
			body: JSON.stringify({ kind: "jank", entries: "B".repeat(9000) }),
		});
		expect(ok.status).toBe(200);
		const { readFile } = await import("node:fs/promises");
		const line = (await readFile(join(layout.logsRoot, "jank.jsonl"), "utf8")).trim();
		const entry = JSON.parse(line) as { entries: string };
		expect(entry.entries.length).toBeLessThan(4200);
		expect(entry.entries.endsWith("[截断]")).toBe(true);
	});
});
