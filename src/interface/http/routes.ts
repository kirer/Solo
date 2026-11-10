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
import { fromThisMachine } from "./local-origin.ts";
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
	/**
	 * 重置已经在用例层确认过了：这里只负责在响应发出去之后关库、删盘、退出。
	 * 由启动层（`shell/main.ts`）给；测试不给就是「只确认、不真删」。
	 */
	readonly onReset?: () => void;
	/**
	 * 重启应用：装完带前端的插件后，界面要重新加载才看得到它的入口。
	 * 和重置共用一个退出码，桌面壳收到就 `app.relaunch()`。
	 */
	readonly onRestart?: () => void;
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
	const { app, hub, onReset, onRestart } = deps;

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
			// 清空所有数据并重启（设置 → 数据）。确认归用例层；关库删盘是进程级的事，
			// 所以先把「好」发出去，再交给启动层 —— 库还开着的时候删不掉 core.sqlite。
			pattern: "/api/reset",
			method: "POST",
			handler: async ({ request, response }) => {
				const body = await readJson<{ confirm?: unknown }>(request);
				const result = app.reset.request(body?.confirm);
				json(response, result);
				setTimeout(() => onReset?.(), 200);
			},
		},
		{
			// 重启应用：插件前端入口只在启动时 import，装完带界面的插件必须重来一遍。
			// 和重置走同一条退出路径（退出码 75 → 桌面壳 `app.relaunch()`），但不删任何数据。
			pattern: "/api/restart",
			method: "POST",
			handler: async ({ request, response }) => {
				const body = await readJson<{ confirm?: unknown }>(request);
				if (body?.confirm !== true) return fail(response, 400, "重启需要明确确认");
				json(response, { ok: true, restarting: true });
				setTimeout(() => onRestart?.(), 200);
			},
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
			// 界面偏好（现在只有更新代理）：写进 settings.json，桌面壳下次检查更新时读它。
			pattern: "/api/preferences",
			method: "GET",
			handler: async ({ response }) => json(response, await app.preferences.read()),
		},
		{
			pattern: "/api/preferences",
			method: "POST",
			handler: async ({ request, response }) => {
				return json(response, await app.preferences.save(await readJson<unknown>(request)));
			},
		},
		{
			// 第一次打开：探一次接口通不通。只探不写，界面拿它画「已连通」。
			pattern: "/api/setup/probe",
			method: "POST",
			handler: async ({ request, response }) => {
				return json(response, await app.setup.check(await readJson<unknown>(request)));
			},
		},
		{
			// 第一次打开：把选中的模型写进 `settings.json`，当场生效（ADR-025）。
			pattern: "/api/setup",
			method: "POST",
			handler: async ({ request, response }) => {
				return json(response, await app.setup.save(await readJson<unknown>(request)));
			},
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
			// 失败卡上的「继续」：1.5.0 的 continue，不新增一条用户消息。
			pattern: "/api/people/:slug/continue",
			method: "POST",
			handler: async ({ response, params }) => {
				return json(response, await app.people.continuePerson(params.slug ?? ""));
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
			// 我拉一个群：成员由我指定，我自己一定在群里（ADR-063）。
			pattern: "/api/channels",
			method: "POST",
			handler: async ({ request, response }) => {
				const body = await readJson<{
					title?: string;
					members?: readonly string[];
					bulletin?: unknown;
					responder?: unknown;
				}>(request);
				return json(response, await app.chat.createGroup(body));
			},
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
		// 正文里的一个路径 → 待发附件（老板 2026-11-10）：发出去之前只活在附件目录里，
		// 没人引用就由 `sweep` 收走。路径校验走的是同一条 `files.preview`，没放宽。
		{
			pattern: "/api/files/stage",
			method: "POST",
			handler: async ({ request, response, url }) => {
				const body = await readJson<{ path?: unknown }>(request).catch(() => undefined);
				const path = typeof body?.path === "string" ? body.path : (url.searchParams.get("path") ?? "");
				return json(response, await app.uploads.stage(path));
			},
		},
		// 待发附件的「我还在用」自报（季衡 R3）：界面把挂在草稿上的 id 全量报上来，后端据此
		// 决定哪些能回收。只认 `staged-` 前缀，别的 id 写不进状态文件。
		{
			pattern: "/api/uploads/draft",
			method: "POST",
			handler: async ({ request, response }) => {
				const body = await readJson<{ ids?: unknown }>(request).catch(() => undefined);
				const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
				await app.uploads.draftFiles(ids);
				return json(response, { ok: true });
			},
		},
		// 丢掉了（删草稿 / 点叉）：立刻删盘，不等下一轮扫。幂等。
		{
			pattern: "/api/uploads/drop",
			method: "POST",
			handler: async ({ request, response }) => {
				const body = await readJson<{ ids?: unknown }>(request).catch(() => undefined);
				const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
				await app.uploads.drop(ids);
				return json(response, { ok: true });
			},
		},
		// 消息里点到的文件：读一眼（图片 / PDF / 文本）。没有就 404，不能预览就 415，
		// 两种都由界面把后端那句话原样摆出来 —— 别让一句路径变成一个死链接。
		{
			pattern: "/api/files/preview",
			method: "GET",
			handler: async ({ response, url }) => {
				const file = await app.files.preview(url.searchParams.get("path") ?? "");
				if (file.kind === "none") return fail(response, file.status, file.reason);
				response.writeHead(200, {
					"Content-Type": file.mime,
					"Content-Length": String(file.size),
					// 文件随时会改，不做长缓存；同源内容不许被嗅探成 HTML。
					"Cache-Control": "no-cache",
					"X-Content-Type-Options": "nosniff",
					// `路径:77` 的行号：走响应头而不是塞进正文，正文还是原样的文件内容。
					// 只读预览，界面拿到行号自己去定位。
					...(file.line === undefined ? {} : { "X-Solo-Line": String(file.line) }),
				});
				return await pipeline(createReadStream(file.path), response);
			},
		},
		// 取附件：图片内联（点缩略图开大图才能直接显示），其余一律下载。
		{
			pattern: "/api/uploads/:id",
			method: "GET",
			handler: async ({ response, url, params }) => {
				const file = await app.uploads.read(params.id ?? "", {
					download: url.searchParams.get("download") === "1",
					preview: url.searchParams.get("preview") === "1",
				});
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
				// 面板只要最近 N 轮；上限 100，免得一次把整个人的历史搬过来。
				const limit = Math.min(Math.max(numberParam(url, "limit") ?? 30, 1), 100);
				return json(response, await app.read.readPersonTurns(params.slug ?? "", from, to, false, limit));
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
			// 改频道的共享指令 / 接话规则。`null` 清掉，缺省不动。
			pattern: "/api/channels/:id",
			method: "PATCH",
			handler: async ({ request, response, params }) => {
				const body = await readJson<{ bulletin?: unknown; responder?: unknown }>(request);
				return json(response, await app.chat.updateChannel(params.id ?? "", body));
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
			// 落 `<appRoot>/logs/jank.jsonl`，满了轮转一代。
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
			// 装 / 卸都只动 `<appRoot>/plugins/`，重启才真的运行。
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
			// 用户自己删掉的出厂插件：界面上「装回来」能挑这些（不是盘上所有缺的）。
			pattern: "/api/plugins/removed",
			method: "GET",
			handler: async ({ response }) => json(response, { removed: await app.plugins.removed() }),
		},
		{
			// 把删掉的出厂插件装回来（用出厂那份）。装完重新加载，返回的是新的插件清单。
			pattern: "/api/plugins/:slug/restore",
			method: "POST",
			handler: async ({ response, params }) => {
				try {
					return json(response, { plugins: await app.plugins.restore(params.slug ?? "") });
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
			// 一个插件还要问人哪几条权限（连人话）。装完 / 插件升级之后界面拿它弹确认。
			pattern: "/api/plugins/:slug/permissions",
			method: "GET",
			handler: async ({ request, response, params }) =>
				json(response, {
					pending: await app.plugins.pending(params.slug ?? ""),
					// 网页版后端做不了系统动作；局域网里打开的页面也批不了（那个请求到不了本机效果）。
					canSystem: app.plugins.canSystem() && fromThisMachine(request),
				}),
		},
		{
			// 批权限：`granted` 是批准之后的**完整名单**（不是增量）。写回 `plugin.md` 当场重装。
			pattern: "/api/plugins/:slug/permissions",
			method: "POST",
			handler: async ({ request, response, params }) => {
				// 批准权限 = 放开一个本机效果：只认本机发起的请求，局域网里打开页面点不了。
				if (!fromThisMachine(request)) return fail(response, 403, "只能从这台机器上批准");
				const body = await readJson<{ granted?: unknown }>(request);
				const granted = Array.isArray(body?.granted) ? body.granted : [];
				if (!granted.every((name) => typeof name === "string")) {
					return fail(response, 400, "granted 要一组权限名");
				}
				try {
					return json(response, {
						plugins: await app.plugins.grant(
							params.slug ?? "",
							granted.map((name) => String(name)),
						),
					});
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
		{
			/**
			 * 插件的前端静态资源（AEC3 的 wasm）。
			 *
			 * 文件名在 `app` 那边是白名单，`../` 与不认识的名字都到不了磁盘。
			 * 名字里含版本号，所以内容不会变 —— 放心长缓存 + immutable，
			 * 升级换了文件名就是换了 URL，浏览器不会拿旧 wasm 配新 JS。
			 */
			pattern: "/api/plugins/:slug/assets/:asset",
			method: "GET",
			handler: async ({ response, request, params }) => {
				const asset = await app.plugins.clientAsset(params.slug ?? "", params.asset ?? "");
				if (asset === undefined) {
					response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
					response.end("没有这个插件资源");
					return;
				}
				// 文件本身在 `ui/web/`（构建时从 `node_modules` 拷过去，不进 `seed/`），
				// 所以真发送交给静态资源那套：条件请求、br/gzip、ETag 都是白拿的。
				return await serveStatic(response, request, deps.uiDir, `/${asset}`);
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
