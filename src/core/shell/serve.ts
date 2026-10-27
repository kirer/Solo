/**
 * 网页服务（世代 2）：HTTP + SSE。
 *
 * 这是**外壳**，不是核心。核心（`src/core/**`）只有文件夹、频道、消息三样事实；
 * 这一层负责把它们翻译成浏览器能吃的 JSON，并处理一个 HTTP 服务该处理的杂事
 * （静态资源、压缩、SSE 心跳）。
 *
 * 为什么单独写一份而不是复用 `src/server/http.ts`：旧文件里有 1900 行是为了旧核心的
 * 业务概念（待办、任务、成本、升级链、看门狗、受理回执）服务的，新核心里这些东西
 * 一个都没有。硬塞进去的结果是每个路由里一半的分支都在写 `if` 兜旧字段。
 *
 * 路由表用 `src/server/routes.ts` 的匹配器 —— 那是纯函数，没有业务概念，可以直接
 * 跨世代复用。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { matchRoute, type Route } from "../../server/routes.ts";
import {
	bodyFor,
	compressible,
	etagFor,
	loadAsset,
	matchesEtag,
	negotiateEncoding,
	notModifiedSince,
	type AssetEntry,
} from "../../server/static-assets.ts";
import { avatarSvg } from "../../server/avatars.ts";
import { browserUrlOf, lanUrlsOf } from "../../server/network.ts";
import { resolveStaticRoot } from "../../server/static-root.ts";
import { openSettings, type SettingsStore } from "../../server/settings.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import type { ModelSetup } from "../../runtime/models.ts";
import { OWNER_SLUG } from "../agent/identity.ts";
import { ChannelDoc, markRead, type ChannelState } from "../channel/state.ts";
import type { CoreShell } from "./assemble.ts";
import { actorProfile, channelDetail, channelList, messageView, orgView, withLabels } from "./view.ts";

/** 服务选项。 */
export type CoreServeOptions = {
	readonly shell: CoreShell;
	readonly models?: ModelSetup;
	readonly port?: number;
	readonly host?: string;
	/** 静态资源目录（默认仓库根的 `ui/`）。 */
	readonly uiDir?: string;
	/** 工作空间根目录（`settings.json` 在这里）。 */
	readonly workspace?: string;
	readonly settings?: SettingsStore;
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
	const uiDir = options.uiDir ?? new URL("../../../ui", import.meta.url).pathname;
	const settingsStore =
		options.settings ?? openSettings({ workspace: options.workspace ?? join(process.cwd(), "workspace") });

	const orgClients = new Set<ServerResponse>();
	let orgTimer: NodeJS.Timeout | undefined;

	/** 组织快照：名册 + 身份 + 频道。界面的组织图与顶栏都吃这一份。 */
	async function snapshot(context: Context = BACKGROUND_CONTEXT) {
		const identities = await shell.identities();
		const directory = withLabels(shell.bindings(), identities);
		const channels = (await shell.harness.snapshot(ChannelDoc, context)) ?? emptyChannels();
		return { identities, directory, channels };
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
				const { directory, channels } = await snapshot();
				const list = channelList(channels, directory);
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
				const { directory, channels } = await snapshot();
				const channel = channels.channels[params.id ?? ""];
				if (channel === undefined) return json(response, { candidates: [] });
				return json(response, {
					candidates: channel.members
						.filter((slug) => slug !== OWNER_SLUG)
						.map((slug) => ({ id: conversationIdOf(directory, slug), label: shell.labelOf(slug), slug })),
				});
			},
		},
		{
			pattern: "/api/channels/:id",
			method: "GET",
			handler: async ({ response, url, params }) => {
				const { directory, channels } = await snapshot();
				const channel = channels.channels[params.id ?? ""];
				if (channel === undefined) return fail(response, 404, "频道不存在或无权查看");
				const limit = Number(url.searchParams.get("limit") ?? "");
				const before = Number(url.searchParams.get("before") ?? "");
				return json(
					response,
					channelDetail(channels, channel, directory, {
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
		{
			pattern: "/api/profile/:conversationId",
			method: "GET",
			handler: async ({ response, params }) => {
				const { identities, directory } = await snapshot();
				const slug = directory.conversationToSlug[params.conversationId ?? ""];
				const identity = identities.find((item) => item.slug === slug);
				if (identity === undefined) return fail(response, 404, "暂无档案");
				const registered = shell.registry.snapshot().tools().map((item) => item.tool.name);
				const profile = await actorProfile(shell.agentsRoot, identity, identities, "", registered);
				return json(response, { ...profile, conversationId: conversationIdOf(directory, identity.slug) });
			},
		},
		{
			pattern: "/api/settings",
			method: "GET",
			handler: async ({ response }) => json(response, await settingsView()),
		},
		{
			pattern: "/api/models",
			handler: ({ response }) => fail(response, 405, "新核心的模型设置只读（改 workspace/settings.json 后重启）"),
		},
		{
			pattern: "/api/avatar/:seed",
			method: "GET",
			handler: ({ response, url, params }) => {
				const size = Number(url.searchParams.get("size") ?? "64");
				const svg = avatarSvg(decodeURIComponent(params.seed ?? ""), Number.isFinite(size) ? size : 64);
				response.writeHead(200, {
					"Content-Type": "image/svg+xml; charset=utf-8",
					"Cache-Control": "public, max-age=86400",
				});
				response.end(svg);
			},
		},
		// 界面上还没有的入口，先明确 501，免得前端拿到 404 后误以为是「频道没了」。
		{
			pattern: "/api/board",
			method: "GET",
			handler: ({ response }) =>
				json(response, { columns: [], meta: { serverNow: Date.now(), source: "core" } }),
		},
		{
			pattern: "*rest",
			handler: async ({ request, response, path }) => {
				const choice = await resolveStaticRoot(uiDir);
				const dirs = choice.kind === "dist" ? [choice.dir, uiDir] : [uiDir];
				return await serveStatic(response, request, uiDir, path, dirs);
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

	async function settingsView() {
		const settings = await settingsStore.read();
		const lanUrls = lanUrlsOf(boundHost, actualPort);
		const catalog = options.models?.catalog ?? [];
		const builtin = options.models?.builtinCatalog ?? catalog;
		const defaultId =
			options.models === undefined ? "" : `${options.models.defaultModel.provider}/${options.models.defaultModel.modelId}`;
		return {
			network: { port: actualPort, host: boundHost, lanUrls, url: browserUrlOf(boundHost, actualPort) },
			models: {
				default: defaultId,
				catalog: (builtin.length > 0 ? builtin : catalog).map((item) => ({
					id: item.id,
					name: item.label,
					provider: item.provider,
					source: "builtin" as const,
				})),
				restartRequired: settings.models.default !== "" && settings.models.default !== defaultId,
			},
		};
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
 * 与旧服务同一套策略（缓存分两档、ETag、br/gzip 协商），因为浏览器已经在那套
 * 语义上被调好了：入口页 `no-cache` 保证发版立刻生效，其余资源 5 分钟缓存 +
 * ETag 验证。
 */
async function serveStatic(
	response: ServerResponse,
	request: IncomingMessage,
	rootDir: string,
	path: string,
	dirs: readonly string[],
): Promise<void> {
	const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
	const root = normalize(rootDir);
	const resolveIn = (dir: string) => normalize(join(dir, relative));

	const probe = resolveIn(dirs[0] ?? rootDir);
	if (probe !== root && !probe.startsWith(root + sep)) return fail(response, 403, "禁止访问");

	let target = probe;
	let asset: AssetEntry | undefined;
	for (const dir of dirs) {
		const candidate = resolveIn(dir);
		if (candidate !== root && !candidate.startsWith(root + sep)) continue;
		const found = await loadAsset(candidate);
		if (found !== undefined) {
			target = candidate;
			asset = found;
			break;
		}
	}

	if (asset !== undefined) {
		return await sendAsset(response, request, asset, relative, MIME[extname(target)] ?? "application/octet-stream");
	}

	// SPA 回退只对页面路径生效：带扩展名的资源找不到就是 404，不能回 index.html
	// （否则浏览器把 HTML 当 JS 解析，报一堆莫名其妙的语法错误）。
	if (path.startsWith("/api/") || extname(path) !== "") return fail(response, 404, "未找到");
	let index: AssetEntry | undefined;
	for (const dir of dirs) {
		index = await loadAsset(join(dir, "index.html"));
		if (index !== undefined) break;
	}
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
