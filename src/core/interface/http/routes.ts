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
import type { Route } from "./server.ts";
import type { StreamHub } from "./sse.ts";
import type { App, MemoryEditBody, PostBody } from "../../app/index.ts";
import { json, readJson, serveStatic } from "./server.ts";

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
function numberParam(url: URL, name: string): number | undefined {
	const raw = Number(url.searchParams.get(name) ?? "");
	return Number.isFinite(raw) ? raw : undefined;
}

export function coreRoutes(deps: RouteDeps): readonly Route[] {
	const { app, hub } = deps;

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
			// 我和一个人开私聊。界面入口下一轮接，先开后端（ADR-097）。
			pattern: "/api/people/:slug/dm",
			method: "POST",
			handler: async ({ response, params }) => {
				return json(response, await app.chat.openDirectMessage(params.slug ?? ""));
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
		// 其余路径交给静态资源；找不到就 404（前端据此判断「是不是接口写错了」）。
		{
			pattern: "*rest",
			handler: async ({ request, response, path }) => {
				return await serveStatic(response, request, deps.uiDir, path);
			},
		},
	];
}
