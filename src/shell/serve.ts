/**
 * 网页服务的**装配与启动**：把用例层、投影层、路由表和 SSE 装起来，然后 listen。
 *
 * 这里只留三类东西，别的一律往外挪：
 * 1. 装配顺序（谁依赖谁）；
 * 2. 进程级的东西：端口、Host/Origin 闸、listen/close、启动横幅；
 * 3. 把兜不住的异常翻成 500。
 *
 * 业务在 `src/app/`，界面契约在 `src/view/`，HTTP 细节在
 * `src/interface/http/`。这一层不再认识「一条消息长什么样」。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { browserUrlOf, lanAddresses, lanUrlsOf } from "../interface/http/network.ts";
import { allowedHostsOf, hostAllowed, originAllowed, selfOriginsOf } from "../interface/http/origin-guard.ts";
import { matchRoute } from "../interface/http/route-match.ts";
import { createStreamHub } from "../interface/http/sse.ts";
import { coreRoutes } from "../interface/http/routes.ts";
import { fail, statusOf } from "../interface/http/respond.ts";
import { createApp } from "../app/index.ts";
import { archiveGoneTeams } from "../core/channel/membership.ts";
import { mtimeOrUndefined } from "../core/runtime/io.ts";
import type { CoreShell } from "./assemble.ts";

/** 服务选项。 */
type CoreServeOptions = {
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

/**
 * 界面构建产物（`ui/web/`）的默认位置。
 *
 * 单独一个函数是为了能被单测钉住：本文件一搬家，层数就变，静态资源会静默 404
 * （服务起得来、接口正常，只有首页打不开）。
 */
export function defaultUiDir(): string {
	return new URL("../../ui/web", import.meta.url).pathname;
}

/**
 * 团队目录对账的间隔（毫秒）。
 *
 * 删团队目录（`run rm -rf`、Finder、改名）**不会产生任何文档提交**，启动时的
 * `archiveGoneTeams` 只兜得住重启。这里每隔两秒看一眼 `teams/` 的 mtime，变了才
 * 真去读 —— 常态成本只是一次 stat，删掉之后两秒内频道就归档并从列表消失。
 */
const TEAM_SWEEP_MS = 2_000;

/** 盯着 `teams/` 的 mtime，变了就把「目录没了」的团队频道归档。返回停止函数。 */
function startTeamSweep(shell: CoreShell): () => void {
	let stamp: number | undefined;
	let warned = "";
	const tick = async (): Promise<void> => {
		const next = (await mtimeOrUndefined(shell.layout.teamsRoot)) ?? -1;
		if (next === stamp) return;
		stamp = next;
		await archiveGoneTeams({ harness: shell.harness, layout: shell.layout });
	};
	const timer = setInterval(() => {
		void tick().catch((error: unknown) => {
			const text = error instanceof Error ? error.message : String(error);
			if (text === warned) return;
			warned = text;
			process.stderr.write(`[core] 团队对账失败：${text}\n`);
		});
	}, TEAM_SWEEP_MS);
	return () => clearInterval(timer);
}

export async function serveCore(options: CoreServeOptions): Promise<CoreServer> {
	const shell = options.shell;
	const uiDir = options.uiDir ?? defaultUiDir();

	let actualPort = options.port ?? 7788;
	const boundHost = options.host ?? "127.0.0.1";

	const app = createApp(shell);
	const hub = createStreamHub(shell, app.snapshots, app.read);
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
	// 后台命令的「跑完了」是进程内的回调：上一轮进程一起，结果就永远回不来了。
	// 重启时把账结掉，频道里留一句话（ADR-013）。
	void app.runs.sweep();
	// 看门狗：底座报上来的异常说进全员频道（只通报，不自动救）。
	app.watch.start();
	// 团队目录被删不会提交任何文档：运行时定期对账，别等重启。
	const stopTeamSweep = startTeamSweep(shell);

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
			app.watch.stop();
			stopTeamSweep();
			unsubscribe();
			hub.close();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				setTimeout(resolve, 300);
			});
		},
	};
}
