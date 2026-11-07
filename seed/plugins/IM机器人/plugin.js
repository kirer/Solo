/**
 * IM 机器人的后端：把外面的聊天接进**助理私聊**，把助理的回复送回原聊天。
 *
 * 参考 dsh-im 的形态（一个设置入口、多个机器人、每个机器人独立状态），但按 Solo 的
 * 插件契约收窄成一条链路：
 *
 *   IM ──收──▶ api.post(助理私聊) ──助理回复──▶ api.on("message") ──▶ 原 IM 聊天
 *
 * 三件不显然的取舍：
 * 1. **只接助理私聊**（用户确认过的范围）。Solo 没有「每个 IM 聊天一条会话」，所以
 *    回复靠「最近说话的那个聊天 + 两分钟窗口」路由，多个聊天同时说话时做不到严格对应。
 * 2. **配置不放插件目录**：`<appRoot>/im/bots.json`。出厂插件按整个目录 hash 升级
 *    （ADR-097），把配置写进目录会让它永远「被改过」。
 * 3. **旧实例先停**：插件重装（ADR-026）会重新 `apply`，而主动拉取是模块外的定时器。
 *    管理器挂在 `globalThis` 上，新的 `apply` 第一件事就是把上一份停掉，否则每装一次
 *    就多一条拉取循环、同一条消息回两遍。
 *
 * 只收文字：图片 / 文件 / 语音第一版不做，收到就忽略（并在状态里留一行原因）。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SLUG = "IM机器人";
const DATA_DIR = "im";
const BOTS_FILE = "bots.json";
/** 助理在私聊里回复后，多久之内算「在回这条 IM 消息」。 */
const REPLY_WINDOW = 120_000;
/** 回复送出去之后，再留一小段给同一轮的后续消息。 */
const REPLY_TAIL = 30_000;
const POLL_TIMEOUT = 25;
const MAX_SEND = 3800;
const WEBHOOK_TIMEOUT = 15_000;
const STATE_KEY = Symbol.for("solo.im.runtime");

const PLATFORMS = {
	telegram: { name: "Telegram", needs: "token" },
	webhook: { name: "Webhook", needs: "webhookUrl" },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function textOf(error) {
	return error instanceof Error ? error.message : String(error);
}

function platformName(platform) {
	return PLATFORMS[platform]?.name ?? platform;
}

// ── 配置 ───────────────────────────────────────────────────────────────

function botsPath(workspace) {
	return join(workspace, DATA_DIR, BOTS_FILE);
}

async function readBots(workspace) {
	try {
		const raw = JSON.parse(await readFile(botsPath(workspace), "utf8"));
		const rows = Array.isArray(raw?.bots) ? raw.bots : [];
		return rows.filter((row) => row !== null && typeof row === "object").map(normalizeBot);
	} catch {
		// 没有文件 = 还没配过；坏文件也当空表，界面上一眼能看出来「没了」。
		return [];
	}
}

async function writeBots(workspace, bots) {
	const dir = join(workspace, DATA_DIR);
	await mkdir(dir, { recursive: true });
	const path = botsPath(workspace);
	const tmp = `${path}.tmp`;
	// 凭据在里面：只给当前用户读写。
	await writeFile(tmp, `${JSON.stringify({ bots }, null, 2)}\n`, { mode: 0o600 });
	await rename(tmp, path);
}

function normalizeBot(row) {
	const platform = row.platform === "webhook" ? "webhook" : "telegram";
	return {
		id: typeof row.id === "string" && row.id !== "" ? row.id : `b_${randomUUID().slice(0, 8)}`,
		name: typeof row.name === "string" && row.name.trim() !== "" ? row.name.trim() : platformName(platform),
		platform,
		enabled: row.enabled !== false,
		token: typeof row.token === "string" ? row.token : "",
		webhookUrl: typeof row.webhookUrl === "string" ? row.webhookUrl : "",
		mode: row.mode === "all" ? "all" : "mention",
		allow: Array.isArray(row.allow) ? row.allow.map((item) => String(item).trim()).filter(Boolean) : [],
		createdAt: typeof row.createdAt === "number" ? row.createdAt : Date.now(),
	};
}

function problemOf(input, existing) {
	const platform = input.platform === "webhook" ? "webhook" : "telegram";
	const token = typeof input.token === "string" ? input.token.trim() : "";
	const webhookUrl = typeof input.webhookUrl === "string" ? input.webhookUrl.trim() : "";
	if (platform === "telegram") {
		// 留空 = 沿用已保存的那一份（和「模型管理」同一个规矩）。
		const effective = token !== "" ? token : (existing?.token ?? "");
		if (effective === "") return "Telegram 需要 Bot Token";
		if (!/^\d+:[A-Za-z0-9_-]{10,}$/.test(effective)) return "Bot Token 形状不对（应该是 123456:ABC…）";
	}
	if (platform === "webhook") {
		const effectiveToken = token !== "" ? token : (existing?.token ?? "");
		const effective = webhookUrl !== "" ? webhookUrl : (existing?.webhookUrl ?? "");
		if (effectiveToken === "") return "Webhook 需要一个接入口令";
		if (effective === "") return "Webhook 需要一个地址";
		if (!/^https?:\/\//i.test(effective)) return "Webhook 地址要以 http:// 或 https:// 开头";
	}
	return "";
}

function botFromInput(input, existing) {
	const platform = input.platform === "webhook" ? "webhook" : "telegram";
	const token = typeof input.token === "string" ? input.token.trim() : "";
	const webhookUrl = typeof input.webhookUrl === "string" ? input.webhookUrl.trim() : "";
	return normalizeBot({
		id: existing?.id ?? `b_${randomUUID().slice(0, 8)}`,
		name: typeof input.name === "string" ? input.name : existing?.name,
		platform,
		enabled: input.enabled === undefined ? (existing?.enabled ?? true) : input.enabled === true,
		token: token !== "" ? token : (existing?.token ?? ""),
		webhookUrl: webhookUrl !== "" ? webhookUrl : (existing?.webhookUrl ?? ""),
		mode: input.mode === "all" ? "all" : input.mode === "mention" ? "mention" : (existing?.mode ?? "mention"),
		allow: Array.isArray(input.allow) ? input.allow : (existing?.allow ?? []),
		createdAt: existing?.createdAt ?? Date.now(),
	});
}

// ── 运行时 ─────────────────────────────────────────────────────────────

function createRuntime(bot, manager) {
	return {
		bot,
		manager,
		status: bot.enabled ? "starting" : "stopped",
		detail: "",
		lastError: "",
		lastInboundAt: 0,
		replyUntil: 0,
		alive: true,
		controller: new AbortController(),
		chats: new Map(),
		me: null,
		stop() {
			this.alive = false;
			this.controller.abort();
		},
		ok(detail) {
			this.status = "running";
			this.detail = detail ?? "";
			this.lastError = "";
		},
		fail(error) {
			this.status = "error";
			this.lastError = textOf(error);
		},
		remember(chatId, label) {
			this.chats.set(chatId, { label, at: Date.now() });
			// 只留最近 20 个，免得配置页面越看越长。
			if (this.chats.size > 20) {
				const oldest = [...this.chats.entries()].sort((left, right) => left[1].at - right[1].at)[0];
				if (oldest !== undefined) this.chats.delete(oldest[0]);
			}
		},
		lastChat() {
			const rows = [...this.chats.entries()].sort((left, right) => right[1].at - left[1].at);
			return rows[0];
		},
		async send(chatId, text) {
			if (this.bot.platform === "telegram") return sendTelegram(this, chatId, text);
			return sendWebhook(this.bot, text);
		},
	};
}

function createManager(api) {
	const runtimes = new Map();
	let bots = [];
	let assistant = null;
	let closed = false;

	async function findAssistant() {
		let dirs = [];
		try {
			dirs = await readdir(join(api.workspace, "assistant"), { withFileTypes: true });
		} catch {
			return null;
		}
		const slugs = dirs
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		if (slugs.length === 0) return null;
		const channels = await api.channels();
		for (const slug of slugs) {
			const dm = channels.find((channel) => channel.kind === "dm" && channel.members.includes(slug));
			if (dm !== undefined) return { slug, name: dm.title, channelId: dm.id };
		}
		return null;
	}

	/**
	 * 助理私聊在**第一次启动**时可能还没建出来（装配顺序：插件先装、私聊后建）。
	 * 所以每次用到它之前补找一次；找到之后把当时因为「没有私聊」而停在 error 的机器人拉起来。
	 */
	async function ensureAssistant() {
		if (assistant !== null) return assistant;
		assistant = await findAssistant();
		if (assistant === null) return null;
		for (const bot of bots) {
			const runtime = runtimes.get(bot.id);
			if (runtime !== undefined && runtime.status === "error" && runtime.lastError === "Solo 里还没有助理私聊") {
				stopBot(bot.id);
				launch(bot);
			}
		}
		return assistant;
	}

	function launch(bot) {
		const runtime = createRuntime(bot, manager);
		runtimes.set(bot.id, runtime);
		if (!bot.enabled) {
			runtime.status = "stopped";
			return runtime;
		}
		if (assistant === null) {
			runtime.fail("Solo 里还没有助理私聊");
			return runtime;
		}
		if (bot.platform === "telegram") {
			telegramLoop(runtime).catch((error) => {
				if (runtime.alive) runtime.fail(error);
			});
		} else {
			// Webhook 渠道没有要一直跑的连接：收消息走路由，这里只是把它标成可用。
			runtime.ok(bot.webhookUrl === "" ? "还没填 Webhook 地址" : "等消息");
		}
		return runtime;
	}

	function stopBot(id) {
		const runtime = runtimes.get(id);
		if (runtime !== undefined) runtime.stop();
		runtimes.delete(id);
	}

	const manager = {
		/** 收消息那边要的：助理私聊与 `api.post`。 */
		get assistant() {
			return assistant;
		},
		get api() {
			return api;
		},
		async start() {
			bots = await readBots(api.workspace);
			assistant = await findAssistant();
			if (assistant === null) api.log(`[${SLUG}] 还没找到助理私聊：IM 消息会先拒收`);
			for (const bot of bots) launch(bot);
		},
		async reload() {
			assistant = await findAssistant();
			for (const id of [...runtimes.keys()]) stopBot(id);
			bots = await readBots(api.workspace);
			for (const bot of bots) launch(bot);
		},
		stop() {
			closed = true;
			for (const id of [...runtimes.keys()]) stopBot(id);
		},
		get closed() {
			return closed;
		},
		async snapshot() {
			await ensureAssistant();
			return {
				assistant,
				now: Date.now(),
				bots: bots.map((bot) => {
					const runtime = runtimes.get(bot.id);
					return {
						id: bot.id,
						name: bot.name,
						platform: bot.platform,
						enabled: bot.enabled,
						mode: bot.mode,
						allow: bot.allow,
						tokenHint: bot.token === "" ? "" : `…${bot.token.slice(-4)}`,
						webhookUrl: bot.webhookUrl,
						status: runtime?.status ?? (bot.enabled ? "starting" : "stopped"),
						detail: runtime?.detail ?? "",
						lastError: runtime?.lastError ?? "",
						lastInboundAt: runtime?.lastInboundAt ?? 0,
						chats: [...(runtime?.chats.entries() ?? [])]
							.map(([id, chat]) => ({ id, label: chat.label, at: chat.at }))
							.sort((left, right) => right.at - left.at)
							.slice(0, 5),
					};
				}),
			};
		},
		async upsert(input) {
			const id = typeof input.id === "string" && input.id !== "" ? input.id : "";
			const existing = bots.find((bot) => bot.id === id);
			const problem = problemOf(input, existing);
			if (problem !== "") throw new Error(problem);
			const next = botFromInput(input, existing);
			const index = bots.findIndex((bot) => bot.id === next.id);
			if (index >= 0) bots[index] = next;
			else bots.push(next);
			await writeBots(api.workspace, bots);
			await ensureAssistant();
			stopBot(next.id);
			launch(next);
			return next;
		},
		async remove(id) {
			bots = bots.filter((bot) => bot.id !== id);
			await writeBots(api.workspace, bots);
			stopBot(id);
		},
		async test(id) {
			await ensureAssistant();
			const runtime = runtimes.get(id);
			if (runtime === undefined) throw new Error("机器人没在跑：先保存并打开它");
			const chat = runtime.lastChat();
			if (chat === undefined) throw new Error("还没有人给它发过消息，没有可以测试的聊天");
			await runtime.send(chat[0], "Solo：这是一条测试消息，收到就说明这条路通了。");
			return { chat: chat[0], label: chat[1].label };
		},
		/** Webhook 渠道的入口（路由那边转进来）。 */
		async inbound(id, input) {
			const bot = bots.find((row) => row.id === id);
			if (bot === undefined) throw new Error("没有这个机器人");
			if (!bot.enabled) throw new Error("这个机器人是关着的");
			const runtime = runtimes.get(id);
			if (runtime === undefined) throw new Error("机器人还没装上，稍后再试");
			await ensureAssistant();
			await deliver(runtime, {
				chatId: String(input.chatId ?? input.userId ?? ""),
				userId: String(input.userId ?? ""),
				name: typeof input.name === "string" && input.name !== "" ? input.name : "朋友",
				chatTitle: typeof input.chatTitle === "string" ? input.chatTitle : "",
				text: typeof input.text === "string" ? input.text.trim() : "",
			});
		},
		/** 助理私聊里的一条消息 → 等回复的那些 IM 聊天。 */
		async onMessage(message, channelId) {
			await ensureAssistant();
			if (assistant === null || channelId !== assistant.channelId) return;
			if (message.kind !== "chat" || message.from === "owner") return;
			const body = message.text.trim();
			if (body === "") return;
			const now = Date.now();
			for (const runtime of runtimes.values()) {
				if (!runtime.alive || runtime.replyUntil === 0 || now > runtime.replyUntil) continue;
				const chat = runtime.lastChat();
				if (chat === undefined) continue;
				try {
					await runtime.send(chat[0], body);
					runtime.replyUntil = now + REPLY_TAIL;
				} catch (error) {
					runtime.lastError = `回复没送出去：${textOf(error)}`;
				}
			}
		},
	};

	return manager;
}

// ── 收发 ───────────────────────────────────────────────────────────────

function allowed(bot, userId) {
	if (bot.allow.length === 0) return true;
	return bot.allow.includes(userId);
}

/** 收到的这一条送进助理私聊。所有渠道共用。 */
async function deliver(runtime, input) {
	if (input.text === "") return;
	if (!allowed(runtime.bot, input.userId)) return;
	if (runtime.manager.assistant === null) throw new Error("Solo 里还没有助理私聊");
	const source = input.chatTitle === ""
		? `[IM · ${platformName(runtime.bot.platform)} · ${input.name}]`
		: `[IM · ${platformName(runtime.bot.platform)} · ${input.chatTitle} · ${input.name}]`;
	runtime.remember(input.chatId, input.chatTitle === "" ? input.name : `${input.chatTitle} · ${input.name}`);
	runtime.lastInboundAt = Date.now();
	runtime.replyUntil = Date.now() + REPLY_WINDOW;
	await runtime.manager.api.post({ channelId: runtime.manager.assistant.channelId, text: `${source} ${input.text}` });
}

async function tgCall(bot, method, params, signal) {
	const response = await fetch(`https://api.telegram.org/bot${bot.token}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(params ?? {}),
		...(signal === undefined ? {} : { signal }),
	});
	const body = await response.json().catch(() => ({ ok: false, description: `HTTP ${String(response.status)}` }));
	return body;
}

async function sendTelegram(runtime, chatId, text) {
	const chunks = splitText(text);
	for (const [index, chunk] of chunks.entries()) {
		const body = await tgCall(runtime.bot, "sendMessage", { chat_id: chatId, text: chunk, disable_web_page_preview: true });
		if (!body.ok) throw new Error(body.description ?? "Telegram 拒收");
		if (index < chunks.length - 1) await sleep(120);
	}
}

async function telegramLoop(runtime) {
	const { bot, controller } = runtime;
	const me = await tgCall(bot, "getMe", {}, controller.signal);
	if (!me.ok) throw new Error(me.description ?? "Token 没通过 Telegram 的检查");
	runtime.me = me.result;
	runtime.ok(`@${me.result.username}`);
	let offset = 0;
	while (runtime.alive) {
		let body;
		try {
			body = await tgCall(
				bot,
				"getUpdates",
				{ offset, timeout: POLL_TIMEOUT, allowed_updates: ["message"] },
				controller.signal,
			);
		} catch (error) {
			if (!runtime.alive) return;
			runtime.fail(`连不上 Telegram：${textOf(error)}`);
			await sleep(3000);
			continue;
		}
		if (!body.ok) {
			if (!runtime.alive) return;
			runtime.fail(body.description ?? "getUpdates 失败");
			await sleep(3000);
			continue;
		}
		if (runtime.status === "error") runtime.ok(`@${runtime.me.username}`);
		for (const update of body.result ?? []) {
			offset = Math.max(offset, Number(update.update_id) + 1);
			if (update.message !== undefined) {
				await onTelegramMessage(runtime, update.message).catch((error) => {
					runtime.lastError = `收消息失败：${textOf(error)}`;
				});
			}
		}
	}
}

async function onTelegramMessage(runtime, message) {
	const { bot, me } = runtime;
	const from = message.from;
	if (from === undefined || from.is_bot === true) return;
	const text = (message.text ?? message.caption ?? "").trim();
	if (text === "") return;
	const userId = String(from.id);
	const chatId = String(message.chat.id);
	const isGroup = message.chat.type !== "private";
	if (isGroup && bot.mode !== "all") {
		const username = `@${me.username}`.toLowerCase();
		const mentioned = (message.entities ?? []).some(
			(entity) => entity.type === "mention" && text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === username,
		);
		const repliedToBot = message.reply_to_message?.from?.id === me.id;
		if (!mentioned && !repliedToBot) return;
	}
	if (!allowed(bot, userId)) return;
	const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || userId;
	// 「正在输入」只是观感：发不出去不影响正文。
	tgCall(bot, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
	await deliver(runtime, {
		chatId,
		userId,
		name,
		chatTitle: isGroup ? (message.chat.title ?? "") : "",
		text,
	});
}

/** 飞书 / 钉钉 / 企业微信的自定义机器人：三家都用 `msgtype|msg_type + text`，一次带全。 */
async function sendWebhook(bot, text) {
	if (bot.webhookUrl === "") throw new Error("这个机器人还没填 Webhook 地址");
	for (const chunk of splitText(text)) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);
		try {
			const response = await fetch(bot.webhookUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					msgtype: "text",
					msg_type: "text",
					text: { content: chunk },
					content: { text: chunk },
				}),
				signal: controller.signal,
			});
			if (!response.ok) throw new Error(`Webhook 回了 HTTP ${String(response.status)}`);
		} finally {
			clearTimeout(timer);
		}
	}
}

/** 平台一条消息都有上限：按 3800 字切，尽量在换行处断。 */
function splitText(text) {
	const rows = [];
	let rest = text;
	while (rest.length > MAX_SEND) {
		const cut = rest.lastIndexOf("\n", MAX_SEND);
		const at = cut > MAX_SEND / 2 ? cut : MAX_SEND;
		rows.push(rest.slice(0, at));
		rest = rest.slice(at).replace(/^\n+/, "");
	}
	if (rest !== "") rows.push(rest);
	return rows.length === 0 ? [""] : rows;
}

// ── 插件入口 ───────────────────────────────────────────────────────────

export async function apply(api) {
	// 重装时上一份的主动拉取必须先停：它不在这个模块的生命周期里（ADR-026）。
	const registry = globalThis[STATE_KEY] ?? (globalThis[STATE_KEY] = { manager: null });
	registry.manager?.stop();

	const manager = createManager(api);
	registry.manager = manager;
	await manager.start().catch((error) => api.log(`[${SLUG}] 启动失败：${textOf(error)}`));

	api.on("message", (message, channelId) => manager.onMessage(message, channelId));

	api.route({
		method: "GET",
		pattern: "/api/p/im",
		handle: async () => manager.snapshot(),
	});

	api.route({
		method: "POST",
		pattern: "/api/p/im/bots",
		handle: async ({ body }) => {
			await manager.upsert(body ?? {});
			return manager.snapshot();
		},
	});

	api.route({
		method: "POST",
		pattern: "/api/p/im/bots/:id/delete",
		handle: async ({ params }) => {
			await manager.remove(params.id ?? "");
			return manager.snapshot();
		},
	});

	api.route({
		method: "POST",
		pattern: "/api/p/im/bots/:id/test",
		handle: async ({ params }) => ({ ...(await manager.test(params.id ?? "")), ...(await manager.snapshot()) }),
	});

	api.route({
		method: "POST",
		pattern: "/api/p/im/in/:id",
		handle: async ({ params, query, body }) => {
			const id = params.id ?? "";
			const bot = (await readBots(api.workspace)).find((row) => row.id === id);
			if (bot === undefined) throw new Error("没有这个机器人");
			if (bot.platform !== "webhook") throw new Error("这个机器人不是 Webhook 渠道");
			if (bot.token === "" || query.token !== bot.token) throw new Error("token 不对");
			await manager.inbound(id, body ?? {});
			return { ok: true };
		},
	});
}
