/**
 * 网页服务的**装配与启动**：把用例层、投影层、路由表和 SSE 装起来，然后 listen。
 *
 * 这里只留三类东西，别的一律往外挪：
 * 1. 装配顺序（谁依赖谁）；
 * 2. 进程级的东西：端口、Host/Origin 闸、listen/close、启动横幅；
 * 3. 把兜不住的异常翻成 500。
 *
 * 业务在 `src/core/app/`，界面契约在 `src/core/view/`，HTTP 细节在
 * `src/core/interface/http/`。这一层不再认识「一条消息长什么样」。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { browserUrlOf, lanAddresses, lanUrlsOf } from "../interface/http/network.ts";
import { allowedHostsOf, hostAllowed, originAllowed, selfOriginsOf } from "../interface/http/guard.ts";
import { matchRoute } from "../interface/http/match.ts";
import { createStreamHub } from "../interface/http/hub.ts";
import { coreRoutes } from "../interface/http/routes.ts";
import { fail, statusOf } from "../interface/http/server.ts";
import { createApp } from "../app/index.ts";
import type { CoreShell } from "./assemble.ts";

/** 服务选项。 */
export type CoreServeOptions = {
	readonly shell: CoreShell;
	readonly port?: number;
	readonly host?: string;
	/** 静态资源目录（默认 `ui/web/`）。 */
	readonly uiDir?: string;
};

export type CoreServer = {
	readonly url: string;
	readonly port: number;
	readonly host: string;
	readonly lanUrls: readonly string[];
	close(): Promise<void>;
};

export async function serveCore(options: CoreServeOptions): Promise<CoreServer> {
	const shell = options.shell;
	const uiDir = options.uiDir ?? new URL("../../../ui/web", import.meta.url).pathname;

	let actualPort = options.port ?? 7788;
	const boundHost = options.host ?? "127.0.0.1";

	const app = createApp(shell);
	const hub = createStreamHub(shell, app.snapshots);
	const unsubscribe = hub.start();
	const routes = coreRoutes({ app, hub, uiDir });

	/**
	 * 允许的 Host 头。由**实际监听地址**推出，不是由「用户可能用什么地址打开」猜
	 * （规则与理由见 `interface/http/guard.ts`）。
	 */
	function hostsNow(): string[] {
		return allowedHostsOf({
			port: actualPort,
			boundHost,
			requestedHost: options.host,
			allowList: process.env.SOLO_ALLOWED_HOSTS,
			lan: lanAddresses,
		});
	}

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://localhost");
		const method = request.method ?? "GET";
		// 来源闸必须在**匹配路由之前**：不合法来源不该有机会碰到任何 handler（读也一样，
		// 读能泄露整个工作区）。见 `interface/http/guard.ts` 里对 DNS rebinding 的说明。
		const allowed = hostsNow();
		if (!hostAllowed(request.headers.host, allowed)) return fail(response, 403, "Host 不合法");
		if (
			method !== "GET" &&
			method !== "HEAD" &&
			!originAllowed(
				request.headers.origin,
				request.headers["sec-fetch-site"] as string | undefined,
				selfOriginsOf(allowed),
			)
		) {
			return fail(response, 403, "来源不合法");
		}
		const match = matchRoute(routes, method, url.pathname);
		if (match === undefined) return fail(response, 404, "没有这个接口");
		try {
			await match.route.handler({ request, response, url, path: url.pathname, method, params: match.params });
		} catch (error) {
			// 客户端发错（正文超限 / 声明不是 JSON）与用例拒绝（「找不到」「太多了」）都要给出
			// 自己的状态码 —— 一律 500 的话，前端与审计都无从判断。映射表在接口层。
			const mapped = statusOf(error);
			if (mapped !== undefined) return fail(response, mapped.status, mapped.message);
			throw error;
		}
	}

	const server = createServer((request, response) => {
		void handle(request, response).catch((error: unknown) => {
			if (!response.headersSent) fail(response, 500, error instanceof Error ? error.message : String(error));
			else response.end();
		});
	});

	// 启动时清一次上传孤儿（审计 P2-3）。失败只记一行，不影响启动。
	void app.uploads.sweep();

	if (process.env.SOLO_DEBUG_FROM === "1") {
		console.warn("[core] 警告：from 可伪造（SOLO_DEBUG_FROM=1），只用于本机调试");
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(actualPort, boundHost, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	actualPort = typeof address === "object" && address !== null ? address.port : actualPort;

	return {
		url: browserUrlOf(boundHost, actualPort),
		port: actualPort,
		host: boundHost,
		lanUrls: lanUrlsOf(boundHost, actualPort),
		async close() {
			unsubscribe();
			hub.close();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				setTimeout(resolve, 300);
			});
		},
	};
}
