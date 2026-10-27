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
import {  } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import {
	type AssetEntry,
	bodyFor,
	compressible,
	etagFor,
	loadAsset,
	matchesEtag,
	negotiateEncoding,
	notModifiedSince,
} from "./static-assets.ts";
import { BACKGROUND_CONTEXT, inspectLiveness, isConversationBusy } from "../runtime/index.ts";
import type { CompanyRuntime } from "../runtime/index.ts";
import type { ModelSetup } from "../runtime/models.ts";
import { CompanyDoc } from "../company/docs.ts";
import { answerPending, disposePending, listPending, PendingDoc, takeOverPendingAtCeo } from "../company/escalation.ts";
import { settleDisposition } from "../company/disposition.ts";
import { startCompanyWatchdog } from "../company/org.ts";
import {  } from "../company/wait.ts";
import { buildOrgView } from "./org-view.ts";
import { matchRoute, type Route } from "./routes.ts";
import { readStaffActivity } from "./activity.ts";
import { readProfile } from "./profile.ts";
import { buildBoardView } from "./board.ts";
import {
	buildSettingsView,
	openSettings,
	SettingsConflictError,
	SettingsInputError,
	type ModelCatalogEntry,
	type SettingsStore,
	type SettingsView,
} from "./settings.ts";
import { resolveStaticRoot } from "./static-root.ts";
import { browserUrlOf, lanUrlsOf } from "./network.ts";
import { listChannels, mentionCandidates, readChannelView, unreadSummary } from "./channels-view.ts";
import { markAllRead, markChannelRead, markMentionSeen, parseMentions, postToChannel, readChannel  } from "../company/channels.ts";
import { OWNER_ID, type Channel } from "../domain/channels.ts";
import { ownerOfChannel } from "../domain/membership.ts";
import { buildOrg } from "../company/org-model.ts";
import { avatarEtag, avatarSvg } from "./avatars.ts";

/** 服务选项。 */
export type ServeOptions = {
	/**
	 * 运行时，或返回当前运行时的 getter。
	 *
	 * **长跑的服务请传 getter**：崩溃自愈（`watchForFailure`）会 `openCompany()`
	 * 打开一个**新对象**，把实例钉死在闭包里会让看门狗、SSE 推送、所有请求
	 * 在自愈之后继续对着已关闭的运行时干活（表现为「自愈后整个界面不动了」）。
	 */
	readonly runtime: CompanyRuntime | (() => CompanyRuntime);
	readonly port?: number;
	readonly host?: string;
	/** 静态资源目录（默认仓库根的 ui/）。 */
	readonly uiDir?: string;
	/**
	 * 是否启动看门狗（契约 §5.2）。默认启动。
	 *
	 * 放在这里而不是 `bootstrapCompany`：看门狗会主动 abort 任务、投递排队消息，
	 * 只应该由「真的在跑服务」的入口拥有。测试想完全掌控调度时传 `false`。
	 */
	readonly watchdog?: boolean;
	/**
	 * 工作空间根目录（默认 `<cwd>/workspace`）。
	 *
	 * 设置文件（settings.json）在这里；测试必须传临时目录，
	 * 绝不能落到真实 workspace。
	 */
	readonly workspace?: string;
	/** 启动时装配好的模型集合；设置页需要它列出内置模型与默认模型。 */
	readonly models?: ModelSetup;
	/** 注入设置存储（测试用）；默认按 workspace 打开。 */
	readonly settings?: SettingsStore;
};

/** 服务句柄。 */
export type Server = {
	/** 浏览器应打开的地址（监听 0.0.0.0 时是 127.0.0.1）。 */
	readonly url: string;
	/** 实际监听端口。 */
	readonly port: number;
	/** 实际监听地址。 */
	readonly host: string;
	/** 局域网里可访问的地址（回环监听时为空）。 */
	readonly lanUrls: readonly string[];
	close(): Promise<void>;
};

/**
 * 文本类附件内联摘录的上限字节数。
 *
 * 8KB ≈ 2k token，足够模型看懂一份小文本/一段 CSV 的开头，又不至于把上下文塞满。
 * 超过就截断并在正文里标注「前 8KB」，让模型知道后面还有内容。
 */

/**
 * 哪些扩展名算「文本类」。
 *
 * 只认明确的白名单：图片、压缩包、pdf 之类塞进上下文只会变成乱码 token，
 * 既费钱又误导模型，所以一律不做内联摘录（只给路径，交给工具/视觉模型）。
 */

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
	// 每次取最新的运行时：自愈会换对象，闭包里不能存实例
	const current = (): CompanyRuntime =>
		typeof options.runtime === "function" ? options.runtime() : options.runtime;
	const port = options.port ?? 7788;
	const host = options.host ?? "127.0.0.1";
	const uiDir = options.uiDir ?? join(process.cwd(), "ui");
	// 静态目录可能随构建/改源码切换（dist ↔ source）。
	// 每请求走一次递归 stat 太贵，这里的取舍是「最多 2 秒后才看到切换」——
	// 改完源码刷刷新最多多试一次，远比每请求 24 次 stat 便宜。
	let staticRootCache: { choice: Awaited<ReturnType<typeof resolveStaticRoot>>; until: number } | undefined;
	const staticRoot = async () => {
		const now = Date.now();
		if (staticRootCache !== undefined && staticRootCache.until > now) return staticRootCache.choice;
		const choice = await resolveStaticRoot(uiDir);
		staticRootCache = { choice, until: now + 2_000 };
		return choice;
	};
	const workspace = options.workspace ?? join(process.cwd(), "workspace");
	// 设置与附件都在 workspace 下：测试传临时目录，正式运行就是项目 workspace。
	const settingsStore = options.settings ?? openSettings({ workspace });
	const builtinModels = options.models;
	/** 实际监听值（端口 0 时由系统分配，listen 之后才能确定）。 */
	let actualPort = port;
	let boundHost = host;

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
			payload = JSON.stringify(await buildOrgView(current(), BACKGROUND_CONTEXT));
		} catch (error) {
			payload = JSON.stringify({ error: String(error) });
		}
		for (const client of orgClients) {
			// 逐条 await 背压：慢客户端会让这一轮推送变慢，但不会让进程内存涨上去。
			// 这里刻意**串行**——并发写同一批连接只会让缓冲更乱。
			const ok = await writeSse(client, `event: org\ndata: ${payload}\n\n`);
			if (!ok) orgClients.delete(client);
		}
	};

	// 任何提交都可能改变组织状态：订阅一次，全客户端共享。
	// 崩溃自愈会换运行时对象，所以要跟着换订阅——否则自愈之后新运行时上的提交
	// 推不动界面，看起来像「服务卡住了」。
	let subscribed: CompanyRuntime | undefined;
	let unsubscribeCommits: (() => void) | undefined;
	// IM 出站：订阅提交把老板通道的新回复推到 outboundWebhook（失败静默）
		const ensureSubscribed = (): void => {
		const next = current();
		if (next === subscribed) return;
		unsubscribeCommits?.();
		subscribed = next;
		try {
			unsubscribeCommits = next.harness.subscribeCommits(() => {
				scheduleOrgPush();
			});
		} catch {
			// 运行时可能正处在关闭/重开之间：下一帧再试
			subscribed = undefined;
			unsubscribeCommits = undefined;
		}
	};
	ensureSubscribed();

	// 看门狗：定期收尾僵住的任务、排空被压住的队列（契约 §5.2）。
	// **传 getter 而不是实例**：崩溃自愈会重开运行时，传实例会让看门狗
	// 每轮都对已关闭的对象巡检 → 抛错 → 被吞掉 → 看门狗静默失效。
	const stopWatchdog =
		options.watchdog === false
			? () => undefined
			: startCompanyWatchdog(current, {
					onAlert: (alert) => {
						process.stderr.write(`[看门狗] ${alert.message}\n`);
						// 告警要立刻出现在界面：留痕条目已经落库，这里顺手推一帧
						scheduleOrgPush();
					},
				});

	const server = createServer((request, response) => {
		// 兜底：handle 内部已 try/catch，但 URL 解析等发生在更外层的位置仍可能抛。
		// 以前这里是裸 `void handle(...)`，一个畸形 Host 头就变成 unhandledRejection，
		// 而 src/runtime/signals.ts 对 unhandledRejection 直接 process.exit(1)——
		// 同网段任何人发一个 `Host: a b` 就能把整个多 agent 运行时打死。
		void handle(request, response).catch((error: unknown) => {
			try {
				fail(response, 500, error instanceof Error ? error.message : String(error));
			} catch {
				response.destroy();
			}
		});
	});

	// 连接级超时：以前一个都没设。
	//
	// 没有 `headersTimeout` 时，slowloris 用几百个「只发一半头」的连接就能耗尽
	// Node 的并发名额；没有 `requestTimeout` 时，一个只发了个 body 开头的 POST
	// 能永久占住一条连接。SSE 走的是 `response`，不受 `requestTimeout` 影响
	// （它限制的是「请求体收完」的时间），所以不用担心把长连接掐掉。
	server.headersTimeout = 15_000;
	server.requestTimeout = 60_000;
	server.keepAliveTimeout = 65_000;

	/** 路由。 */
	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		let path: string;
		let url: URL;
		try {
			// `new URL()` 必须在 try 内：`Host: a b` / `Host: [::1` / `Host: x%zz`
			// 都会抛 `Invalid URL`，而它以前写在 try 之前。
			url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
			path = url.pathname;
		} catch {
			return fail(response, 400, "请求地址不合法");
		}

		try {
			const match = matchRoute(routes, request.method ?? "GET", path);
			if (match === undefined) return fail(response, 404, "没有这个接口");
			return await match.route.handler({
				request,
				response,
				url,
				path,
				method: request.method ?? "GET",
				params: match.params,
			});
		} catch (error) {
			return fail(response, 500, error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * 路由表。
	 *
	 * 顺序即优先级：**具体路径写在通配前面**。三条兜底必须永远在最后：
	 * `/api/settings` 与 `/api/models` 的 405（路径存在但方法不对，
	 * 直接 404 会让调用方以为是端点拼错了），以及静态资源。
	 *
	 * handler 各自负责方法判断之外的一切（旧的 `if` 链里混着
	 * `request.method === "POST"` 的判断，现在提到 `method` 字段上）。
	 */
	const routes: readonly Route[] = [
		{
			pattern: "/api/org",
			method: "GET",
			handler: async ({ response }) => json(response, await buildOrgView(current(), BACKGROUND_CONTEXT)),
		},
		// 职工「工作记录」（UX-7 的数据源）：思考 / 回复 / 工具调用混排。
		//
		// 老板口径（第三次，最终版）：「不是只是工具调用，还是他思考过程啊」
		// ⇒ 保留 `thinking` / `assistant` / `tool` 三类，排除 `user`（老板自己的话）
		//   与 `note`/`alert`（系统留痕）。
		//
		// 复用 `readFeed`（它已把 toolCall 与 toolResult 按 callId 合并好），
		// 本端点只做「筛选 + 摘要截断 + 分页」三件事，不平行造第二套解析逻辑。
		//
		// 与 /api/channels/:id 同一套查询参数惯例（`?limit=&before=`），
		// `before` 是 entry id，语义「严格早于」（往上翻更早的）。
		{
			pattern: "/api/staff/:conversationId/activity",
			method: "GET",
			handler: async ({ response, url, params }) => {
				const conversationId = Number(params.conversationId);
				if (!Number.isFinite(conversationId)) return fail(response, 400, "会话标识不合法");
				const limitParam = Number(url.searchParams.get("limit") ?? "");
				const beforeParam = Number(url.searchParams.get("before") ?? "");
				const page = await readStaffActivity(
					current(),
					conversationId,
					{
						...(Number.isFinite(limitParam) && limitParam > 0 ? { limit: limitParam } : {}),
						...(Number.isFinite(beforeParam) && beforeParam > 0 ? { before: beforeParam } : {}),
					},
					BACKGROUND_CONTEXT,
				);
				if (page === undefined) return fail(response, 404, "会话不存在");
				return json(response, page);
			},
		},
		// 职工档案：顶部按钮展示这位职工的角色预制提示词 / 技能（用户 2.5）
		{
			pattern: "/api/profile/:conversationId",
			method: "GET",
			handler: async ({ response, params }) => {
				const conversationId = Number(params.conversationId);
				if (!Number.isFinite(conversationId)) return fail(response, 400, "会话标识不合法");
				const result = await readProfile(current(), conversationId, BACKGROUND_CONTEXT);
				if ("error" in result) return fail(response, 404, result.error);
				return json(response, result.profile);
			},
		},
		{ pattern: "/api/stream/org", method: "GET", handler: ({ response }) => streamOrg(response) },
		{ pattern: "/api/answer", method: "POST", handler: ({ request, response }) => postAnswer(request, response) },
		// 处置待办（驳回 / 标记已解决）。与 /api/answer 同一风格：POST + {key, text}。
		{ pattern: "/api/pending/dispose", method: "POST", handler: ({ request, response }) => postDispose(request, response) },
		// CEO 把老板级待办接管回自己层（Defect B 要求 3）。
		{ pattern: "/api/pending/take-over", method: "POST", handler: ({ request, response }) => postTakeOver(request, response) },

		// ── 设置 / 模型 ──
		{ pattern: "/api/settings", method: "GET", handler: async ({ response }) => json(response, await settingsView()) },
		{ pattern: "/api/settings", method: "PATCH", handler: ({ request, response }) => patchSettings(request, response) },
		{
			pattern: "/api/settings",
			handler: ({ response }) => fail(response, 405, "只支持 GET / PATCH"),
		},
		{ pattern: "/api/models", method: "POST", handler: ({ request, response }) => postModel(request, response) },
		{
			pattern: "/api/models",
			method: ["PATCH", "PUT"],
			handler: ({ request, response, url }) => patchModel(request, url, response),
		},
		{ pattern: "/api/models", method: "DELETE", handler: ({ response, url }) => deleteModel(url, response) },
		{
			pattern: "/api/models",
			handler: ({ response }) => fail(response, 405, "只支持 POST / PATCH / DELETE"),
		},

		// ── 头像 ──
		// 真实插画头像，按名字稳定生成（同一人永远同一张脸）。长缓存：内容由名字决定，永不变。
		{
			pattern: "/api/avatar/:seed",
			method: "GET",
			handler: ({ request, response, url, params }) => {
				const seed = params.seed ?? "";
				if (seed === "") return fail(response, 400, "缺少名字");
				const sizeParam = Number(url.searchParams.get("size") ?? 96);
				const size = Number.isFinite(sizeParam) ? Math.min(256, Math.max(24, Math.round(sizeParam))) : 96;
				const etag = avatarEtag(seed, size);
				if (request.headers["if-none-match"] === etag) {
					response.writeHead(304, { etag });
					response.end();
					return;
				}
				const svg = avatarSvg(seed, size);
				response.writeHead(200, {
					"content-type": "image/svg+xml; charset=utf-8",
					"cache-control": "public, max-age=31536000, immutable",
					etag,
				});
				response.end(svg);
				return;
			},
		},

		// ── 频道（通信重构） ──
		{
			pattern: "/api/channels",
			method: "GET",
			handler: async ({ response }) =>
				json(response, {
					channels: await listChannels(current(), BACKGROUND_CONTEXT),
					unread: await unreadSummary(current(), BACKGROUND_CONTEXT),
				}),
		},
		// `/mentionable` 必须排在 `/api/channels/:id` 之前——否则会被当成频道 id。
		{
			pattern: "/api/channels/:id/mentionable",
			method: "GET",
			handler: async ({ response, params }) =>
				json(response, { candidates: await mentionCandidates(current(), params.id ?? "", OWNER_ID, BACKGROUND_CONTEXT) }),
		},
		{
			pattern: "/api/channels/:id",
			method: "GET",
			handler: async ({ response, url, params }) => {
				const id = params.id ?? "";
				const limitParam = Number(url.searchParams.get("limit") ?? "");
				const beforeParam = Number(url.searchParams.get("before") ?? "");
				const view = await readChannelView(
					current(),
					id,
					{
						...(Number.isFinite(limitParam) && limitParam > 0 ? { limit: limitParam } : {}),
						...(Number.isFinite(beforeParam) && beforeParam > 0 ? { before: beforeParam } : {}),
						viewer: OWNER_ID,
					},
					BACKGROUND_CONTEXT,
				);
				if (view === undefined) return fail(response, 404, "频道不存在或无权查看");
				// **GET 不写状态**：读接口有副作用会让「轮询」「预取」「手机列表页」
				// 这些不该算已读的动作也把未读清掉（曾经就是这样，用户在列表页
				// 还没看内容，徽章就没了）。已读由前端渲染完消息后显式 POST /read。
				return json(response, view);
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
					await markMentionSeen(current(), id, body.seq, OWNER_ID, BACKGROUND_CONTEXT);
					// 只推到**真正渲染出来的最后一条**，不是频道末尾。
					// 否则用户只看了最近 60 条，中间的未读也被吞了。
					await markChannelRead(current(), id, OWNER_ID, body.seq, BACKGROUND_CONTEXT);
				} else {
					await markAllRead(current(), id, OWNER_ID, BACKGROUND_CONTEXT);
				}
				scheduleOrgPush();
				return json(response, { ok: true });
			},
		},

		// ── 看板 ──
		{ pattern: "/api/board", method: "GET", handler: async ({ response }) => json(response, await buildBoardView(current(), BACKGROUND_CONTEXT)) },

		// ── 静态资源 ──
		// dist 优先，找不到的文件（如 vendor/）回退到源码目录。
		{
			pattern: "*rest",
			handler: async ({ request, response, path }) => {
				const choice = await staticRoot();
				const dirs = choice.kind === "dist" ? [choice.dir, uiDir] : [uiDir];
				return await serveStatic(response, request, uiDir, path, dirs);
			},
		},
	];

	/**
	 * 往 SSE 连接写一段，**尊重背压**。
	 *
	 * `response.write()` 返回 false 表示内核缓冲已满。以前所有 SSE 都忽略返回值：
	 * 一个慢消费的客户端（或干脆不再读的僵尸标签页）会让 Node 的内部缓冲无限增长，
	 * 最后整个进程 OOM——而 SSE 是本服务最长的连接，最容易积累。
	 * 这里等 `drain` 再继续；连接已关闭则立即返回 false 让调用方停止。
	 */
	async function writeSse(response: ServerResponse, chunk: string): Promise<boolean> {
		if (response.writableEnded || response.destroyed) return false;
		try {
			if (response.write(chunk)) return true;
			// 缓冲满了：等到可以继续写、或连接断开（超时兜底，避免永久挂住）
			return await new Promise<boolean>((resolve) => {
				let done = false;
				const finish = (ok: boolean): void => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					response.off("drain", onDrain);
					response.off("close", onClose);
					resolve(ok);
				};
				const onDrain = (): void => finish(true);
				const onClose = (): void => finish(false);
				// 60 秒还排不空 → 认为客户端已经死了，断开它
				const timer = setTimeout(() => finish(false), 60_000);
				response.on("drain", onDrain);
				response.on("close", onClose);
			});
		} catch {
			return false;
		}
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
		void buildOrgView(current(), BACKGROUND_CONTEXT).then(async (view) => {
			const ok = await writeSse(response, `event: org\ndata: ${JSON.stringify(view)}\n\n`);
			if (!ok) orgClients.delete(response);
		});

		const keepAlive = setInterval(() => {
			// 心跳也走背压路径：如果连心跳都写不进去，说明这条连接已经废了。
			void writeSse(response, ": ping\n\n").then((ok) => {
				if (!ok) {
					clearInterval(keepAlive);
					orgClients.delete(response);
				}
			});
		}, 15_000);

		response.on("close", () => {
			clearInterval(keepAlive);
			orgClients.delete(response);
		});
	}

	/**
	 * 老板在频道里发言（通信重构的主入口）。
	 *
	 * 与 `/api/message` 的区别：`/api/message` 是「对某个会话说话」，
	 * 这里是「在频道里说话」——消息落频道，按 @ 唤醒该唤醒的人。
	 * 老板可以 @ 任何人（他在所有频道里）。
	 */
	async function postChannelMessage(
		channelId: string,
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		const body = await readJson<{
			text?: string;
			mentions?: readonly number[];
			kind?: string;
			/** 需求 #7：回复哪一条（频道内 seq）。无效值由 domain 层忽略。 */
			replyTo?: number;
		}>(request);
		const text = (body.text ?? "").trim();
		if (text === "") return fail(response, 400, "需要 text");

		const runtime = current();
		const channel = await readChannel(runtime, channelId, BACKGROUND_CONTEXT);
		if (channel === undefined) return fail(response, 404, "频道不存在");

		const content = text;

		const company = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
		const org = buildOrg(company);

		// @ 目标 = 前端显式给的 ∪ 服务端从正文解析出来的。
		// 服务端也要解析：老板可能手打「@许砚舟」而不点候选，不解析就不会唤醒任何人。
		// 只保留频道成员（@ 一个不在频道里的人没有意义）。
		const explicit = (body.mentions ?? []).filter((id) => channel.members[String(id)] !== undefined);
		const parsed = parseMentions(content, channel, org);
		const mentions = [...new Set([...explicit, ...parsed])].filter(
			(id) => channel.members[String(id)] !== undefined && id !== OWNER_ID,
		);

		// 老板发言必回（ADR-026 决策 7.1 的延续）。
		// 两段拆开：**采样**在投递前（投递后对方立刻开工，busy 会恒为真），
		// **落库**在投递后（那时才知道这条消息的 `messageSeq`，频道视图靠它挂回执）。
		const targets = mentions.length > 0 ? mentions : defaultTargets(channel, org);
		const ackState = await snapshotAcks(runtime, targets);

		const posted = await postToChannel(
			runtime,
			channelId,
			{
				from: OWNER_ID,
				fromLabel: "老板",
				kind: body.kind === "question" ? "question" : "chat",
				text: content,
				mentions,
				// 回复谁就等于 @ 谁（在 `appendMessage` 里回填），前端不用自己算。
				...(typeof body.replyTo === "number" ? { replyTo: body.replyTo } : {}),
			},
			{ context: BACKGROUND_CONTEXT },
		);
		await writeAck(runtime, channelId, content, ackState, posted.message.seq);

		// 老板的消息必须最终有人回应：看门狗会扫「无响应的老板消息」
		scheduleOrgPush();
		return json(response, {
			ok: true,
			seq: posted.message.seq,
			delivered: posted.delivery?.delivered ?? [],
			failed: posted.delivery?.failed ?? [],
		});
	}

	/** 老板发言没 @ 时该通知谁：频道 owner。 */
	/**
	 * 老板没 @ 时，回执该发给谁。
	 *
	 * 映射**委托给 `domain/membership.ts` 的 `ownerOfChannel`**——这里以前自己
	 * 写了一版 switch（company/leadership→CEO、proj:x→负责人、dm:/log:→对方），
	 * 与 `src/company/channels.ts` 的 `wakeTargets` 是同一逻辑的第三份拷贝。
	 * 三份拷贝里任何一份漏了新增的频道类型，回执就会发错人。
	 */
	function defaultTargets(channel: Channel, org: ReturnType<typeof buildOrg>): readonly number[] {
		const owner = ownerOfChannel(org, channel);
		return owner === undefined || owner === OWNER_ID ? [] : [owner];
	}

	/** 一张待写的受理回执：**写之前**采到的「它当时忙不忙」。 */
	type AckSnapshot = {
		readonly target: number;
		readonly busy: boolean;
		readonly busyWith: string | null;
	};

	/**
	 * 采受理回执要用的「当下状态」（老板消息必回，ADR-026 决策 7.1 的延续）。
	 *
	 * 为什么必须在**投递之前**采：投递之后那个会话立刻开工（`app.channel` 进了它的
	 * 输入），「在忙」就恒为真，每条回执都会变成「当前工具结束后处理」——那是假话。
	 * 所以把「采样」和「落库」拆开：采样在投递前，落库在投递后（那时才拿得到
	 * `messageSeq`，见 `writeAck`）。
	 *
	 * 「在忙」用 `inspectLiveness` 的**唯一判据**（`isConversationBusy`）：它同时覆盖
	 * 「正在生成」与「正在跑工具」，而 `pi.live.tools` 只看得见后者。早先这里另写过
	 * 一份 `isStillBusy`，逻辑与它逐字相同——删掉重复实现，直接调运行时那一个。
	 */
	async function snapshotAcks(
		runtime: CompanyRuntime,
		targets: readonly number[],
	): Promise<readonly AckSnapshot[]> {
		const snapshots: AckSnapshot[] = [];
		let liveness: Awaited<ReturnType<typeof inspectLiveness>> | undefined;
		try {
			liveness = await inspectLiveness(runtime, {}, BACKGROUND_CONTEXT);
		} catch {
			// 巡检失败就当「都不忙」，不影响受理
		}
		for (const target of targets) {
			try {
				const conversation = await runtime.harness.conversation(target as never, BACKGROUND_CONTEXT);
				if (conversation === undefined) continue;
				const view = await conversation.watch(BACKGROUND_CONTEXT);
				const live = view.value.docs["pi.live"] as
					| { readonly tools?: Record<string, { readonly name?: string; readonly status?: string }> }
					| undefined;
				await view.stop();
				const runningTool = Object.values(live?.tools ?? {}).find(
					(tool) => tool.status !== "done" && tool.status !== "error" && tool.status !== "cancelled",
				)?.name;
				const busy = liveness === undefined ? false : isConversationBusy(liveness, target);
				snapshots.push({ target, busy, busyWith: runningTool ?? null });
			} catch {
				// 采样失败不影响受理
			}
		}
		return snapshots;
	}

	/**
	 * 写受理回执（老板消息必回）。
	 *
	 * 内容比旧版 `app.receipt` 多三样：**在忙什么**、**大概什么时候处理**、
	 * **对应频道里的哪条消息**（`messageSeq`，频道视图靠它把回执接回消息）。
	 * 前两样正是老板要的（「即使对方在忙，也要回复我告知在忙什么」），
	 * 第三样让老板在自己发的消息下面能看到「已排队 / 处理中」。
	 */
	async function writeAck(
		runtime: CompanyRuntime,
		channelId: string,
		text: string,
		acks: readonly AckSnapshot[],
		messageSeq: number,
	): Promise<void> {
		for (const ack of acks) {
			try {
				const conversation = await runtime.harness.conversation(ack.target as never, BACKGROUND_CONTEXT);
				if (conversation === undefined) continue;
				await conversation.submit(
					{
						type: "write",
						entry: {
							kind: "app.ack",
							data: {
								text: text.slice(0, 280),
								channelId,
								// 这条回执对应频道里的哪条消息——频道视图按它挂回执。
								messageSeq,
								busy: ack.busy,
								busyWith: ack.busyWith,
								plan: ack.busy ? "当前工具结束后处理" : "立即处理",
								at: Date.now(),
							} as never,
						},
					},
					BACKGROUND_CONTEXT,
				);
			} catch {
				// 回执失败不影响受理
			}
		}
	}

	/** 拍板：回答一条待决问题。 */
	async function postAnswer(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson<{ key?: string; text?: string }>(request);
		const key = (body.key ?? "").trim();
		const text = (body.text ?? "").trim();
		if (key === "" || text === "") return fail(response, 400, "需要 key 与 text");

		// 老板只回答「CEO 报上来」的问题：owner 级以外的条目属于管理层授权范围，
		// 老板替他们拍板等于把决策责任揽到自己身上（也正是「待拍板太多」的根源）。
		const pending = await listPending(current(), BACKGROUND_CONTEXT);
		let item = pending.find((entry) => entry.key === key);

		// ADR-026 决策 5：「到期按暂搁执行，问题留在待办，事后可改」。
		// 超时默认结算掉的处置项已经从 listPending 里消失（它有 answer 了），
		// 但它是**机器代你选的**，人回来推翻必须还能答。所以这里再兜一次：
		// 只放行 `decidedBy === "timeout-default"` 的处置项，人自己答过的不许改。
		if (item === undefined) {
			const state = await current().harness.snapshot(PendingDoc, BACKGROUND_CONTEXT);
			item = state?.items.find(
				(entry) => entry.key === key && entry.disposition?.decidedBy === "timeout-default",
			);
		}
		if (item === undefined) return fail(response, 404, "没有这条待决问题（可能已被处理）");

		// 这个入口是老板专属（answeredBy 恒为 "owner"），所以先做层级守卫：
		// 不在 owner 级的问题一律不由老板拍。
		//
		// ADR-026 决策 1 的例外（审计 D-02）：**处置类**待办在 ceo 级时，老板也要能答。
		// 原因：系统里没有独立的老板会话，老板亲自派活写成的 `app.delegate.from` 就是 "CEO"
		// （实测真实库 56 条全是 CEO），所以「老板派的活」的处置待办 level 就是 `ceo`。
		// 如果不放这一级，老板被自己的活打断后，处置问题会进不了他的界面（forYou=false）、
		// 也答不了（409）——处置在老板这里完全不可达。
		// 注意只放**处置类**：普通待决问题依旧“老板只答 owner”，不让老板揽管理层的决策责任。
		const isOwnerDisposition = item.disposition !== undefined && item.level === "ceo";
		if (item.level !== "owner" && !isOwnerDisposition) {
			return fail(response, 409, "这条问题不在老板这一级，应由 CEO 或对应管理层拍板");
		}

		// 处置类待办（ADR-026 决策 4/5）：必须明确选「暂搁/放弃」，且暂搁必须带恢复条件。
		if (item.disposition !== undefined) {
			const settled = await settleDisposition(
				current(),
				{ key, answer: text, answeredBy: "owner" },
				BACKGROUND_CONTEXT,
			);
			if (!settled.ok) return fail(response, 400, settled.reason);
			scheduleOrgPush();
			return json(response, { ok: true, disposition: settled.disposition });
		}

		const ok = await answerPending(
			current(),
			{ key, answer: text, answeredBy: "owner" },
			BACKGROUND_CONTEXT,
		);
		scheduleOrgPush();
		return json(response, { ok });
	}

	/**
	 * 处置待办：驳回 / 标记已解决。
	 *
	 * 与 `postAnswer` 同一风格：POST + JSON body。但**不是**「给定答复」，
	 * 而是「这条待办到此为止」——差别见 escalation.ts 的 PendingDisposal。
	 *
	 * 权限：这个 HTTP 入口是老板的网页客户端，所以操作者层级固定为 `owner`。
	 * 真正是否能处置，由 `disposePending()` 里的 `canDisposePending()` 判定
	 * （老板只能处置 decisionOwner 为 owner 的），越权返回 403 并带可读原因。
	 * 不在这一层做「是老板就放行」的短路：那会让同一道防线只写在界面里，
	 * 而界面本来就是最容易被绕开的地方。
	 */
	async function postDispose(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson<{ key?: string; status?: string; reason?: string }>(request);
		const key = (body.key ?? "").trim();
		const status = (body.status ?? "").trim();
		if (key === "") return fail(response, 400, "需要 key");
		if (status !== "rejected" && status !== "resolved") {
			return fail(response, 400, "status 只能是 rejected（驳回）或 resolved（标记已解决）");
		}

		const outcome = await disposePending(
			current(),
			{
				key,
				status,
				reason: body.reason ?? "",
				disposedBy: "owner",
				operatorLevel: "owner",
			},
			BACKGROUND_CONTEXT,
		);

		if (!outcome.ok) {
			const code = outcome.code === "not-found" ? 404 : outcome.code === "forbidden" ? 403 : 409;
			return fail(response, code, outcome.reason);
		}
		scheduleOrgPush();
		return json(response, {
			ok: true,
			changed: outcome.changed,
			disposal: outcome.item.disposed,
		});
	}

	/**
	 * CEO 接管一条老板级待办：把它拉回 CEO 层处理（Defect B 要求 3）。
	 *
	 * 与 `/api/pending/dispose` 分开是因为语义不同：
	 * - dispose = 这条到此为止（驳回/已解决）；
	 * - take-over = 这条不用老板了，CEO 自己定。
	 * 两者的权限主体也不同（dispose 由该级决策人做，take-over 只有 CEO 能做）。
	 */
	async function postTakeOver(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson<{ key?: string; reason?: string; asLevel?: string }>(request);
		const key = (body.key ?? "").trim();
		if (key === "") return fail(response, 400, "需要 key");

		// 操作者层级：网页端是**老板的 CEO 面板**，唯一操作者就是 CEO，
		// 所以默认 ceo。但**不接受调用方随便声明别的层级**——以前 `body.asLevel`
		// 原样透传给 `takeOverPendingAtCeo`，等于把权限判定交给请求体。
		// 服务本身没有鉴权（见 src/server/main.ts 顶部注释），真正的边界是「只听 127.0.0.1」，
		// 所以这里能做的是：不允许通过参数伪造比自己更高的层级。
		const operatorLevel = (body.asLevel ?? "ceo").trim();
		if (operatorLevel !== "ceo") {
			return fail(response, 403, `接管待办只能由 CEO 发起（收到 asLevel=${operatorLevel}）`);
		}

		const outcome = await takeOverPendingAtCeo(
			current(),
			{ key, reason: body.reason ?? "", operatorLevel },
			BACKGROUND_CONTEXT,
		);

		if (!outcome.ok) {
			const code = outcome.code === "not-found" ? 404 : outcome.code === "forbidden" ? 403 : 409;
			return fail(response, code, outcome.reason);
		}
		scheduleOrgPush();
		return json(response, { ok: true, changed: outcome.changed, pending: outcome.item });
	}

	// ── 设置 / 模型 / 附件 / 看板 / IM ──────────────────────────────────────

	/** 设置页需要的完整视图：实际监听值 + 模型清单。 */
	async function settingsView(): Promise<SettingsView> {
		const settings = await settingsStore.read();
		const lanUrls = lanUrlsOf(boundHost, actualPort);
		const restartRequired = await settingsStore.restartRequired();
		return buildSettingsView({
			settings,
			bindHost: boundHost,
			port: actualPort,
			lanUrls,
			url: browserUrlOf(boundHost, actualPort),
			// 只传「内置」清单：自定义模型由 buildSettingsView 从 settings 里补，
			// 否则重启后 catalog 里会同时出现 builtin 与 custom 两条同 id 记录
			builtinCatalog: builtinModels?.builtinCatalog ?? builtinModels?.catalog ?? [],
			defaultModel: builtinModels?.defaultModel ?? { provider: "unknown", modelId: "unknown" },
			restartRequired,
		});
	}

	/** 把设置错误映射成 HTTP 状态。 */
	function failForError(response: ServerResponse, error: unknown): void {
		if (error instanceof SettingsInputError) return fail(response, 400, error.message);
		if (error instanceof SettingsConflictError) return fail(response, 409, error.message);
		return fail(response, 500, error instanceof Error ? error.message : String(error));
	}

	/** PATCH /api/settings：按段合并并落盘，返回合并后的完整视图。 */
	async function patchSettings(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson<unknown>(request);
		try {
			await settingsStore.patch(body);
		} catch (error) {
			return failForError(response, error);
		}
		return json(response, await settingsView());
	}

	/** POST /api/models：新增一条自定义模型（重启后生效）。 */
	async function postModel(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson<Record<string, unknown>>(request);
		const id = typeof body.id === "string" ? body.id.trim() : "";
		if (id === "") return fail(response, 400, "需要模型 id");
		// 与内置模型重名会让「按 id 解析默认模型」产生歧义，直接拒绝
		const builtin = builtinModels?.builtinCatalog ?? builtinModels?.catalog ?? [];
		const clash = builtin.some((item) => item.id === id || `${item.provider}/${item.modelId}` === id);
		if (clash) return fail(response, 409, `模型 ${id} 与内置模型重名`);
		try {
			const model = await settingsStore.addModel(body);
			const view = await settingsView();
			const entry = view.models.catalog.find((item) => item.id === model.id);
			// 同时返回完整设置视图：前端可一次 applySettings，不用再补一次 GET
			return json(response, {
				...view,
				ok: true,
				model: entry satisfies ModelCatalogEntry | undefined,
				restartRequired: true,
			});
		} catch (error) {
			return failForError(response, error);
		}
	}

	/**
	 * PATCH /api/models?id=：改一条模型（重启后生效）。
	 *
	 * 内置模型是代码里的常量，改不了；改它等于**写一条覆盖项**：请求体带上
	 * `builtin: <原 id>`，落盘后装配时这条覆盖项会顶掉内置项（见 `setupModels`）。
	 * 不带 `builtin` 就是对一条自定义模型就地改字段。
	 */
	async function patchModel(request: IncomingMessage, url: URL, response: ServerResponse): Promise<void> {
		const id = (url.searchParams.get("id") ?? "").trim();
		if (id === "") return fail(response, 400, "需要 id 查询参数");
		const body = await readJson<Record<string, unknown>>(request);
		const builtin = builtinModels?.builtinCatalog ?? builtinModels?.catalog ?? [];
		const isBuiltin = builtin.some((item) => item.id === id);
		const source = isBuiltin ? id : undefined;
		// 改内置项必须显式带上 builtin，避免「顺手把一个自定义模型改成覆盖内置」的歧义
		const payload: Record<string, unknown> = isBuiltin ? { ...body, builtin: id } : { ...body };
		if (!isBuiltin && typeof payload.builtin === "string" && payload.builtin !== "") {
			if (!builtin.some((item) => item.id === payload.builtin)) {
				return fail(response, 400, `没有内置模型 ${String(payload.builtin)}`);
			}
		}
		if (isBuiltin && typeof payload.id !== "string") payload.id = id;
		try {
			const model = await settingsStore.putModel(source, payload);
			const view = await settingsView();
			const entry = view.models.catalog.find((item) => item.id === model.id);
			return json(response, { ...view, ok: true, model: entry satisfies ModelCatalogEntry | undefined, restartRequired: true });
		} catch (error) {
			return failForError(response, error);
		}
	}

	/**
	 * DELETE /api/models?id=：删除一条模型（重启后生效）。
	 *
	 * 自定义模型直接从清单里删掉；内置模型删不掉（代码常量），于是写一条
	 * `hidden` 覆盖项把它从目录里摘掉。两种都立即从设置页与重启后的装配里消失。
	 */
	async function deleteModel(url: URL, response: ServerResponse): Promise<void> {
		const id = (url.searchParams.get("id") ?? "").trim();
		if (id === "") return fail(response, 400, "需要 id 查询参数");
		const builtin = builtinModels?.builtinCatalog ?? builtinModels?.catalog ?? [];
		if (builtin.some((item) => item.id === id)) {
			try {
				// 就地改默认：删掉的正好是默认模型时，退到第一条剩下的模型，
				// 否则重启后「默认模型」会指向一个已不在目录里的 id。
				const nextDefault = await fallbackDefaultAfterRemoving(id);
				await settingsStore.putModel(id, {
					id,
					builtin: id,
					hidden: true,
					provider: "openai-responses",
					...(nextDefault === undefined ? {} : { defaultRef: nextDefault }),
				});
				return json(response, { ...(await settingsView()), ok: true, restartRequired: true });
			} catch (error) {
				return failForError(response, error);
			}
		}
		const removed = await settingsStore.removeModel(id);
		if (!removed) return fail(response, 404, "没有这条模型");
		// 同样带完整设置视图，前端删完直接重绘
		return json(response, { ...(await settingsView()), ok: true, restartRequired: true });
	}

	/** 删掉 `id` 之后，默认模型该退到哪一条（没有候选就返回 undefined，保持原样）。 */
	async function fallbackDefaultAfterRemoving(id: string): Promise<string | undefined> {
		const view = await settingsView();
		const rest = view.models.catalog.filter((item) => item.id !== id);
		const first = rest[0];
		return first === undefined ? undefined : first.id;
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
	actualPort = typeof address === "object" && address !== null ? address.port : port;
	boundHost = listenHost;
	const lanUrls = lanUrlsOf(boundHost, actualPort);

	return {
		url: browserUrlOf(boundHost, actualPort),
		port: actualPort,
		host: boundHost,
		lanUrls,
		async close() {
			unsubscribeCommits?.();
			stopWatchdog();
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

/** JSON 请求体上限。1 MiB 足够所有端点（消息正文、待办答复都远小于此）。 */
const MAX_JSON_BYTES = 1024 * 1024;

async function readJson<T>(request: IncomingMessage): Promise<T> {
	const declared = Number(request.headers["content-length"] ?? "0");
	if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
		request.destroy();
		throw new Error(`请求体过大（${declared} 字节，上限 ${MAX_JSON_BYTES}）`);
	}
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = chunk as Buffer;
		total += buffer.length;
		// 不信任 content-length（可以是 chunked、可以撒谎），按实际字节数兜底。
		if (total > MAX_JSON_BYTES) {
			request.destroy();
			throw new Error(`请求体过大（上限 ${MAX_JSON_BYTES} 字节）`);
		}
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return {} as T;
	return JSON.parse(text) as T;
}

/** 静态资源：限制在 rootDir（源码根 `ui/`）内，防目录穿越。 */
async function serveStatic(
	response: ServerResponse,
	request: IncomingMessage,
	rootDir: string,
	path: string,
	/** 按优先级尝试的目录（第一个是主目录）。 */
	dirs: readonly string[],
): Promise<void> {
	const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
	// 越界检查的根必须是 **源码根**（`ui/`），不是当前服务目录：
	// 产物目录 `ui/dist/` 是源码根的子目录，dist 里的 app.js 会引用
	// `../vendor/three.module.js`，浏览器把它解析成 `/vendor/three.module.js`，
	// 需要在 `ui/` 下能找到。只把 `ui/dist` 当根就会把这种请求 403 掉。
	const root = normalize(rootDir);
	const resolveIn = (dir: string) => normalize(join(dir, relative));

	// 先做一次越界判断（用主目录算出来的路径就够：它们共享同一 relative）。
	const probe = resolveIn(dirs[0] ?? rootDir);
	if (probe !== root && !probe.startsWith(root + sep)) {
		return fail(response, 403, "禁止访问");
	}

	let target = probe;
	let asset = undefined;
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

	// SPA 回退只对「页面路径」生效。
	//
	// 以前任何读文件失败都回退成 200 + index.html：`/api/typo`、`/api/channelsX`
	// 也拿到 HTML，前端 `JSON.parse` 抛 `Unexpected token '<'`，错误信息完全误导；
	// 目录穿越被拒（403）之外的真实越界路径也会退化成「看起来正常」。
	// 带扩展名的资源请求（.js/.css/.png）找不到就是 404，不能返回 HTML——
	// 否则浏览器把 HTML 当 JS 解析，报一堆莫名其妙的语法错误。
	if (path.startsWith("/api/") || path.startsWith("/uploads/") || extname(path) !== "") {
		return fail(response, 404, "未找到");
	}
	let index = undefined;
	for (const dir of dirs) {
		index = await loadAsset(join(dir, "index.html"));
		if (index !== undefined) break;
	}
	if (index === undefined) return fail(response, 404, "未找到");
	return await sendAsset(response, request, index, "index.html", MIME[".html"] ?? "text/html; charset=utf-8");
}

/**
 * 发一个静态资源：压缩 + 条件请求。
 *
 * 三件事：
 * - **压缩**：`ui/` 首屏 480 KB，不压缩时这段字节会原样走隧道跨境传输。
 *   gzip 后 147 KB、brotli 后 124 KB（实测）。只在文件类型值得压时才压（png / woff2 不压）；
 * - **ETag + Last-Modified**：以前只发 `Cache-Control: no-cache` 却没有任何验证凭据，
 *   浏览器每次只能拿到 200 全量响应——`no-cache` 的语义是「可以存但用前要验证」，
 *   没有凭据就等于每次重传 480 KB。命中条件现在回 304，正文 0 字节；
 * - **Vary: Accept-Encoding**：让中间缓存不把 br 的响应发给只支持 gzip 的客户端。
 *
 * 缓存策略分两档：入口页 `no-cache`（保证发版能立刻生效），其余资源
 * `max-age=300, must-revalidate`（5 分钟内不起请求，之后用 ETag 验证）。
 * 不设长 `max-age` 是因为 `ui/` 没有内容哈希文件名，长缓存会让改动迟迟不生效。
 */
async function sendAsset(
	response: ServerResponse,
	request: IncomingMessage,
	asset: AssetEntry,
	relative: string,
	contentType: string,
): Promise<void> {
	const canCompress = compressible(contentType);
	const wanted = canCompress ? negotiateEncoding(request.headers["accept-encoding"]) : "identity";
	// 先取正文再算 ETag：压缩失败时会退回 identity，ETag 必须描述**实际**发出去的表示，
	// 否则客户端会拿着 br 的凭据去验证 identity 的响应，缓存语义就错了。
	const { body, encoding } = await bodyFor(asset, wanted);
	const etag = etagFor(asset, encoding);

	const headers: Record<string, string> = {
		"Content-Type": contentType,
		"Cache-Control": relative === "index.html" ? "no-cache" : "public, max-age=300, must-revalidate",
		ETag: etag,
		"Last-Modified": asset.lastModified,
	};
	if (canCompress) headers.Vary = "Accept-Encoding";

	// `If-None-Match` 优先：有它时按 RFC 9110 忽略 `If-Modified-Since`。
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
