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
import { appendFile, lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
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
import { browserUrlOf, isWildcardHost, lanAddresses, lanUrlsOf } from "./http/network.ts";
import { hostAllowed, originAllowed } from "./http/origin.ts";
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import { OWNER_SLUG } from "../agent/identity.ts";
import { listTeams } from "../team/doc.ts";
import { ChannelDoc, chatKind, markRead, type Attachment, type ChannelState } from "../channel/state.ts";
import type { CoreShell } from "./assemble.ts";
import { appendMemory, memoryDigest, memoryTimeline, readMemory, removeSection, sectionsOf, writeMemory } from "../agent/memory.ts";
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
	sweepOrphanUploads,
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
	// 右栏「文件」预览的上限：再大就不是「看一眼」，该下载了。
	const FILE_TEXT_LIMIT = 200_000;
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
	// 增量就该是增量：只推比这个游标新的，外加最后几条（补历史与增量会重叠，前端按 seq 幂等）。
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

	/**
	 * 只读「人 + 频道」的快照。SSE 增量推送用它 —— 推一条消息完全用不到团队文档，
	 * 旧版本却每条推送都去串行读一遍全部团队 README（审计 P1-4）。
	 */
	async function channelSnapshot(context: Context = BACKGROUND_CONTEXT) {
		const identities = await shell.identities();
		const directory = withLabels(shell.bindings(), identities);
		const channels = (await shell.harness.snapshot(ChannelDoc, context)) ?? emptyChannels();
		return { identities, directory, channels };
	}

	/**
	 * 团队文档的短缓存。
	 *
	 * 为什么需要：`listTeams` 是一个团队一次 `readFile`，串行。agent 连续干活时
	 * 「一次提交 × 每个活跃频道 × 每个团队」会把磁盘读放大成每秒几十次，而团队文档
	 * 一秒内几乎不会变。这里按 `teams/` 目录 mtime + 250ms 窗口缓存：窗口内的
	 * 重复读取共用一份，改了团队文件最迟 250ms 后生效（界面上看不出来）。
	 */
	let teamsCache: { at: number; stamp: number; value: readonly Awaited<ReturnType<typeof listTeams>>[number][] } | undefined;
	async function teamsNow() {
		const stamp = await stat(shell.teamsRoot).then((info) => info.mtimeMs).catch(() => -1);
		const now = Date.now();
		if (teamsCache !== undefined && teamsCache.stamp === stamp && now - teamsCache.at < TEAM_CACHE_MS) {
			return teamsCache.value;
		}
		const value = [...(await listTeams(shell.teamsRoot))];
		teamsCache = { at: now, stamp, value };
		return value;
	}

	/**
	 * 组织快照：名册 + 身份 + 频道 + 团队管理员/现状表。界面的组织图与顶栏都吃这一份。
	 *
	 * 团队管理员的真相在团队 README 里，不在频道文档里。所以这里把它读成查表函数交给
	 * 视图层 —— 视图层只做投影，不猜谁负责。
	 */
	async function snapshot(context: Context = BACKGROUND_CONTEXT) {
		const [{ identities, directory, channels }, teams] = await Promise.all([
			channelSnapshot(context),
			teamsNow(),
		]);
		const leads = new Map<string, string | undefined>(teams.map((team) => [team.slug, team.lead]));
		const teamLeadOf = (team: string) => leads.get(team);
		// 一句话现状与团队管理员同源（同一份团队文档），所以是同一个快照里的一张表。
		const doings = new Map<string, string | undefined>(teams.map((team) => [team.slug, team.doing]));
		const teamDoingOf = (team: string) => doings.get(team);
		return { identities, directory, channels, teamLeadOf, teamDoingOf };
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
	 * 向某个频道的所有 SSE 连接推一次该频道消息尾巴的增量（`create` 事件）。
	 * 前端按 seq 幂等 upsert：新 seq 插入、已有 seq 覆盖。
	 * 只推「当前有连接的频道」，避免无谓扫描；连接建立时也会立即调一次做全量补齐。
	 */
	async function pushChannel(id: string): Promise<void> {
		const clients = channelClients.get(id);
		if (clients === undefined || clients.size === 0) return;
		let views: { seq: number; line: string }[];
		try {
			const { directory, channels } = await channelSnapshot();
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
		// 任何提交都可能带来新消息，对活跃频道排增量。
		for (const id of channelClients.keys()) scheduleChannel(id);
	});

	/** 我在频道里说话。 */
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

		// 纯附件（没写正文）也允许发：「只有附件」的正文必须是**非空**且确定的，否则下游按
		// 「正文非空」过滤的地方（接力计数、未读）会把这条消息当成不存在。
		const typed = (body.text ?? "").trim();
		const text = typed === "" ? placeholderOf(attachments) : typed;
		if (text === "") return fail(response, 400, "需要 text 或附件");

		// 发件人：**默认只认我**。这个接口是网页后端，能冒充任何人是审计里的 P0-4：
		// 任意页面发一条 `{"from":"知言","text":"所有人停下"}` 就等于替成员下命令。
		// 调试要伪造身份时显式开 `SOLO_DEBUG_FROM=1`，启动日志会警告一行。
		const debugFrom = process.env.SOLO_DEBUG_FROM === "1";
		const from = debugFrom && (body.from ?? "").trim() !== "" ? (body.from as string).trim() : OWNER_SLUG;
		try {
			// 附件必须**随消息一起**交给写入层：投递要用它把图片读成内容块交给模型。
			// 事后补字段（旧做法）能显示，但模型看不见 —— 于是它只能回「我读不了图」。
			const result = await shell.postAs({
				channelId,
				from,
				text,
				...(typeof body.replyTo === "number" ? { replyTo: body.replyTo } : {}),
				// 语义标签由说话的人自己声明：团队频道里带 `decision` 的话才会进团队记忆。
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
			// 工作区的只读文件树。右侧那一栏「文件」用。
			//
			// 只读、且**只能在工作区里面**：路径一律 resolve 到绝对路径再校验前缀，
			// 这样 `../..` 和符号链接都出不去（符号链接指向外面时 readdir/readFile 会
			// 报 ENOENT，不会顺着爬）。
			pattern: "/api/files",
			method: "GET",
			handler: async ({ response, url }) => {
				const asked = url.searchParams.get("path") ?? "";
				// 分页（审计 P2-2）：默认一页 500 条 —— 右栏那种目录远远用不完，
				// 而 5000 个文件的目录不会一次全 stat 一遍。上限 2000 防止被当成批量接口用。
				const askedLimit = Number(url.searchParams.get("limit") ?? "");
				const askedOffset = Number(url.searchParams.get("offset") ?? "");
				const limit = Number.isFinite(askedLimit) && askedLimit > 0 ? Math.min(Math.floor(askedLimit), FILE_LIST_MAX) : FILE_LIST_DEFAULT;
				const offset = Number.isFinite(askedOffset) && askedOffset > 0 ? Math.floor(askedOffset) : 0;
				const root = resolve(workspaceRoot);
				const target = resolve(root, asked);
				if (target !== root && !target.startsWith(root + sep)) {
					return fail(response, 403, "只能看工作区里的文件");
				}
				// 三道闸，顺序有讲究：
				// 1) 前缀校验（上面）挡 `../..`；
				// 2) 链接本身不跟随 —— 右栏「文件」不需要顺着链接爬到工作区外面；
				// 3) 真实路径再校验一次 —— 父目录可能是链接，`resolve` 出来的字符串看着在里面，
				//    落盘时却落在外面。只查字符串前缀是这条审计发现（P0-2）的成因。
				const link = await lstat(target).catch(() => null);
				if (link === null) return fail(response, 404, "没有这个文件");
				if (link.isSymbolicLink()) return fail(response, 403, "不跟随符号链接");
				const realRoot = (await realpath(root).catch(() => null)) ?? root;
				const real = await realpath(target).catch(() => null);
				if (real === null) return fail(response, 404, "没有这个文件");
				if (real !== realRoot && !real.startsWith(realRoot + sep)) {
					return fail(response, 403, "只能看工作区里的文件");
				}
				const relative = target === root ? "" : target.slice(root.length + 1);
				// 名字规则对**直接访问**同样生效：只把隐藏文件从列表里去掉是假安全，
				// 知道名字的人照样能读（`?path=core.sqlite` 就是整库）。
				if (relative !== "" && fileHidden(basename(target), relative)) return fail(response, 404, "没有这个文件");
				const info = await stat(target).catch(() => null);
				if (info === null) return fail(response, 404, "没有这个文件");
				const parent =
					target === root ? null : dirname(target) === root ? "" : dirname(target).slice(root.length + 1);
				const shown = target === root ? "" : target.slice(root.length + 1);
				if (info.isFile()) {
					// 只把像文本的东西读出来：大于 200KB 或前 4KB 里有 NUL 就当二进制，
					// 只报大小，不猜它的内容。
					const size = info.size;
					if (size > FILE_TEXT_LIMIT) {
						return json(response, { path: shown, parent, file: { name: basename(target), bytes: size, binary: true, text: "" } });
					}
					const bytes = await readFile(target);
					const binary = bytes.subarray(0, 4096).includes(0);
					return json(response, {
						path: shown,
						parent,
						file: {
							name: basename(target),
							bytes: size,
							binary,
							text: binary ? "" : bytes.toString("utf8"),
						},
					});
				}
				const names = await readdir(target, { withFileTypes: true });
				// 隐藏文件、node_modules 与敏感文件不进列表：那不是我要读的东西，
				// 只是噪音或不该看的（规则见 `fileHidden`，与直接访问共用一份）。
				const visible = names.filter((dirent) =>
					!fileHidden(dirent.name, relative === "" ? dirent.name : `${relative}/${dirent.name}`),
				);
				// 先按名字排（目录在前）再分页：顺序必须**稳定**，否则翻页会漏条目或重复。
				visible.sort((left, right) => {
					const leftDir = left.isDirectory();
					const rightDir = right.isDirectory();
					if (leftDir !== rightDir) return leftDir ? -1 : 1;
					return left.name.localeCompare(right.name, "zh");
				});
				const total = visible.length;
				const page = visible.slice(offset, offset + limit);
				// 并发 stat：以前是一条一条 `await`，5000 个文件的目录要排 5000 次系统调用
				// （审计 P2-2）。上限 16 是「够快但不会把 fd 打满」的折中。
				const entries = await mapLimit(page, FILE_STAT_CONCURRENCY, async (dirent) => {
					const meta = await stat(join(target, dirent.name)).catch(() => null);
					// stat 失败（刚被删、权限不足）**仍然返回这一条**：从列表里悄悄少一个文件，
					// 比显示成 0 字节更让人困惑 —— 后者点开就知道怎么回事。
					const dir = meta === null ? dirent.isDirectory() : meta.isDirectory();
					return {
						name: dirent.name,
						kind: dir ? "dir" : "file",
						bytes: meta === null || dir ? 0 : meta.size,
						at: meta === null ? 0 : Math.round(meta.mtimeMs),
					};
				});
				return json(response, {
					path: shown,
					parent,
					entries,
					// 前端目前不用这两个字段（默认一页 500 条，够右栏用）；给脚本一个明确的
					// 「还有多少没给」的说法，而不是让人数 entries 猜。
					total,
					truncated: offset + entries.length < total,
				});
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
					...(identity?.team === undefined ? {} : { team: identity.team }),
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
					// 他在哪些频道里。`members` 是真相，界面不用自己比。频道是私聊还是群聊
					// 也由成员推（`chatKind`），不靠 id 前缀。
					channels: Object.values(state.channels ?? {})
						.filter((channel) => channel.members.includes(slug))
						.map((channel) => ({ id: channel.id, kind: chatKind(channel), title: channel.title })),
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
				const agentDir = join(shell.agentsRoot, slug);
				const source = (await readMemory(agentDir)) ?? "";
				const stamps = await memoryTimeline(agentDir);
				return json(response, {
					slug,
					label: withLabels(directory, []).labels?.[slug] ?? slug,
					exists: source !== "",
					digest: memoryDigest(source) ?? null,
					// `at`/`by`/`op` 来自 `.memory-journal.jsonl`。手写进 memory.md 的条目没有日志，
					// 就照实给 `null` —— 不拿「现在」去冒充「当时」（ADR-016）。
					entries: sectionsOf(source).map((section) => {
						const stamp = stamps.get(section.heading);
						return {
							heading: section.heading,
							body: section.body,
							at: stamp?.at ?? null,
							by: stamp?.by ?? null,
							op: stamp?.op ?? null,
						};
					}),
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
					const source = (await readMemory(agentDir)) ?? "";
					// 重建交给 `removeSection`：删除必须和 `sectionsOf` 用同一套分段口径，
					// 在这里手拼行切片实测会把后面的节写坏（删末节最容易被漏）。
					const next = removeSection(source, body.heading ?? "");
					if (next === undefined) return fail(response, 404, "没有这一条记忆（可能已经被删掉）");
					const result = await writeMemory(agentDir, next, MEMORY_ACTOR_WEB);
					return json(response, { ok: true, entries: sectionsOf(result.source).length });
				}
				if (body.op === "add") {
					const result = await appendMemory(agentDir, body.text ?? "", new Date(), MEMORY_ACTOR_WEB);
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
				const { directory, channels, teamLeadOf, teamDoingOf } = await snapshot();
				const list = channelList(channels, directory, OWNER_SLUG, teamLeadOf, teamDoingOf);
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
				// 「名字 / 职位 / @slug」三层，我要的职位信息就在这里。
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
				const { directory, channels, teamLeadOf, teamDoingOf } = await snapshot();
				const channel = channels.channels[params.id ?? ""];
				if (channel === undefined) return fail(response, 404, "频道不存在或无权查看");
				const limit = Number(url.searchParams.get("limit") ?? "");
				const before = Number(url.searchParams.get("before") ?? "");
				return json(
					response,
					channelDetail(channels, channel, directory, {
						teamLeadOf,
						teamDoingOf,
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
				if (typeof body.seq === "number" && Number.isFinite(body.seq)) {
					// 已读位置夹到频道真实上界：把 `{"seq":999999}` 直接写进去等于「以后所有消息
					// 都算已读」，未读数从此永远 0 —— 我再也看不到新消息的红点。
					const list = (await shell.channels()).messages[id] ?? [];
					const lastSeq = list[list.length - 1]?.seq ?? 0;
					const seq = Math.min(Math.max(Math.floor(body.seq), 0), lastSeq);
					await shell.harness.commit(async (tx) => {
						const doc = (await tx.doc(ChannelDoc)) as ChannelState;
						Object.assign(doc, markRead(doc, OWNER_SLUG, id, seq));
					}, BACKGROUND_CONTEXT);
				}
				return json(response, { ok: true });
			},
		},
		{
			// 浏览器自己报上来的卡顿（`ui/app/src/lib/jank.ts`）。
			//
			// 我两次报「agent 在跑的时候页面卡死」，而我在无头 Chrome 里量出来是
			// 「长任务 0、最慢帧 17ms」—— 两边对不上，靠猜猜不完。让浏览器在真卡的时候
			// 把「卡了多久、当时在干什么」写到 `workspace/logs/jank.jsonl`，复现一次就能读。
			pattern: "/api/diag",
			method: "POST",
			handler: async ({ request, response }) => {
				const body = await readJson<{ kind?: string; entries?: unknown }>(request, { requireJson: true });
				try {
					const logsDir = join(workspaceRoot, "logs");
					const file = join(logsDir, "jank.jsonl");
					await mkdir(logsDir, { recursive: true });
					// 诊断是「卡了多久、当时在干什么」，不是数据仓库：单条 4KB、单文件 5MB 封顶，
					// 满了就轮转一次。否则一个循环报错的页面能把工作区写爆。
					const entry = { ...body, entries: clipEntries(body.entries), at: new Date().toISOString() };
					await rotateIfTooBig(file, DIAG_FILE_LIMIT);
					await appendFile(file, `${JSON.stringify(entry)}\n`);
				} catch {
					/* 诊断写不进去不该影响任何事 */
				}
				return json(response, { ok: true });
			},
		},
		// 其余路径交给静态资源；找不到就 404（前端据此判断「是不是接口写错了」）。
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

	/**
	 * 允许的 Host 头。
	 *
	 * 由**实际监听地址**推出，不是由「用户可能用什么地址打开」猜：监听回环就只认
	 * 回环的三种写法；监听通配地址时把本机局域网地址也算上（否则手机上打开就 403）。
	 */
	function allowedHostsNow(): string[] {
		const hosts = new Set<string>([
			`127.0.0.1:${actualPort}`,
			`localhost:${actualPort}`,
			`[::1]:${actualPort}`,
			`::1:${actualPort}`,
		]);
		const bound = boundHost.trim();
		if (isWildcardHost(bound)) {
			for (const address of lanAddresses()) hosts.add(`${address}:${actualPort}`);
			if (options.host !== undefined && options.host.trim() !== "") hosts.add(`${options.host.trim()}:${actualPort}`);
		} else if (bound !== "") {
			hosts.add(`${bound}:${actualPort}`);
		}
		// 隧道/反代域名：监听地址推不出「外面用什么域名访问」，所以留一个显式口子
		// （逗号分隔，可带端口；不带端口时按当前端口补）。不加这个口子，以后挂个
		// cloudflared 之类就是全站 403 —— 而那时候没人会想到是这道闸。
		for (const raw of (process.env.SOLO_ALLOWED_HOSTS ?? "").split(",")) {
			const item = raw.trim().toLowerCase();
			if (item === "") continue;
			hosts.add(item.includes(":") ? item : `${item}:${actualPort}`);
			// 不带端口的条目还要认「裸主机名」：隧道/反代转过来的 Host 常常不带端口
			// （https 走 443，浏览器与代理都会省掉默认端口）。
			if (!item.includes(":")) hosts.add(item);
		}
		return [...hosts];
	}

	/**
	 * 自己这一份页面的 Origin：前端所有写请求都是同源发的。
	 *
	 * 每个 host 同时给出 http 与 https 两种：走隧道（cloudflared 之类）时页面是 https 的，
	 * Origin 就是 `https://<登记域名>` —— 只认 http 的话，从隧道打开的前端一个写请求都过不去。
	 * 默认端口会被浏览器省掉（https 的 443、http 的 80），所以这里把它们归一掉再比。
	 */
	function selfOriginsNow(): string[] {
		const origins = new Set<string>();
		for (const host of allowedHostsNow()) {
			const https = host.endsWith(":443") ? host.slice(0, -":443".length) : host;
			const http = host.endsWith(":80") ? host.slice(0, -":80".length) : host;
			origins.add(`http://${http}`);
			origins.add(`https://${https}`);
		}
		return [...origins];
	}

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://localhost");
		const method = request.method ?? "GET";
		// 来源闸必须在**匹配路由之前**：不合法来源不该有机会碰到任何 handler（读也一样，
		// 读能泄露整个工作区）。见 `http/origin.ts` 里对 DNS rebinding 的说明。
		if (!hostAllowed(request.headers.host, allowedHostsNow())) return fail(response, 403, "Host 不合法");
		if (
			method !== "GET" &&
			method !== "HEAD" &&
			!originAllowed(request.headers.origin, request.headers["sec-fetch-site"] as string | undefined, selfOriginsNow())
		) {
			return fail(response, 403, "来源不合法");
		}
		const match = matchRoute(routes, method, url.pathname);
		if (match === undefined) return fail(response, 404, "没有这个接口");
		try {
			await match.route.handler({
				request,
				response,
				url,
				path: url.pathname,
				method,
				params: match.params,
			});
		} catch (error) {
			// 正文超限 / 类型不对是**客户端的错**，不该变成 500 —— 500 会让人以为是服务挂了。
			if (error instanceof UploadTooLargeError) return fail(response, 413, error.message);
			if (error instanceof HttpError) return fail(response, error.status, error.message);
			throw error;
		}
	}

	/**
	 * 启动时清一次上传孤儿（审计 P2-3）。
	 *
	 * 引用真相是频道文档里的 `attachments`：一条消息引用过的 id 一个都不动，其余超过
	 * 10 分钟的（避免误删正在上传的那半套）删掉。失败只记一行，不影响启动 ——
	 * 清不掉只是占点磁盘。
	 */
	async function sweepUploads(): Promise<void> {
		try {
			const state = await shell.channels();
			const referenced = new Set<string>();
			for (const list of Object.values(state.messages ?? {})) {
				for (const message of list) {
					for (const attachment of message.attachments ?? []) referenced.add(attachment.id);
				}
			}
			const result = await sweepOrphanUploads(uploadsRoot, referenced, Date.now());
			if (result.removed > 0) {
				console.log(`[core] 清掉 ${result.removed} 个没人引用的上传文件（扫描 ${result.scanned} 个）`);
			}
		} catch {
			/* 清理失败不影响启动 */
		}
	}
	void sweepUploads();

	if (process.env.SOLO_DEBUG_FROM === "1") {
		console.warn("[core] 警告：from 可伪造（SOLO_DEBUG_FROM=1），只用于本机调试");
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

/**
 * 带 HTTP 状态码的错误。路由里 throw，由 `handle` 翻成对应响应。
 *
 * 存在的理由：`readJson` 这类底层函数拿不到 `response`，而「客户端发错了」和
 * 「服务端炸了」必须给不同的状态码 —— 都报 500 的话，前端与审计都无从判断。
 */
class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

async function readJson<T>(request: IncomingMessage, options: { readonly requireJson?: boolean } = {}): Promise<T> {
	// 边读边数：先读完再比上限等于没有上限（一个 4GB 的请求先把内存吃光）。
	// 超限抛 `UploadTooLargeError`，由 `handle` 翻成 413。
	const bytes = await readBounded(request, JSON_BODY_LIMIT);
	const text = bytes.toString("utf8").trim();
	// 有正文就必须声明 `application/json`：浏览器的表单能把合法 JSON 塞进 `text/plain`
	// 正文（`<input name='{"text":"x","y":"' value='"}'>`），这是 Origin 闸之外最后一条
	// CSRF 写法 —— 而浏览器**不会**让跨站表单发出 `application/json`（那要预检）。
	// 没有正文的 POST（脚本点一下已读）放行：它带不动任何数据。
	// `requireJson` 给「空正文也有副作用」的接口用（诊断落盘）：没有正文的跨站表单照样能写，
	// 所以那两个接口连空正文也必须声明 JSON。
	const declared = (request.headers["content-type"] ?? "").trim().toLowerCase().startsWith("application/json");
	if ((text !== "" || options.requireJson === true) && !declared) {
		throw new HttpError(415, "写接口只收 application/json");
	}
	if (text === "") return {} as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		return {} as T;
	}
}

/**
 * 记忆留痕里的「操作者」。
 *
 * P0-4 之后 HTTP 侧只剩我一个身份，所以这里**不造多用户模型**：只把来源标清楚 ——
 * 网页（我点「忘掉」/「添一条」）写 `owner:web`，agent 自己 `remember` 写 `agent`。
 * 以后真出错时，「这条是人在面板上删的」和「它自己改的」能一眼分开。
 */
const MEMORY_ACTOR_WEB = "owner:web";

/** 文件列表一页多少条（默认 / 上限）。 */
const FILE_LIST_DEFAULT = 500;
const FILE_LIST_MAX = 2000;

/** 目录列表里同时开多少个 `stat`。够快，又不会在大目录上把文件描述符打满。 */
const FILE_STAT_CONCURRENCY = 16;

/**
 * 限并发地跑一遍异步映射。
 *
 * 为什么不用 `Promise.all`：5000 个文件的目录会同时开 5000 个 `stat`，把 fd 和内存一起打满 ——
 * 那正是审计里「串行太慢」的反面错误。这里的并发上限是固定的，结果顺序与输入一致。
 */
export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	run: (item: T) => Promise<R>,
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			out[index] = await run(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	return out;
}

/** 团队文档缓存窗口（毫秒）。够合并连续提交，又不至于让界面看见旧数据。 */
const TEAM_CACHE_MS = 250;

/** 写接口的 JSON 正文上限。正常消息几千字，1MB 已经宽得离谱。 */
const JSON_BODY_LIMIT = 1 << 20;

/** 诊断日志单文件上限；超过就轮转成 `.1`（只留一代，诊断不需要历史）。 */
const DIAG_FILE_LIMIT = 5 * 1024 * 1024;

/** 诊断条目里 `entries` 的字符上限。 */
const DIAG_ENTRY_LIMIT = 4 * 1024;

/** 把诊断的 `entries` 压到 4KB 以内：超了就截断并标记，不要静默丢字段。 */
function clipEntries(entries: unknown): unknown {
	if (entries === undefined) return undefined;
	const text = typeof entries === "string" ? entries : JSON.stringify(entries);
	if (text === undefined) return undefined;
	if (text.length <= DIAG_ENTRY_LIMIT) return entries;
	return `${text.slice(0, DIAG_ENTRY_LIMIT)}…[截断]`;
}

/** 文件超过上限就改名成 `.1`（覆盖上一代）。 */
async function rotateIfTooBig(file: string, limit: number): Promise<void> {
	const info = await stat(file).catch(() => null);
	if (info === null || info.size <= limit) return;
	const { rename } = await import("node:fs/promises");
	await rename(file, `${file}.1`).catch(() => undefined);
}

/** 右栏「文件」不该看见/不该读的东西：隐藏文件、node_modules、库与配置、附件与日志。 */
const HIDDEN_FILES = new Set(["core.sqlite", "settings.json"]);

/**
 * 名字规则。列表与直接访问**共用这一份** —— 只在列表里过滤等于没过滤。
 *
 * `relativePath` 用 `/` 分隔、相对工作区根（与接口返回的 `path` 同一口径）。
 */
export function fileHidden(name: string, relativePath: string): boolean {
	if (name.startsWith(".")) return true;
	if (name === "node_modules") return true;
	if (HIDDEN_FILES.has(name)) return true;
	const path = relativePath.split(sep).join("/");
	if (path === "uploads" || path.startsWith("uploads/")) return true;
	if (path.startsWith("logs/") && name.endsWith(".jsonl")) return true;
	return false;
}

