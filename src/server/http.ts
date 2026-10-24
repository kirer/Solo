/**
 * 网页服务：HTTP + SSE。
 *
 * 设计取舍：
 * - 用 SSE 而不是 WebSocket：单向推送足够（老板的操作走普通 POST），
 *   实现简单、无依赖、断线自动重连。
 * - 组织快照用一次全局订阅 + 防抖重建，所有客户端共享，不会因为
 *   开了几个标签页就把数据库读爆。
 * - 会话流按客户端各自 watch，切换会话即停止，避免泄漏。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { BACKGROUND_CONTEXT } from "../runtime/index.ts";
import type { CompanyRuntime } from "../runtime/index.ts";
import { answerPending, listPending } from "../company/escalation.ts";
import { readCompany } from "../company/org.ts";
import { ROLE_LABELS, type ManagementRole } from "../company/docs.ts";
import { ROLE_DEFINITIONS } from "../company/roles.ts";
import { buildOrgView } from "./org-view.ts";
import { readFeed } from "./feed.ts";

/** 服务选项。 */
export type ServeOptions = {
	readonly runtime: CompanyRuntime;
	readonly port?: number;
	readonly host?: string;
	/** 静态资源目录（默认仓库根的 ui/）。 */
	readonly uiDir?: string;
};

/** 服务句柄。 */
export type Server = {
	readonly url: string;
	close(): Promise<void>;
};

/** MIME 表。 */
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
};

/** 启动服务。 */
export async function serve(options: ServeOptions): Promise<Server> {
	const { runtime } = options;
	const port = options.port ?? 7788;
	const host = options.host ?? "127.0.0.1";
	const uiDir = options.uiDir ?? join(process.cwd(), "ui");

	/** 组织快照的失效信号 + 防抖。 */
	let orgDirty = true;
	const orgClients = new Set<ServerResponse>();
	let orgTimer: NodeJS.Timeout | undefined;

	const scheduleOrgPush = (): void => {
		orgDirty = true;
		if (orgTimer !== undefined) return;
		orgTimer = setTimeout(() => {
			orgTimer = undefined;
			void pushOrg();
		}, 250);
	};

	const pushOrg = async (): Promise<void> => {
		if (!orgDirty || orgClients.size === 0) return;
		orgDirty = false;
		let payload: string;
		try {
			payload = JSON.stringify(await buildOrgView(runtime, BACKGROUND_CONTEXT));
		} catch (error) {
			payload = JSON.stringify({ error: String(error) });
		}
		for (const client of orgClients) {
			try {
				client.write(`event: org\ndata: ${payload}\n\n`);
			} catch {
				orgClients.delete(client);
			}
		}
	};

	// 任何提交都可能改变组织状态：订阅一次，全客户端共享
	const unsubscribe = runtime.harness.subscribeCommits(() => {
		scheduleOrgPush();
	});

	const server = createServer((request, response) => {
		void handle(request, response);
	});

	/** 路由。 */
	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
		const path = url.pathname;

		try {
			if (path === "/api/org") return json(response, await buildOrgView(runtime, BACKGROUND_CONTEXT));
			if (path === "/api/pending") {
				const state = await readCompany(runtime, BACKGROUND_CONTEXT);
				void state;
				return json(response, await listPending(runtime, BACKGROUND_CONTEXT));
			}
			if (path.startsWith("/api/feed/")) {
				const conversationId = Number(path.slice("/api/feed/".length));
				if (!Number.isFinite(conversationId)) return fail(response, 400, "会话标识不合法");
				const feed = await readFeed(runtime, conversationId, {}, BACKGROUND_CONTEXT);
				if (feed === undefined) return fail(response, 404, "会话不存在");
				return json(response, await decorateFeed(runtime, feed));
			}
			if (path.startsWith("/api/stream/org")) return streamOrg(response);
			if (path.startsWith("/api/stream/feed/")) {
				const conversationId = Number(path.slice("/api/stream/feed/".length));
				if (!Number.isFinite(conversationId)) return fail(response, 400, "会话标识不合法");
				return streamFeed(response, conversationId);
			}
			if (path === "/api/message" && request.method === "POST") return await postMessage(request, response);
			if (path === "/api/answer" && request.method === "POST") return await postAnswer(request, response);
			if (path === "/api/interrupt" && request.method === "POST") return await postInterrupt(request, response);

			// 静态资源
			return await serveStatic(response, uiDir, path);
		} catch (error) {
			return fail(response, 500, error instanceof Error ? error.message : String(error));
		}
	}

	/** 给 feed 补上标题、角色、种类、待拍板状态。 */
	async function decorateFeed(runtime: CompanyRuntime, feed: Awaited<ReturnType<typeof readFeed>>) {
		if (feed === undefined) return feed;
		const state = await readCompany(runtime, BACKGROUND_CONTEXT);
		const pending = await listPending(runtime, BACKGROUND_CONTEXT);
		const awaitingOwner = pending.some(
			(item) => item.level === "owner" && item.fromConversationId === feed.conversationId,
		);

		let title = "会话";
		let kind: "owner" | "role" | "project" | "staff" | "branch" = "branch";
		let role = "";

		const roleEntry = Object.entries(state?.roles ?? {}).find(([, id]) => id === feed.conversationId);
		if (roleEntry !== undefined) {
			const roleKey = roleEntry[0] as ManagementRole;
			title = ROLE_LABELS[roleKey] ?? roleKey.toUpperCase();
			kind = roleKey === "ceo" ? "owner" : "role";
			role =
				roleKey === "ceo"
					? "唯一真人 · 直接向你汇报"
					: `${ROLE_DEFINITIONS[roleKey]?.summary ?? ""} · 向 CEO 汇报`;
		}

		for (const project of Object.values(state?.projects ?? {})) {
			if (project.leader === feed.conversationId) {
				title = project.name;
				kind = "project";
				role = "项目负责人";
			}
		}
		for (const staff of Object.values(state?.staff ?? {})) {
			if (staff.conversationId === feed.conversationId) {
				title = staff.name;
				kind = "staff";
				role = `${staff.role} · ${staff.project} 项目 · 向 ${ROLE_LABELS[staff.manager]} 汇报`;
			}
		}

		return { ...feed, title, kind, role, awaitingOwner };
	}

	/** 组织快照的 SSE。 */
	function streamOrg(response: ServerResponse): void {
		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		response.write("retry: 1500\n\n");
		orgClients.add(response);

		// 首帧：立刻给一份，避免白屏等待
		void buildOrgView(runtime, BACKGROUND_CONTEXT).then((view) => {
			try {
				response.write(`event: org\ndata: ${JSON.stringify(view)}\n\n`);
			} catch {
				orgClients.delete(response);
			}
		});

		const keepAlive = setInterval(() => {
			try {
				response.write(": ping\n\n");
			} catch {
				clearInterval(keepAlive);
			}
		}, 15_000);

		response.on("close", () => {
			clearInterval(keepAlive);
			orgClients.delete(response);
		});
	}

	/** 单个会话流的 SSE。 */
	async function streamFeed(response: ServerResponse, conversationId: number): Promise<void> {
		const conversation = await runtime.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
		if (conversation === undefined) return fail(response, 404, "会话不存在");

		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		response.write("retry: 1500\n\n");

		let closed = false;
		/** 合并高频提交，避免 100ms 一次的重绘把浏览器压垮。 */
		let pendingTimer: NodeJS.Timeout | undefined;

		const push = async (): Promise<void> => {
			if (closed) return;
			try {
				const feed = await readFeed(runtime, conversationId, {}, BACKGROUND_CONTEXT);
				if (feed === undefined) return;
				const decorated = await decorateFeed(runtime, feed);
				response.write(`event: feed\ndata: ${JSON.stringify(decorated)}\n\n`);
			} catch {
				// 单次失败不关闭连接，等下一次
			}
		};

		await push();

		const watch = await conversation.watch(BACKGROUND_CONTEXT);
		watch.start(async () => {
			if (pendingTimer !== undefined) return;
			pendingTimer = setTimeout(() => {
				pendingTimer = undefined;
				void push();
			}, 150);
		});

		const keepAlive = setInterval(() => {
			try {
				response.write(": ping\n\n");
			} catch {
				/* 连接已断 */
			}
		}, 15_000);

		response.on("close", () => {
			closed = true;
			clearInterval(keepAlive);
			if (pendingTimer !== undefined) clearTimeout(pendingTimer);
			void watch.stop();
		});
	}

	/** 发消息。 */
	async function postMessage(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson<{ conversationId?: number; text?: string; mode?: "steer" | "followUp" }>(request);
		const conversationId = Number(body.conversationId);
		const text = (body.text ?? "").trim();
		if (!Number.isFinite(conversationId) || text === "") {
			return fail(response, 400, "需要 conversationId 与 text");
		}

		const conversation = await runtime.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
		if (conversation === undefined) return fail(response, 404, "会话不存在");

		// 默认 steer：会话忙时排在本轮工具之后，比 followUp（等整轮答完）早得多。
		// 老板的话不该排在最后。
		await conversation.submit(
			{ type: "input", content: text, whenBusy: body.mode ?? "steer" },
			BACKGROUND_CONTEXT,
		);
		scheduleOrgPush();
		return json(response, { ok: true });
	}

	/**
	 * 打断当前工作，立刻处理这条消息。
	 *
	 * 场景：CEO 正在等一个很慢的下属回复，老板发了一句急话。
	 * 光排队要等很久，所以这里先中断当前运行、清掉队列，再把消息重新投进去。
	 *
	 * 注意：中断会丢弃队列里的其它消息（底层语义如此）。只重投这一条。
	 */
	async function postInterrupt(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson<{ conversationId?: number; text?: string }>(request);
		const conversationId = Number(body.conversationId);
		const text = (body.text ?? "").trim();
		if (!Number.isFinite(conversationId) || text === "") {
			return fail(response, 400, "需要 conversationId 与 text");
		}

		const conversation = await runtime.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
		if (conversation === undefined) return fail(response, 404, "会话不存在");

		await conversation.abort(BACKGROUND_CONTEXT);
		await conversation.submit({ type: "input", content: text }, BACKGROUND_CONTEXT);
		scheduleOrgPush();
		return json(response, { ok: true });
	}

	/** 拍板：回答一条待决问题。 */
	async function postAnswer(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson<{ key?: string; text?: string }>(request);
		const key = (body.key ?? "").trim();
		const text = (body.text ?? "").trim();
		if (key === "" || text === "") return fail(response, 400, "需要 key 与 text");

		const ok = await answerPending(
			runtime,
			{ key, answer: text, answeredBy: "owner" },
			BACKGROUND_CONTEXT,
		);
		scheduleOrgPush();
		return json(response, { ok });
	}

	const listenHost = host;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, listenHost, () => {
			server.off("error", reject);
			resolve();
		});
	});

	// 端口为 0 时由系统分配，必须读实际监听的端口
	const address = server.address();
	const actualPort = typeof address === "object" && address !== null ? address.port : port;

	return {
		url: `http://${listenHost}:${actualPort}/`,
		async close() {
			unsubscribe();
			if (orgTimer !== undefined) clearTimeout(orgTimer);
			for (const client of orgClients) {
				try {
					client.end();
				} catch {
					/* 已断 */
				}
			}
			orgClients.clear();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				// 有 SSE 长连接时 close 不会立即回调
				setTimeout(resolve, 500);
			});
		},
	};
}

// ── 工具 ────────────────────────────────────────────────────────────────────

function json(response: ServerResponse, value: unknown): void {
	const payload = JSON.stringify(value);
	response.writeHead(200, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	response.end(payload);
}

function fail(response: ServerResponse, status: number, message: string): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify({ error: message }));
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return {} as T;
	return JSON.parse(text) as T;
}

/** 静态资源：限制在 uiDir 内，防目录穿越。 */
async function serveStatic(response: ServerResponse, uiDir: string, path: string): Promise<void> {
	const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
	const target = normalize(join(uiDir, relative));
	if (!target.startsWith(normalize(uiDir))) {
		return fail(response, 403, "禁止访问");
	}

	try {
		const content = await readFile(target);
		response.writeHead(200, {
			"Content-Type": MIME[extname(target)] ?? "application/octet-stream",
			"Cache-Control": "no-cache",
		});
		response.end(content);
	} catch {
		// SPA 回退：未知路径一律返回入口页
		try {
			const index = await readFile(join(uiDir, "index.html"));
			response.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
			response.end(index);
		} catch {
			fail(response, 404, "未找到");
		}
	}
}
