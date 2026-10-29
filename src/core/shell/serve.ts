/**
 * 网页服务：HTTP + SSE。
 *
 * 这是**外壳**，不是核心。核心（`src/core/**`）只有文件夹、频道、消息三样事实；
 * 这一层负责把它们翻译成浏览器能吃的 JSON，并处理一个 HTTP 服务该处理的杂事
 * （静态资源、压缩、SSE 心跳）。
 *
 * 路由只有一张表，每条背后都是「读一份文档」「写一条消息」或「存取一个附件」。没有待办、任务、
 * 成本、升级链、看门狗、受理回执 —— 那些东西核心里一个都没有，所以这里也不该有。
 * 路径带 `:id` 的匹配器在 `./http/routes.ts`（纯函数，无业务概念）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";
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
import { ChannelDoc, markRead, type Attachment, type ChannelState } from "../channel/state.ts";
import { setChannelStreamHook, setChannelClientsHas } from "../channel/post.ts";
import type { CoreShell } from "./assemble.ts";
import { appendMemory, memoryDigest, readMemory, sectionsOf, writeMemory } from "../agent/memory.ts";
import { listSkills } from "../agent/skills.ts";
import { attentionItems, channelDetail, channelList, labelIn, messageView, orgView, withLabels } from "./view.ts";
import {
	UPLOAD_MAX_BYTES,
	UPLOAD_PER_MESSAGE,
	UploadTooLargeError,
	contentDisposition,
	kindOfMime,
	mimeOf,
	nameFrom,
	placeholderOf,
	putUpload,
	readBounded,
	readUploadMeta,
	uploadPathOf,
	uploadsRootOf,
} from "../channel/uploads.ts";

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
	// 附件根跟着工作区走：`<workspace>/uploads`（agentsRoot 是 `<workspace>/agents`）。
	const uploadsRoot = uploadsRootOf(shell.agentsRoot);
	const workspaceRoot = dirname(shell.agentsRoot);
	const orgClients = new Set<ServerResponse>();
	let orgTimer: NodeJS.Timeout | undefined;

	// T-016：按频道的 SSE 连接（channelId → 连接集合）。消息增量只推给订阅了该频道的浏览器。
	const channelClients = new Map<string, Set<ServerResponse>>();
	const channelTimers = new Map<string, NodeJS.Timeout>();
	// 每个 SSE 连接在每个频道上「已经推到第几条」。
	//
	// 原来的做法是每次提交都把**最后 60 条**重推一遍。实测：一次运行 15 秒里推了 1620 条
	// create 事件、51,359 个 DOM 节点被加进去又删掉、浏览器最长一次卡 2.7 秒。
	// 增量就该是增量：只推比这个游标新的，外加最后几条（占位填充要能原地覆盖）。
	const channelSeqs = new WeakMap<ServerResponse, Map<string, number>>();
	const RECENT_RESEND = 4;
	function cursorOf(client: ServerResponse, id: string): number | undefined {
		return channelSeqs.get(client)?.get(id);
	}
	function setCursorOf(client: ServerResponse, id: string, seq: number): void {
		let map = channelSeqs.get(client);
		if (map === undefined) {
			map = new Map();
			channelSeqs.set(client, map);
		}
		map.set(id, seq);
	}

	// T-016 v2：把「占位填充 → 逐字增量推送」接到 post.ts 的钩子上（避免循环依赖：post 不 import serve）。
	// 前端拿到 token 分片后渐显，最终以 done 全文兜底（刷新/丢包不漏字）。
	setChannelStreamHook((channelId, seq, fullText) => {
		let acc = 0;
		const step = Math.max(1, Math.ceil(fullText.length / 24));
		const emitToken = (from: number, to: number) => {
			const delta = fullText.slice(from, to);
			if (delta.length === 0) return;
			const clients = channelClients.get(channelId);
			if (clients === undefined || clients.size === 0) return;
			const payload = `event: token\ndata: ${JSON.stringify({ seq, delta })}\n\n`;
			for (const client of [...clients]) {
				try { client.write(payload); } catch { clients.delete(client); }
			}
		};
		// 把全文切成最多 24 片，错峰推（每片 18ms），模拟逐字；末片后补 done 全文兜底。
		const timer = setInterval(() => {
			if (acc >= fullText.length) {
				clearInterval(timer);
				channelTimers.delete(`tok:${channelId}:${seq}`);
				const clients = channelClients.get(channelId);
				if (clients !== undefined && clients.size > 0) {
					const done = `event: done\ndata: ${JSON.stringify({ seq, text: fullText, status: "done" })}\n\n`;
					for (const client of [...clients]) {
						try { client.write(done); } catch { clients.delete(client); }
					}
			}
			return;
		}
		emitToken(acc, Math.min(fullText.length, acc + step));
		acc = Math.min(fullText.length, acc + step);
		}, 18);
		channelTimers.set(`tok:${channelId}:${seq}`, timer);
	});
	setChannelClientsHas((channelId) => (channelClients.get(channelId)?.size ?? 0) > 0);

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
		// 一句话现状与负责人同源（同一份项目文档），所以是同一个快照里的一张表。
		const doings = new Map<string, string | undefined>(projects.map((project) => [project.slug, project.doing]));
		const projectDoingOf = (project: string) => doings.get(project);
		return { identities, directory, channels, projectOwnerOf, projectDoingOf };
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

	/**
	 * T-016：向某个频道的所有 SSE 连接推一次该频道消息尾巴的增量（create 事件，带 status/text）。
	 * 前端按 seq 幂等 upsert：新 seq 插入、已有 seq 覆盖（占位 pending → 填充后 done 靠这里覆盖，无需 runtime 钩子）。
	 * 只推「当前有连接的频道」，避免无谓扫描；连接建立时也会立即调一次做全量补齐。
	 */
	async function pushChannel(id: string): Promise<void> {
		const clients = channelClients.get(id);
		if (clients === undefined || clients.size === 0) return;
		let views: { seq: number; line: string }[];
		try {
			const { directory, channels } = await snapshot();
			const channel = channels.channels[id];
			if (channel === undefined) return;
			const list = channels.messages[id] ?? [];
			const tail = list.slice(Math.max(0, list.length - 60));
			views = tail.map((message) => {
				const view = messageView(channels, channel, message, directory, OWNER_SLUG);
				return { seq: message.seq, line: `event: create\ndata: ${JSON.stringify(view)}\n\n` };
			});
		} catch {
			return;
		}
		const newest = views.length > 0 ? views[views.length - 1]!.seq : 0;
		for (const client of [...clients]) {
			// 没有游标 = 刚连上来，给全量（界面上翻靠 `/api/channels/:id?before=`，这 60 条只是首屏）。
			const since = cursorOf(client, id);
			const wanted = since === undefined ? views : views.filter((view) => view.seq > since - RECENT_RESEND);
			if (wanted.length === 0) continue;
			try {
				client.write(wanted.map((view) => view.line).join(""));
				setCursorOf(client, id, newest);
			} catch {
				clients.delete(client);
			}
		}
	}

	/** T-016：按频道去抖推增量（一次提交可能连带几次改动）。 */
	function scheduleChannel(id: string): void {
		if (channelClients.get(id)?.size === 0) return;
		const existing = channelTimers.get(id);
		if (existing !== undefined) return;
		const timer = setTimeout(() => {
			channelTimers.delete(id);
			void pushChannel(id);
		}, 120);
		channelTimers.set(id, timer);
	}

	// 任何文档提交都推一次：新消息、新 agent、改名，界面都会跟着变。
	const unsubscribe = shell.harness.subscribeCommits(() => {
		scheduleOrg();
		// T-016：任何提交都可能改变某频道的占位状态（如 A 填充占位），对活跃频道排增量。
		for (const id of channelClients.keys()) scheduleChannel(id);
	});

	/** 老板在频道里说话。 */
	async function postChannelMessage(channelId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson<{
			text?: string;
			replyTo?: number;
			from?: string;
			kind?: string;
			attachments?: readonly { id?: unknown }[];
		}>(request);
		const channels = (await shell.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) ?? emptyChannels();
		if (channels.channels[channelId] === undefined) return fail(response, 404, "频道不存在");

		// 附件只收 id：客户端给的 `name` / `kind` 一律不用 —— 名字取磁盘上的元数据，
		// 类别按 mime 重算。信任客户端声明的 kind，等于让一个 .svg 自称图片后内联执行。
		const requested = Array.isArray(body.attachments) ? body.attachments : [];
		if (requested.length > UPLOAD_PER_MESSAGE) {
			return fail(response, 400, `一条消息最多带 ${UPLOAD_PER_MESSAGE} 个附件`);
		}
		const attachments: Attachment[] = [];
		for (const raw of requested) {
			// `["<id>"]` 和 `[{ id: "<id>" }]` 都收：前者是 curl / 脚本的自然写法，后者
			// 是前端的写法（它顺手带着 name/kind 方便乐观渲染）。两种都只取 id。
			const id = typeof raw === "string" ? raw : typeof raw?.id === "string" ? raw.id : "";
			const meta = await readUploadMeta(uploadsRoot, id);
			if (meta === undefined) return fail(response, 400, "附件不存在（可能已经被清理），重新发一次");
			attachments.push({ id, name: meta.name, kind: kindOfMime(meta.mime), bytes: meta.bytes });
		}

		// 纯附件（没写正文）也允许发：占位文案必须是**非空**且确定的，否则下游按「正文非空」
		// 过滤的地方（接力计数、占位吸收、未读）会把这条消息当成不存在。
		const typed = (body.text ?? "").trim();
		const text = typed === "" ? placeholderOf(attachments) : typed;
		if (text === "") return fail(response, 400, "需要 text 或附件");

		// 发件人：默认老板；带 `from` 时按 agent 处理（调试/脚本用，界面上永远不传）。
		const from = (body.from ?? "").trim() === "" ? OWNER_SLUG : (body.from as string).trim();
		try {
			// 附件必须**随消息一起**交给写入层：投递要用它把图片读成内容块交给模型。
			// 事后补字段（旧做法）能显示，但模型看不见 —— 于是它只能回「我读不了图」。
			const result = await shell.postAs({
				channelId,
				from,
				text,
				...(typeof body.replyTo === "number" ? { replyTo: body.replyTo } : {}),
				// 语义标签由说话的人自己声明：项目频道里带 `decision` 的话才会进项目记忆。
				...(typeof body.kind === "string" && body.kind !== "" ? { kind: body.kind } : {}),
				...(attachments.length === 0 ? {} : { attachments }),
			});
			scheduleOrg();
			scheduleChannel(channelId);
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
			// 一个人的全部档案：界面右上角那个「详情」面板一次要的东西都在这。
			// 不给界面对磁盘的访问权（它会拿 slug 拼路径），也不让它自己去读技能目录。
			pattern: "/api/people/:slug",
			method: "GET",
			handler: async ({ response, params }) => {
				const { identities, directory } = await snapshot();
				const slug = params.slug ?? "";
				if (!(slug in directory.slugToConversation) || slug === OWNER_SLUG) {
					return fail(response, 404, "没有这个人");
				}
				const state = await shell.channels();
				const skills = await listSkills(
					{ workspace: dirname(shell.agentsRoot), agents: shell.agentsRoot },
					slug,
				);
				const identity = identities.find((candidate) => candidate.slug === slug);
				const source = (await readMemory(join(shell.agentsRoot, slug))) ?? "";
				return json(response, {
					slug,
					label: labelIn(directory, slug),
					title: identity?.title ?? "",
					...(identity?.project === undefined ? {} : { project: identity.project }),
					manager: identity?.manager ?? "",
					managerLabel: identity?.manager === undefined ? "" : labelIn(directory, identity.manager),
					body: identity?.body ?? "",
					skills: skills.map((skill) => ({
						name: skill.name,
						description: skill.description,
						scope: skill.scope,
						overrides: skill.overrides === true,
					})),
					memory: {
						exists: source !== "",
						entries: sectionsOf(source).length,
						digest: memoryDigest(source) ?? null,
					},
					// 他在哪些频道里。`members` 是真相，界面不用自己比。频道「是什么类型」
					// 不在文档里，是 id 前缀的约定（`company` / `leadership` / `proj:` / `dm:`）。
					channels: Object.values(state.channels ?? {})
						.filter((channel) => channel.members.includes(slug))
						.map((channel) => ({ id: channel.id, kind: channelKind(channel.id), title: channel.title })),
				});
			},
		},
		{
			pattern: "/api/people/:slug/memory",
			method: "GET",
			handler: async ({ response, params }) => {
				const { directory } = await snapshot();
				const slug = params.slug ?? "";
				// 只认名册里的 slug —— 这既挡住了路径穿越，也让「查一个不存在的人」
				// 老实回 404，而不是先建出一个空目录。
				if (!(slug in directory.slugToConversation) || slug === OWNER_SLUG) {
					return fail(response, 404, "没有这个人");
				}
				const source = (await readMemory(join(shell.agentsRoot, slug))) ?? "";
				return json(response, {
					slug,
					label: withLabels(directory, []).labels?.[slug] ?? slug,
					exists: source !== "",
					digest: memoryDigest(source) ?? null,
					entries: sectionsOf(source).map((section) => ({ heading: section.heading, body: section.body })),
					raw: source,
				});
			},
		},
		{
			pattern: "/api/people/:slug/memory",
			method: "POST",
			handler: async ({ request, response, params }) => {
				const { directory } = await snapshot();
				const slug = params.slug ?? "";
				if (!(slug in directory.slugToConversation) || slug === OWNER_SLUG) {
					return fail(response, 404, "没有这个人");
				}
				const agentDir = join(shell.agentsRoot, slug);
				const body = await readJson<{ op?: string; heading?: string; text?: string }>(request);
				if (body.op === "forget") {
					const heading = body.heading ?? "";
					const source = (await readMemory(agentDir)) ?? "";
					const sections = sectionsOf(source);
					if (!sections.some((section) => section.heading === heading)) {
						return fail(response, 404, "没有这一条记忆（可能已经被删掉）");
					}
					const head = source.split("\n").slice(0, source.split("\n").findIndex((line) => line === `## ${heading}`));
					const kept = sections.filter((section) => section.heading !== heading);
					const next = [...head, ...kept.flatMap((section) => [`## ${section.heading}`, section.body, ""])]
						.join("\n")
						.trimEnd();
					const result = await writeMemory(agentDir, next, "owner");
					return json(response, { ok: true, entries: sectionsOf(result.source).length });
				}
				if (body.op === "add") {
					const result = await appendMemory(agentDir, body.text ?? "", new Date(), "owner");
					if (!result.changed) return fail(response, 400, result.message);
					return json(response, { ok: true, entries: sectionsOf(result.source).length });
				}
				return fail(response, 400, "op 只能是 forget 或 add");
			},
		},
		{
			pattern: "/api/channels",
			method: "GET",
			handler: async ({ response }) => {
				const { directory, channels, projectOwnerOf, projectDoingOf } = await snapshot();
				const list = channelList(channels, directory, OWNER_SLUG, projectOwnerOf, projectDoingOf);
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
			pattern: "/api/attention",
			method: "GET",
			handler: async ({ response }) => {
				const { directory, channels } = await snapshot();
				const items = attentionItems(channels, directory);
				return json(response, {
					items,
					unread: items.filter((item) => !item.read).length,
				});
			},
		},
		// 上传：正文就是文件本身（不是 multipart）。不解析 multipart 是故意的 ——
		// 名字走 `x-filename` 头、类型走 `content-type`，两行代码就能确定落盘的一切，
		// 而 multipart 边界解析是几百行需要单独审的解析器。
		{
			pattern: "/api/uploads",
			method: "POST",
			handler: async ({ request, response, url }) => {
				const headerName = request.headers["x-filename"];
				const name = nameFrom(typeof headerName === "string" ? headerName : undefined, url.searchParams.get("name"));
				const mime = mimeOf(request.headers["content-type"]);
				let bytes: Buffer;
				try {
					bytes = await readBounded(request as AsyncIterable<Uint8Array>);
				} catch (error) {
					if (error instanceof UploadTooLargeError) {
						return fail(response, 413, `单个附件最大 ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)}MB，这个太大了`);
					}
					throw error;
				}
				if (bytes.length === 0) return fail(response, 400, "附件是空的");
				const attachment = await putUpload(uploadsRoot, { name, mime, bytes, at: Date.now() });
				return json(response, attachment);
			},
		},
		// 取附件：图片内联（点缩略图开大图才能直接显示），其余一律下载。
		{
			pattern: "/api/uploads/:id",
			method: "GET",
			handler: async ({ response, url, params }) => {
				const id = params.id ?? "";
				// 白名单 id 同时挡住了路径穿越：`../core.sqlite` 在 `:id` 里捕获不到 `/`，
				// 但 `..%2f` 能被解码回来，所以还是靠 `isUploadId` 再收一道。
				const path = uploadPathOf(uploadsRoot, id);
				const meta = await readUploadMeta(uploadsRoot, id);
				if (path === undefined || meta === undefined) return fail(response, 404, "没有这个文件");
				const inline = url.searchParams.get("download") !== "1" && kindOfMime(meta.mime) === "image";
				response.writeHead(200, {
					"Content-Type": meta.mime,
					"Content-Length": String(meta.bytes),
					// id 是新建时分配的 uuid，内容永不改，所以可以长时间缓存。
					"Cache-Control": "public, max-age=31536000, immutable",
					"Content-Disposition": contentDisposition(inline, meta.name),
					// 附件是同源内容，不能让它被嗅探成 HTML：一个自称图片的文本文件
					// 一旦当页面执行，就是自己给自己开了一个 XSS。
					"X-Content-Type-Options": "nosniff",
				});
				return await pipeline(createReadStream(path), response);
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
				const { directory, channels, projectOwnerOf, projectDoingOf } = await snapshot();
				const channel = channels.channels[params.id ?? ""];
				if (channel === undefined) return fail(response, 404, "频道不存在或无权查看");
				const limit = Number(url.searchParams.get("limit") ?? "");
				const before = Number(url.searchParams.get("before") ?? "");
				return json(
					response,
					channelDetail(channels, channel, directory, {
						projectOwnerOf,
						projectDoingOf,
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
			pattern: "/api/channels/:id/stream",
			method: "GET",
			handler: ({ response, url, params }) => {
				// `?since=N` = 「我已经有到 N 了」。客户端开着页面刷新时带上它，
				// 服务端就只补 N 之后的消息，不再把 60 条历史重发一遍。
				//
				// 不带的话（第一次打开、没有 detail）就连历史一起推 —— 那是首屏补齐。
				const since = Number(url.searchParams.get("since") ?? "");
				return streamChannel(response, params.id ?? "", Number.isFinite(since) && since > 0 ? since : undefined);
			},
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
			// 浏览器自己报上来的卡顿（`ui/web/js/jank.js`）。
			//
			// 老板两次报「agent 在跑的时候页面卡死」，而我在无头 Chrome 里量出来是
			// 「长任务 0、最慢帧 17ms」—— 两边对不上，靠猜猜不完。让浏览器在真卡的时候
			// 把「卡了多久、当时在干什么」写到 `workspace/logs/jank.jsonl`，复现一次就能读。
			pattern: "/api/diag",
			method: "POST",
			handler: async ({ request, response }) => {
				const body = await readJson<{ kind?: string; entries?: unknown }>(request);
				try {
					await mkdir(join(workspaceRoot, "logs"), { recursive: true });
					await appendFile(join(workspaceRoot, "logs", "jank.jsonl"), `${JSON.stringify({ ...body, at: new Date().toISOString() })}\n`);
				} catch {
					/* 诊断写不进去不该影响任何事 */
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

	function streamChannel(response: ServerResponse, id: string, since?: number): void {
		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		response.write("retry: 1500\n\n");
		let clients = channelClients.get(id);
		if (clients === undefined) {
			clients = new Set<ServerResponse>();
			channelClients.set(id, clients);
		}
		clients.add(response);
		// 客户端说「我已经有到 N 了」：把游标设到 N，`pushChannel` 就只推 N 之后的。
		//
		// 不设的话，刷新页面会再收一遍最近 60 条历史 —— 那 60 条里有 20 来条比已加载窗口
		// 更早，前端只能把它们追加到列表**末尾**，于是一刷新频道就变成
		// 「最新的在上面、更早的在最下面」的乱序（实测 60 行里 20 行错位）。
		if (since !== undefined) setCursorOf(response, id, since + RECENT_RESEND);
		// 连接建立即推补齐（首屏全量；带 since 时只补增量）。
		void pushChannel(id);
		const keepAlive = setInterval(() => {
			try {
				response.write(": ping\n\n");
			} catch {
				clearInterval(keepAlive);
				clients?.delete(response);
			}
		}, 15_000);
		response.on("close", () => {
			clearInterval(keepAlive);
			clients?.delete(response);
			if (clients !== undefined && clients.size === 0) channelClients.delete(id);
		});
	}

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
			for (const set of channelClients.values()) {
				for (const client of set) {
					try {
						client.end();
					} catch {
						/* 已断 */
					}
				}
			}
			channelClients.clear();
			for (const timer of channelTimers.values()) clearTimeout(timer);
			channelTimers.clear();
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
		// 只有字体和图片敢让浏览器先用旧的：它们的文件名就是内容（`plex-sans-400`、`宽图.png`），
		// 换内容一定换名字。`js` / `css` / `html` 全部 `no-cache` —— 有 ETag 与
		// Last-Modified 兜底，命中就是 304（正文 0 字节），代价是一次条件请求；
		// 但换来的是「改完刷新一定拿到新代码」。早先是 `max-age=300`，结果改完
		// 五分钟内刷新仍然是旧 JS —— 调试时 indistinguishable，白查半小时。
		"Cache-Control": /[.](?:js|css|html)$/i.test(relative)
			? "no-cache"
			: "public, max-age=31536000, immutable",
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

/** 频道 id 前缀 → 类型。文档里不存 kind，约定在 id 上（见 `channel/state.ts` 的 `channelIdOf`）。 */
function channelKind(id: string): "company" | "leadership" | "project" | "dm" | "other" {
	if (id === "all") return "company";
	if (id === "leadership") return "leadership";
	if (id.startsWith("proj:")) return "project";
	if (id.startsWith("dm:")) return "dm";
	return "other";
}
