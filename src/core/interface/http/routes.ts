/**
 * 路由表：**路径 → 一次用例调用**。
 *
 * 每个 handler 只做三件事：解析参数 → 调 `app/` 的一个函数 → `json(response, ...)`。
 * 没有业务规则藏在这里（校验、默认值、边界都归 app），也没有序列化之外的知识。
 *
 * 为什么刻意不引入框架：需求只有「按段匹配 + `:param` 捕获 + 末尾通配」，
 * 三十行就够（`match.ts`）；框架带来的中间件链反而会让 handler 的调用时机变得不直观。
 *
 * 这份表就是 `docs/WEB-API.md` 的合同执行处：加一条路由、改一个字段，先改文档。
 */
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { matchRoute, type Route, type RouteContext } from "./route-match.ts";
import type { StreamHub } from "./sse.ts";
import type { App, MemoryEditBody, PersonModelBody, PostBody } from "../../app/index.ts";
import { avatarEtag, avatarSvg, clampAvatarSize } from "../../app/avatar.ts";
import { fail, json, readJson } from "./respond.ts";
import { serveStatic } from "./static-assets.ts";

/**
 * 记忆留痕里的「操作者」。
 *
 * P0-4 之后 HTTP 侧只剩我一个身份，所以这里**不造多用户模型**：只把来源标清楚 ——
 * 网页（我点「忘掉」/「添一条」）写 `owner:web`，agent 自己 `remember` 写 `agent`。
 * 以后真出错时，「这条是人在面板上删的」和「它自己改的」能一眼分开。
 */
const WEB_ACTOR = "owner:web";

/** 路由要用到的、属于「进程」而不是「用例」的东西。 */
export type RouteDeps = {
	readonly app: App;
	readonly hub: StreamHub;
	/** 静态资源目录（默认 `ui/web/`）。 */
	readonly uiDir: string;
};

/** 查询参数里的数字：没有 / 不是有限数就是 `undefined`（由 app 决定默认值）。 */
export function numberParam(url: URL, name: string): number | undefined {
	// 没带这个参数就是 `undefined`，不是 0 —— `Number("")` 是 0，`?? 兜底` 就永远不会生效。
	// 症状：`/api/people/:slug/turns` 不带 `to` 时 `to` 变成 0，窗口退化成空，重启后私聊页
	// 的工作记录整片消失（运行中靠 SSE 推的帧撑着，所以只有重启才看得见）。
	const raw = url.searchParams.get(name);
	if (raw === null || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

export function coreRoutes(deps: RouteDeps): readonly Route[] {
	const { app, hub } = deps;

	/**
	 * 插件注册的接口 → 路由。
	 *
	 * **每次请求现造**：插件可以在运行中重装（ADR-026），表拼死一次就等于「装了要重启」。
	 */
	const pluginRoutes = (): readonly Route[] =>
		app.plugins.routes().map((route) => ({
			pattern: route.pattern,
			method: route.method,
			handler: async ({ request, response, params, url }: RouteContext) => {
				const query: Record<string, string> = {};
				for (const [key, value] of url.searchParams) query[key] = value;
				const body = route.method === "POST" ? await readJson<unknown>(request) : undefined;
				return json(response, await route.run({ params, query, ...(body === undefined ? {} : { body }) }));
			},
		}));

	return [
		{
			pattern: "/api/stream/org",
			method: "GET",
			handler: ({ response }) => hub.streamOrg(response),
		},
		{
			pattern: "/api/org",
			method: "GET",
			handler: async ({ response }) => json(response, await app.read.readOrg()),
		},
		{
			// 头像：按名字稳定生成一张插画（同一个人永远同一张脸）。内容由 seed 决定、永不变，
			// 所以给长缓存 + ETag；尺寸夹在 16–256，免得一个 `?size=999999` 把服务端画爆。
			pattern: "/api/avatar/:seed",
			method: "GET",
			handler: ({ request, response, url, params }) => {
				const seed = (params.seed ?? "").trim();
				if (seed === "") {
					response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
					response.end("缺少名字");
					return;
				}
				const raw = url.searchParams.get("size");
				const size = clampAvatarSize(raw === null ? undefined : Number(raw));
				const etag = avatarEtag(seed, size);
				if (request.headers["if-none-match"] === etag) {
					response.writeHead(304, { ETag: etag });
					response.end();
					return;
				}
				response.writeHead(200, {
					"Content-Type": "image/svg+xml; charset=utf-8",
					// 一周，不是 immutable：画风要能换（改了 `avatar.ts` 的取景或配色，
					// 老缓存得在一个星期内自己过期），而这一周里的重复请求都是本地命中。
					"Cache-Control": "public, max-age=604800",
					ETag: etag,
					// SVG 是可执行的：同源 + nosniff，别让它被嗅探成别的类型。
					"X-Content-Type-Options": "nosniff",
				});
				response.end(avatarSvg(seed, size));
			},
		},
		{
			// 现在生效的模型清单：给某个人换模型时只列这些。`settings.json` 改过会就地重装
			// 注册表，所以这里不用重启就是最新的（ADR-025）。
			pattern: "/api/models",
			method: "GET",
			handler: async ({ response }) => json(response, await app.models.list()),
		},
		{
			// 一个人的全部档案：界面右上角那个「详情」面板一次要的东西都在这。
			pattern: "/api/people/:slug",
			method: "GET",
			handler: async ({ response, params }) => {
				return json(response, await app.people.readPersonProfile(params.slug ?? ""));
			},
		},
		{
			pattern: "/api/people/:slug/memory",
			method: "GET",
			handler: async ({ response, params }) => {
				return json(response, await app.people.readPersonMemory(params.slug ?? ""));
			},
		},
		{
			pattern: "/api/people/:slug/memory",
			method: "POST",
			handler: async ({ request, response, params }) => {
				const body = await readJson<MemoryEditBody>(request);
				return json(response, await app.people.editPersonMemory(params.slug ?? "", body, WEB_ACTOR));
			},
		},
		{
			// 换某个人的模型：当场改会话，并记进 settings.json 的 agentModels（重启也认）。
			pattern: "/api/people/:slug/model",
			method: "POST",
			handler: async ({ request, response, params }) => {
				const body = await readJson<PersonModelBody>(request);
				return json(response, await app.people.setPersonModel(params.slug ?? "", body));
			},
		},
		{
			// 一个团队的档案：README 正文（介绍 / 验收标准）+ 管理员 + 团队记忆。
			pattern: "/api/teams/:slug",
			method: "GET",
			handler: async ({ response, params }) => {
				return json(response, await app.teams.readTeamProfile(params.slug ?? ""));
			},
		},
		{
			pattern: "/api/channels",
			method: "GET",
			handler: async ({ response }) => json(response, await app.read.readChannelList()),
		},
		{
			pattern: "/api/attention",
			method: "GET",
			handler: async ({ response }) => json(response, await app.read.readAttention()),
		},
		// 上传：正文就是文件本身（不是 multipart）。不解析 multipart 是故意的 ——
		// 名字走 `x-filename` 头、类型走 `content-type`，两行代码就能确定落盘的一切。
		{
			pattern: "/api/uploads",
			method: "POST",
			handler: async ({ request, response, url }) => {
				const header = request.headers["x-filename"];
				const uploaded = await app.chat.saveUpload(request as AsyncIterable<Uint8Array>, {
					headerName: typeof header === "string" ? header : undefined,
					queryName: url.searchParams.get("name"),
					type: request.headers["content-type"],
				});
				return json(response, uploaded);
			},
		},
		// 取附件：图片内联（点缩略图开大图才能直接显示），其余一律下载。
		{
			pattern: "/api/uploads/:id",
			method: "GET",
			handler: async ({ response, url, params }) => {
				const file = await app.uploads.read(params.id ?? "", { download: url.searchParams.get("download") === "1" });
				response.writeHead(200, {
					"Content-Type": file.mime,
					"Content-Length": String(file.bytes),
					// id 是新建时分配的 uuid，内容永不改，所以可以长时间缓存。
					"Cache-Control": "public, max-age=31536000, immutable",
					"Content-Disposition": file.disposition,
					// 附件是同源内容，不能让它被嗅探成 HTML：一个自称图片的文本文件
					// 一旦当页面执行，就是自己给自己开了一个 XSS。
					"X-Content-Type-Options": "nosniff",
				});
				return await pipeline(createReadStream(file.path), response);
			},
		},
		{
			// 确保我和一个人的私聊存在（幂等）。私聊现在由装配 / 招人自动建，这里留作显式入口。
			pattern: "/api/people/:slug/dm",
			method: "POST",
			handler: async ({ response, params }) => {
				return json(response, await app.chat.openDirectMessage(params.slug ?? ""));
			},
		},
		{
			// 一个人在所有频道里的轮次（私聊页的工作记录）。折叠版，不带步骤。
			pattern: "/api/people/:slug/turns",
			method: "GET",
			handler: async ({ response, url, params }) => {
				const from = numberParam(url, "from") ?? 0;
				const to = numberParam(url, "to") ?? Number.MAX_SAFE_INTEGER;
				return json(response, await app.read.readPersonTurns(params.slug ?? "", from, to));
			},
		},
		{
			pattern: "/api/channels/:id/mentionable",
			method: "GET",
			handler: async ({ response, params }) => {
				return json(response, await app.read.readMentionable(params.id ?? ""));
			},
		},
		{
			// 一段消息窗口里每一轮的轨迹（**不带步骤**）。折叠行只要摘要。
			pattern: "/api/channels/:id/turns",
			method: "GET",
			handler: async ({ response, url, params }) => {
				const from = numberParam(url, "from") ?? 0;
				const to = numberParam(url, "to") ?? Number.MAX_SAFE_INTEGER;
				return json(response, await app.read.readTurns(params.id ?? "", from, to));
			},
		},
		{
			// 一轮的完整轨迹（带步骤）。展开时按 (seq, slug) 拉一次。
			pattern: "/api/channels/:id/turn",
			method: "GET",
			handler: async ({ response, url, params }) => {
				const seq = numberParam(url, "seq") ?? 0;
				const slug = url.searchParams.get("slug") ?? "";
				return json(response, await app.read.readTurn(params.id ?? "", seq, slug));
			},
		},
		{
			pattern: "/api/channels/:id",
			method: "GET",
			handler: async ({ response, url, params }) => {
				const detail = await app.read.readChannelDetail(params.id ?? "", {
					limit: numberParam(url, "limit"),
					before: numberParam(url, "before"),
				});
				return json(response, detail);
			},
		},
		{
			pattern: "/api/channels/:id/messages",
			method: "POST",
			handler: async ({ request, response, params }) => {
				const body = await readJson<PostBody>(request);
				return json(response, await app.chat.postAsOwner(params.id ?? "", body));
			},
		},
		{
			pattern: "/api/channels/:id/stream",
			method: "GET",
			handler: ({ response, url, params }) => {
				// `?since=N` = 「我已经有到 N 了」。客户端开着页面刷新时带上它，
				// 服务端就只补 N 之后的消息，不再把 60 条历史重发一遍。
				//
				// 不带的话（第一次打开、没有 detail）就连历史一起推 —— 那是首屏补齐。
				const since = numberParam(url, "since");
				return hub.streamChannel(response, params.id ?? "", since !== undefined && since > 0 ? since : undefined);
			},
		},
		{
			pattern: "/api/channels/:id/read",
			method: "POST",
			handler: async ({ request, response, params }) => {
				const body = await readJson<{ seq?: number }>(request);
				return json(response, await app.chat.markRead(params.id ?? "", body.seq));
			},
		},
		{
			// 浏览器自己报上来的卡顿（`ui/app/src/lib/jank.ts`）：
			// 落 `workspace/logs/jank.jsonl`，满了轮转一代。
			pattern: "/api/diag",
			method: "POST",
			handler: async ({ request, response }) => {
				const body = await readJson<{ kind?: string; entries?: unknown }>(request, { requireJson: true });
				return json(response, await app.diag.record(body));
			},
		},
		{
			// 底座最近一条「不正常」的运行报告（`logs/runtime.jsonl` 里的最新一条的人话版）。
			// 界面启动时拉一次，把「agent 忽然不说话了」从「猜测」变成「看得见的一句话」。
			pattern: "/api/diag",
			method: "GET",
			handler: ({ response }) => json(response, { lastReport: app.diag.lastReport() ?? null }),
		},
		{
			// 装上的插件。前端启动时先拉这一份，再按 `client` 去 import 各自的前端入口。
			pattern: "/api/plugins",
			method: "GET",
			handler: async ({ response }) => json(response, { plugins: await app.plugins.list() }),
		},
		{
			// 装一个插件：前端把选中的文件夹整个传上来（base64），这里原样落进 `plugins/<slug>/`。
			// 装 / 卸都只动 `workspace/plugins/`，重启才真的运行。
			pattern: "/api/plugins",
			method: "POST",
			handler: async ({ request, response }) => {
				// 插件里可能有图片：正文上限按 8 MB 算，比普通 JSON 的 1 MB 宽。
				const body = await readJson<{ slug?: unknown; files?: unknown }>(request, { limit: 8 << 20 });
				const files = Array.isArray(body?.files) ? (body.files as readonly { path?: unknown; base64?: unknown }[]) : [];
				const valid = files.every(
					(file) => typeof file?.path === "string" && typeof file?.base64 === "string",
				);
				if (typeof body?.slug !== "string" || body.slug.trim() === "" || files.length === 0 || !valid) {
					return fail(response, 400, "要给一个插件名，并且至少带一个文件");
				}
				try {
					return json(
						response,
						{
							plugins: await app.plugins.install(
								body.slug.trim(),
								files.map((file) => ({ path: String(file.path), base64: String(file.base64) })),
							),
						},
					);
				} catch (error) {
					return fail(response, 400, (error as Error).message);
				}
			},
		},
		{
			// 删掉一个插件（整个目录）。不可恢复，界面上有二次确认。
			pattern: "/api/plugins/:slug",
			method: "DELETE",
			handler: async ({ response, params }) => {
				try {
					return json(response, { plugins: await app.plugins.remove(params.slug ?? "") });
				} catch (error) {
					return fail(response, 400, (error as Error).message);
				}
			},
		},
		{
			// 开关插件：写回 `plugin.md` 的 `enabled`。下一次启动生效（第一版没有热卸载）。
			pattern: "/api/plugins/:slug/enabled",
			method: "POST",
			handler: async ({ request, response, params }) => {
				const body = await readJson<{ enabled?: unknown }>(request);
				if (typeof body?.enabled !== "boolean") return fail(response, 400, "enabled 要 true 或 false");
				try {
					return json(response, { plugins: await app.plugins.setEnabled(params.slug ?? "", body.enabled) });
				} catch (error) {
					return fail(response, 400, (error as Error).message);
				}
			},
		},
		{
			// 插件的前端入口。磁盘上的文件，改了要立刻生效，所以不缓存。
			pattern: "/api/plugins/:slug/client.js",
			method: "GET",
			handler: async ({ response, params }) => {
				const script = await app.plugins.clientScript(params.slug ?? "");
				if (script === undefined) {
					response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
					response.end("没有这个插件的前端入口");
					return;
				}
				response.writeHead(200, {
					"Content-Type": "text/javascript; charset=utf-8",
					"Cache-Control": "no-store",
					// 浏览器按 JS 执行它，别让内容嗅探改判类型。
					"X-Content-Type-Options": "nosniff",
				});
				response.end(script);
			},
		},
		// 其余路径：**插件接口**，剩下的交给静态资源；找不到就 404。
		//
		// 插件路由在这里现查而不是拼进上面的表：装 / 卸 / 开关插件当场生效，不用重启
		// （ADR-026）。它们排在静态资源前面 —— 否则 `/api/...` 一律被静态资源吃掉。
		// 插件路由只有 JSON（GET / POST），发文件和流归核心，插件碰不到。
		{
			pattern: "*rest",
			handler: async (context) => {
				const matched = matchRoute(pluginRoutes(), context.method, context.path);
				if (matched !== undefined) {
					return await matched.route.handler({ ...context, params: matched.params });
				}
				return await serveStatic(context.response, context.request, deps.uiDir, context.path);
			},
		},
	];
}
