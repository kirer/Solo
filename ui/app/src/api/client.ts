/**
 * 后端接口的薄封装。
 *
 * 只有一件事：把 HTTP 变成带类型的 Promise，错误消息取服务端给的中文 `error`。
 * 不做缓存、不做重试、不做状态 —— 那些属于 store 和调用方。
 *
 * 为什么把 `error` 抽出来：后端每个失败响应都是 `{ error: "只能看工作区里的文件" }`，
 * 直接弹 `HTTP 403` 对我毫无意义，而这些中文句子本来就是写给他看的。
 */

import type {
	AttentionItem,
	Channel,
	ChannelDetail,
	Org,
	PersonMemory,
	PersonProfile,
	Plugin,
	TeamProfile,
	Turn,
	Uploaded,
} from "./types.ts";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (response.ok) return (await response.json()) as T;

	// 错误体可能不是 JSON（代理、崩溃页），这时候必须还能说人话。
	let message = `接口 ${path} 返回 ${response.status}`;
	try {
		const body = (await response.json()) as { error?: unknown };
		if (typeof body.error === "string" && body.error.trim() !== "") message = body.error;
	} catch {
		// 保留上面那句兜底
	}
	throw new Error(message);
}

/** 组织快照（人 + 组织名）。 */
export const getOrg = (): Promise<Org> => call<Org>("/api/org");

/** 频道列表（按最后活跃倒序）。 */
export const getChannels = (): Promise<{ channels: Channel[] }> => call("/api/channels");

/** 一个频道的详情（首屏一页消息 + 成员 + 是否还有更早的）。 */
export const getChannel = (id: string, limit = 40): Promise<ChannelDetail> =>
	call<ChannelDetail>(`/api/channels/${encodeURIComponent(id)}?limit=${limit}`);

/** 更早的一页（`before` 是当前最早那条的 seq）。 */
export const getEarlier = (id: string, before: number, limit = 30): Promise<ChannelDetail> =>
	call<ChannelDetail>(`/api/channels/${encodeURIComponent(id)}?limit=${limit}&before=${before}`);

/**
 * 一个人在所有频道里的轮次（后台任务面板）。
 *
 * 面板要的是「他干了什么」，不是「这个频道里发生了什么」—— 他在团队频道干活也算。
 * `limit` 只取最近 N 轮（服务端夹在 1..100）。
 */
export const getPersonTurns = (slug: string, limit = 30): Promise<{ turns: Turn[] }> =>
	call(`/api/people/${encodeURIComponent(slug)}/turns?limit=${String(limit)}`);

/** 一轮的完整轨迹（带步骤）。找不到（没被叫醒 / 条目已被压缩）就是 `null`。 */
export const getTurn = (id: string, seq: number, slug: string): Promise<{ turn: Turn | null }> =>
	call(`/api/channels/${encodeURIComponent(id)}/turn?seq=${String(seq)}&slug=${encodeURIComponent(slug)}`);

/** 发一条消息（带 `replyTo` 就是引用某条）。 */
export const sendMessage = (
	id: string,
	body: { text: string; replyTo?: number; attachments?: string[] },
): Promise<{ delivered?: string[]; failed?: string[]; skipped?: string[] }> =>
	call(`/api/channels/${encodeURIComponent(id)}/messages`, {
		method: "POST",
		body: JSON.stringify(body),
	});

/** 标记已读到 `seq`。 */
export const markRead = (id: string, seq: number): Promise<unknown> =>
	call(`/api/channels/${encodeURIComponent(id)}/read`, {
		method: "POST",
		body: JSON.stringify({ seq }),
	});

/** 「找你的」清单（跨频道，未读在前）。 */
export const getAttention = (): Promise<{ items: AttentionItem[]; unread: number }> =>
	call("/api/attention");

/** 某个人的档案。 */
export const getPerson = (slug: string): Promise<PersonProfile> =>
	call<PersonProfile>(`/api/people/${encodeURIComponent(slug)}`);

/** 一个团队的档案：README 正文 + 管理员 + 团队记忆。 */
export const getTeam = (slug: string): Promise<TeamProfile> =>
	call<TeamProfile>(`/api/teams/${encodeURIComponent(slug)}`);

/** 和一个人开私聊（幂等）。侧栏第一格点下去就是这条。 */
export const openDirectMessage = (slug: string): Promise<{ ok: true; id: string }> =>
	call(`/api/people/${encodeURIComponent(slug)}/dm`, { method: "POST" });

/** 我拉一个群：成员由我指定，我自己一定在里面。 */
export const createGroup = (title: string, members: readonly string[]): Promise<{ ok: true; id: string }> =>
	call("/api/channels", { method: "POST", body: JSON.stringify({ title, members }) });

/** 清空所有数据并重启（设置 → 数据）。确认之后后端会自己退出，桌面壳负责重开。 */
export const resetAllData = (): Promise<{ ok: true; restarting: true }> =>
	call("/api/reset", { method: "POST", body: JSON.stringify({ confirm: true }) });

/** 重启应用（装完带前端的插件之后）。和重置同一条退出路径，但一个字节都不删。 */
export const restartApp = (): Promise<{ ok: true; restarting: true }> =>
	call("/api/restart", { method: "POST", body: JSON.stringify({ confirm: true }) });

/** 现在生效的模型（`provider/modelId`）。settings.json 里刚加的提供商要重启才进这里。 */
export const getModels = (): Promise<{ models: string[]; defaultModel: string }> => call("/api/models");

/** 换某个人的模型（`provider/modelId`；空串 = 跟默认）。当场生效，重启也认。 */
export const setPersonModel = (slug: string, model: string): Promise<{ model: string }> =>
	call(`/api/people/${encodeURIComponent(slug)}/model`, { method: "POST", body: JSON.stringify({ model }) });

/** 某个人的记忆。 */
export const getPersonMemory = (slug: string): Promise<PersonMemory> =>
	call<PersonMemory>(`/api/people/${encodeURIComponent(slug)}/memory`);

/** 改某个人的记忆（`forget` 按小节删、`add` 追加一条）。 */
export const editPersonMemory = (
	slug: string,
	body: { op: "forget" | "add"; heading?: string; text?: string },
): Promise<PersonMemory> =>
	call<PersonMemory>(`/api/people/${encodeURIComponent(slug)}/memory`, {
		method: "POST",
		body: JSON.stringify(body),
	});

/**
 * 这个频道里能被 @ 到的人。
 *
 * 只列**成员**，且不含我 —— 后端按频道成员算，前端不要自己从名册里筛
 * （名册里的人在不在这个频道是后端的事，筛两次迟早不一致）。
 */
export const getMentionable = (
	id: string,
): Promise<{ candidates: { id: number; label: string; slug: string; title: string }[] }> =>
	call(`/api/channels/${encodeURIComponent(id)}/mentionable`);

/**
 * 上传一个附件。
 *
 * 二进制直接放 body、文件名走 `x-filename` 头 —— 不用 multipart：服务端只收一个文件，
 * multipart 的边界解析纯属多余（见 `src/core/channel/uploads.ts` 的注释）。
 */
export async function uploadFile(file: File): Promise<Uploaded> {
	const response = await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}`, {
		method: "POST",
		headers: { "content-type": file.type || "application/octet-stream" },
		body: file,
	});
	if (response.ok) return (await response.json()) as Uploaded;
	let message = `上传 ${file.name} 失败（${response.status}）`;
	try {
		const body = (await response.json()) as { error?: unknown };
		if (typeof body.error === "string") message = body.error;
	} catch {
		// 保留兜底
	}
	throw new Error(message);
}

/** 附件下载/预览地址。 */
export const uploadUrl = (id: string): string => `/api/uploads/${encodeURIComponent(id)}`;

/** 浏览器自报卡顿（`<appRoot>/logs/jank.jsonl`）。有意在失败时静默：诊断不该打扰使用。 */
export function reportJank(body: unknown): void {
	void fetch("/api/diag", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		keepalive: true,
	}).catch(() => undefined);
}

/** 插件清单：名字、说明、开着没有、有没有前端入口、坏在哪。 */
export const getPlugins = (): Promise<{ plugins: Plugin[] }> => call("/api/plugins");

/**
 * 装一个插件：把选中的那个文件夹整份传上去，服务端原样写进 `<appRoot>/plugins/<slug>/`。
 * **下一次启动**才真的运行。
 */
export const installPlugin = (
	slug: string,
	files: readonly { path: string; base64: string }[],
): Promise<{ plugins: Plugin[] }> =>
	call("/api/plugins", { method: "POST", body: JSON.stringify({ slug, files }) });

/** 删掉一个插件，连同它的代码。不可恢复。 */
export const removePlugin = (slug: string): Promise<{ plugins: Plugin[] }> =>
	call(`/api/plugins/${encodeURIComponent(slug)}`, { method: "DELETE" });

/** 开关一个插件（写回它的 `plugin.md`）。**下一次启动**才真的装上 / 卸下。 */
export const setPluginEnabled = (slug: string, enabled: boolean): Promise<{ plugins: Plugin[] }> =>
	call(`/api/plugins/${encodeURIComponent(slug)}/enabled`, {
		method: "POST",
		body: JSON.stringify({ enabled }),
	});

/** 一条运行报告（`GET /api/diag` 的 `lastReport`）。 */
export type LastRuntimeReport = { readonly type: string; readonly at: string; readonly text: string };

/**
 * 底座最近一条「不正常」的运行报告（`<appRoot>/logs/runtime.jsonl` 的最新一条）。
 *
 * 拉不到、没有、格式不对都返回 `undefined`：诊断不该让页面报错。
 */
export async function fetchLastRuntimeReport(): Promise<LastRuntimeReport | undefined> {
	try {
		const response = await fetch("/api/diag");
		if (!response.ok) return undefined;
		const body = (await response.json()) as { lastReport?: { type?: unknown; at?: unknown; text?: unknown } | null };
		const report = body.lastReport;
		if (report === null || report === undefined || typeof report.text !== "string") return undefined;
		return { type: String(report.type ?? ""), at: String(report.at ?? ""), text: report.text };
	} catch {
		return undefined;
	}
}
