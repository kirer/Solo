/**
 * 网页服务：HTTP + SSE。
 *
 * 这是**外壳**，不是核心。核心（`src/core/**`）只有文件夹、频道、消息三样事实；
 * 这一层负责把它们翻译成浏览器能吃的 JSON，并处理一个 HTTP 服务该处理的杂事
 * （静态资源、压缩、SSE 心跳）。
 *
 * 路由只有 8 条，每条背后都是「读一份文档」或「写一条消息」。没有待办、任务、
 * 成本、升级链、看门狗、受理回执 —— 那些东西核心里一个都没有，所以这里也不该有。
 * 路径带 `:id` 的匹配器在 `./http/routes.ts`（纯函数，无业务概念）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { matchRoute, type Route } from "./http/routes.ts";
import {
	bodyFor,
	compressible,
	etagFor,
	loadAsset,
	matchesEtag,
	negotiateEncoding,
	notModifiedSince,
	type AssetEntry,
} from "./http/static-assets.ts";
import { browserUrlOf, lanUrlsOf } from "./http/network.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import { OWNER_SLUG } from "../agent/identity.ts";
import { listProjects } from "../project/doc.ts";
import { ChannelDoc, markRead, type ChannelState } from "../channel/state.ts";
import type { CoreShell } from "./assemble.ts";
import { channelDetail, channelList, orgView, withLabels } from "./view.ts";

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

/** 空频道状态（文档还没写过时用）。 */
function emptyChannels(): ChannelState {
	return { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
}

export async function serveCore(options: CoreServeOptions): Promise<CoreServer> {
	const shell = options.shell;
	const uiDir = options.uiDir ?? new URL("../../../ui/web", import.meta.url).pathname;
	const orgClients = new Set<ServerResponse>();
	let orgTimer: NodeJS.Timeout | undefined;

	/**
	 * 组织快照：名册 + 身份 + 频道 + 项目负责人表。界面的组织图与顶栏都吃这一份。
	 *
	 * 项目负责人的真相在 `projects/<slug>/README.md`，不在频道文档里。所以这里把它读成
	 * 一张 `project → owner` 的查表函数交给视图层 —— 视图层只做投影，不猜谁负责。
	 */
	async function snapshot(context: Context = BACKGROUND_CONTEXT) {
		const [identities, projects] = await Promise.all([shell.identities(), listProjects(shell.projectsRoot)]);
		const directory = withLabels(shell.bindings(), identities);
		const channels = (await shell.harness.snapshot(ChannelDoc, context)) ?? emptyChannels();
		const owners = new Map<string, string | undefined>(projects.map((project) => [project.slug, project.owner]));
		const projectOwnerOf = (project: string) => owners.get(project);
		return { identities, directory, channels, projectOwnerOf };
	}

	/** 向所有 SSE 连接推一份新快照（去抖：一次提交可能连带几次改动）。 */
	function scheduleOrg(): void {
		if (orgClients.size === 0) return;
		if (orgTimer !== undefined) return;
		orgTimer = setTimeout(() => {
			orgTimer = undefined;
			void pushOrg();
		}, 120);
	}

	async function pushOrg(): Promise<void> {
		if (orgClients.size === 0) return;
		let payload: string;
		try {
			const { identities, directory } = await snapshot();
			payload = `event: org\ndata: ${JSON.stringify(orgView(identities, directory))}\n\n`;
		} catch {
			return;
		}
		for (const client of [...orgClients]) {
			try {
				client.write(payload);
			} catch {
				orgClients.delete(client);
			}
		}
	}

	// 任何文档提交都推一次：新消息、新 agent、改名，界面都会跟着变。
	const unsubscribe = shell.harness.subscribeCommits(() => scheduleOrg());

	/** 老板在频道里说话。 */
	async function postChannelMessage(channelId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson<{ text?: string; replyTo?: number; from?: string; kind?: string }>(request);
		const text = (body.text ?? "").trim();
		if (text === "") return fail(response, 400, "需要 text");
		const channels = (await shell.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) ?? emptyChannels();
		if (channels.channels[channelId] === undefined) return fail(response, 404, "频道不存在");
		// 发件人：默认老板；带 `from` 时按 agent 处理（调试/脚本用，界面上永远不传）。
		const from = (body.from ?? "").trim() === "" ? OWNER_SLUG : (body.from as string).trim();
		try {
			const result = await shell.postAs({
				channelId,
				from,
				text,
				...(typeof body.replyTo === "number" ? { replyTo: body.replyTo } : {}),
				// 语义标签由说话的人自己声明：项目频道里带 `decision` 的话才会进项目记忆。
				...(typeof body.kind === "string" && body.kind !== "" ? { kind: body.kind } : {}),
			});
			scheduleOrg();
			return json(response, {
				ok: true,
				seq: result.seq,
				delivered: result.delivery.delivered,
				failed: result.delivery.failed,
			});
		} catch (error) {
			return fail(response, 500, error instanceof Error ? error.message : String(error));
		}
	}

	/** 新建频道（agent 自己也能建，这是宿主入口）。 */
	async function postChannel(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson<{ id?: string; title?: string; members?: string[] }>(request);
		const id = (body.id ?? "").trim();
		if (id === "") return fail(response, 400, "需要频道 id");
		const members = [...new Set([OWNER_SLUG, ...(body.members ?? [])])].filter((slug) => slug !== "");
		const { ensureChannel } = await import("../channel/state.ts");
		await shell.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			if (doc.channels[id] !== undefined) return;
			Object.assign(
				doc,
				ensureChannel(doc, { id, title: body.title ?? id, members, wakeOnAll: [], at: Date.now() }),
			);
		}, BACKGROUND_CONTEXT);
		scheduleOrg();
		return json(response, { ok: true, id });
	}

	const routes: readonly Route[] = [
		{
			pattern: "/api/stream/org",
			method: "GET",
			handler: ({ response }) => streamOrg(response),
		},
		{
			pattern: "/api/org",
			method: "GET",
			handler: async ({ response }) => {
				const { identities, directory } = await snapshot();
				return json(response, orgView(identities, directory));
			},
		},
		{
			pattern: "/api/channels",
			method: "GET",
			handler: async ({ response }) => {
				const { directory, channels, projectOwnerOf } = await snapshot();
				const list = channelList(channels, directory, OWNER_SLUG, projectOwnerOf);
				return json(response, {
					channels: list,
					unread: {
						total: list.reduce((sum, channel) => sum + channel.unread, 0),
						mentions: list.reduce((sum, channel) => sum + channel.mentions, 0),
					},
				});
			},
		},
		{
			pattern: "/api/channels",
			method: "POST",
			handler: ({ request, response }) => postChannel(request, response),
		},
		{
			pattern: "/api/channels/:id/mentionable",
			method: "GET",
			handler: async ({ response, params }) => {
				const { identities, directory, channels } = await snapshot();
				const channel = channels.channels[params.id ?? ""];
				if (channel === undefined) return json(response, { candidates: [] });
				// `title` 取自 `identity.md` 的 title（与团队视图同源），让 @ 浮窗显示
				// 「名字 / 职位 / @slug」三层，老板要的职位信息就在这里。
				const identityTitle = (slug: string): string => {
					const found = identities.find((item) => item.slug === slug);
					return found?.title ?? "";
				};
				return json(response, {
					candidates: channel.members
						.filter((slug) => slug !== OWNER_SLUG)
						.map((slug) => ({
							id: conversationIdOf(directory, slug),
							label: shell.labelOf(slug),
							slug,
							title: identityTitle(slug),
						})),
				});
			},
		},
		{
			pattern: "/api/channels/:id",
			method: "GET",
			handler: async ({ response, url, params }) => {
				const { directory, channels, projectOwnerOf } = await snapshot();
				const channel = channels.channels[params.id ?? ""];
				if (channel === undefined) return fail(response, 404, "频道不存在或无权查看");
				const limit = Number(url.searchParams.get("limit") ?? "");
				const before = Number(url.searchParams.get("before") ?? "");
				return json(
					response,
					channelDetail(channels, channel, directory, {
						projectOwnerOf,
						...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
						...(Number.isFinite(before) && before > 0 ? { before } : {}),
					}),
				);
			},
		},
		{
			pattern: "/api/channels/:id/messages",
			method: "POST",
			handler: ({ request, response, params }) => postChannelMessage(params.id ?? "", request, response),
		},
		{
			pattern: "/api/channels/:id/read",
			method: "POST",
			handler: async ({ request, response, params }) => {
				const id = params.id ?? "";
				const body = await readJson<{ seq?: number }>(request);
				if (typeof body.seq === "number") {
					await shell.harness.commit(async (tx) => {
						const doc = (await tx.doc(ChannelDoc)) as ChannelState;
						Object.assign(doc, markRead(doc, OWNER_SLUG, id, body.seq as number));
					}, BACKGROUND_CONTEXT);
				}
				return json(response, { ok: true });
			},
		},
		// 界面上还没有的入口，先明确 501，免得前端拿到 404 后误以为是「频道没了」。
		{
			pattern: "*rest",
			handler: async ({ request, response, path }) => {
				return await serveStatic(response, request, uiDir, path);
			},
		},
	];

	function streamOrg(response: ServerResponse): void {
		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		response.write("retry: 1500\n\n");
		orgClients.add(response);
		void pushOrg();
		const keepAlive = setInterval(() => {
			try {
				response.write(": ping\n\n");
			} catch {
				clearInterval(keepAlive);
				orgClients.delete(response);
			}
		}, 15_000);
		response.on("close", () => {
			clearInterval(keepAlive);
			orgClients.delete(response);
		});
	}

	const server = createServer((request, response) => {
		void handle(request, response).catch((error: unknown) => {
			if (!response.headersSent) fail(response, 500, error instanceof Error ? error.message : String(error));
			else response.end();
		});
	});

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://localhost");
		const match = matchRoute(routes, request.method ?? "GET", url.pathname);
		if (match === undefined) return fail(response, 404, "没有这个接口");
		await match.route.handler({
			request,
			response,
			url,
			path: url.pathname,
			method: request.method ?? "GET",
			params: match.params,
		});
	}

	let actualPort = options.port ?? 7788;
	let boundHost = options.host ?? "127.0.0.1";
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
				setTimeout(resolve, 300);
			});
		},
	};
}

/** slug → 界面用的数字 id（名册里没有给 -1）。 */
function conversationIdOf(directory: { slugToConversation: Record<string, number> }, slug: string): number {
	if (slug === OWNER_SLUG) return 0;
	return directory.slugToConversation[slug] ?? -1;
}

/** MIME 表（静态资源用；只列 `ui/` 里真正存在的类型）。 */
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".map": "application/json; charset=utf-8",
};

/**
 * 发静态资源：压缩 + 条件请求 + SPA 回退。
 *
 * 策略：入口页 `no-cache`（改了立刻生效）、其余资源 5 分钟缓存 + ETag 验证、
 * 文本资源按 `Accept-Encoding` 协商 br/gzip。
 */
async function serveStatic(
	response: ServerResponse,
	request: IncomingMessage,
	rootDir: string,
	path: string,
): Promise<void> {
	const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
	const root = normalize(rootDir);
	const target = normalize(join(rootDir, relative));
	if (target !== root && !target.startsWith(root + sep)) return fail(response, 403, "禁止访问");

	const asset: AssetEntry | undefined = await loadAsset(target);

	if (asset !== undefined) {
		return await sendAsset(response, request, asset, relative, MIME[extname(target)] ?? "application/octet-stream");
	}

	// SPA 回退只对页面路径生效：带扩展名的资源找不到就是 404，不能回 index.html
	// （否则浏览器把 HTML 当 JS 解析，报一堆莫名其妙的语法错误）。
	if (path.startsWith("/api/") || extname(path) !== "") return fail(response, 404, "未找到");
	const index = await loadAsset(join(rootDir, "index.html"));
	if (index === undefined) return fail(response, 404, "未找到");
	return await sendAsset(response, request, index, "index.html", MIME[".html"] ?? "text/html; charset=utf-8");
}

async function sendAsset(
	response: ServerResponse,
	request: IncomingMessage,
	asset: AssetEntry,
	relative: string,
	contentType: string,
): Promise<void> {
	const canCompress = compressible(contentType);
	const wanted = canCompress ? negotiateEncoding(request.headers["accept-encoding"]) : "identity";
	const { body, encoding } = await bodyFor(asset, wanted);
	const etag = etagFor(asset, encoding);
	const headers: Record<string, string> = {
		"Content-Type": contentType,
		"Cache-Control": relative === "index.html" ? "no-cache" : "public, max-age=300, must-revalidate",
		ETag: etag,
		"Last-Modified": asset.lastModified,
	};
	if (canCompress) headers.Vary = "Accept-Encoding";
	const ifNoneMatch = request.headers["if-none-match"];
	const fresh =
		ifNoneMatch === undefined
			? notModifiedSince(request.headers["if-modified-since"], asset.lastModified)
			: matchesEtag(ifNoneMatch, etag);
	if (fresh) {
		response.writeHead(304, headers);
		response.end();
		return;
	}
	if (encoding !== "identity") headers["Content-Encoding"] = encoding;
	headers["Content-Length"] = String(body.length);
	response.writeHead(200, headers);
	response.end(body);
}

function json(response: ServerResponse, value: unknown): void {
	const body = JSON.stringify(value);
	response.writeHead(200, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(body),
	});
	response.end(body);
}

function fail(response: ServerResponse, status: number, message: string): void {
	if (response.headersSent) {
		response.end();
		return;
	}
	const body = JSON.stringify({ error: message });
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(body),
	});
	response.end(body);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") return {} as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		return {} as T;
	}
}
