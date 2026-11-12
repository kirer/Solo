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
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import qrcode from "./qrcode.mjs";

const SLUG = "IM机器人";
const DATA_DIR = "im";
const BOTS_FILE = "bots.json";
/**
 * 我在助理私聊里说的话，什么时候送回 IM。
 *
 * 老板定的：**不再有 120 秒窗口**，也不再按 `from === "owner"` 把「我自己说的」全挡掉 ——
 * 桌面端跟助理聊的内容也要同步出去。唯一还要挡的是桥自己带进来的那一行回显
 * （`deliver()` 用 `api.post` 以我的身份落进私聊，`from` 也是 `owner`，见 ECHO_PREFIX）。
 */
const ECHO_PREFIX = "[IM · ";

const POLL_TIMEOUT = 25;
/**
 * 一片最多多少**字节**（UTF-8）。以前这里是 3800，含义是「字符」——
 * 中文一个字 3 字节，3800 字切出来一片 11400 字节，企业微信上限 2048，
 * 于是一个 700 字以上的中文回复整条都发不出去，`lastError` 只留一句 HTTP 400。
 * 现在按字节切：中文上限 ≈ 680 字，英文 ≈ 2000 字，两边都在限制内。
 */
const MAX_SEND_BYTES = 2000;
const WEBHOOK_TIMEOUT = 15_000;
const STATE_KEY = Symbol.for("solo.im.runtime");

/** 微信个人号：腾讯 iLink 那套扫码协议（和 dsh-im 同一条路），只做一对一文字。 */
const WEIXIN_QR_BASE = "https://ilinkai.weixin.qq.com/";
const WEIXIN_VERSION = "2.4.6";
const WEIXIN_APP_ID = "bot";
const WEIXIN_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);
const WEIXIN_POLL_TIMEOUT = 35_000;
const WEIXIN_LOGIN_TTL = 5 * 60_000;

const PLATFORMS = {
	weixin: { name: "微信", needs: "scan" },
	telegram: { name: "Telegram", needs: "token" },
	webhook: { name: "Webhook", needs: "webhookUrl" },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function textOf(error) {
	return error instanceof Error ? error.message : String(error);
}

// ── 选项消息 ───────────────────────────────────────────────────────────

function hasOptions(message) {
	return Array.isArray(message.options) && message.options.length > 0;
}

/**
 * 带选项的那条推到微信长什么样。
 *
 * 微信里画不出选项卡，选项不铺开就等于丢了 —— 老板只会看到问题、看不到能选什么。
 * 编号用 `1.` `2.` 而不是 `①②`：手机上手打回去最省事，也最好认。
 */
function outboundText(message, body) {
	// 不加油漆：老板明确要「跟微信里说的一样」，前缀只会让两边对不上。
	if (!hasOptions(message)) return body;
	const lines = message.options.map((option, index) => `${index + 1}. ${String(option).trim()}`);
	return `${body}\n\n${lines.join("\n")}`;
}

/** 记下「哪个聊天正等着选哪一条」：微信回来的编号要能对到那条消息上。 */
function pendingOf(message) {
	return {
		channelId: message.channelId ?? "",
		seq: typeof message.seq === "number" ? message.seq : 0,
		options: message.options.map((option) => String(option).trim()),
		at: Date.now(),
	};
}

/**
 * 微信回过来的正文如果是一个编号，把它翻成「选了第几项」。
 *
 * 只认纯编号（`2`、「2」、「2.」都算），别的一概当普通消息 —— 老板打「1 和 2 都行」
 * 那是他自己的想法，不是选项，不能被吞掉当成选 1。
 */
function choiceOf(text, pending) {
	if (pending === undefined) return undefined;
	const match = /^\s*[（(]?\s*(\d{1,2})\s*[.、)）]?\s*$/.exec(text);
	if (match === null) return undefined;
	const index = Number(match[1]) - 1;
	if (!Number.isInteger(index) || index < 0 || index >= pending.options.length) return undefined;
	return { index, option: pending.options[index] };
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

function platformOf(value) {
	return value === "webhook" || value === "weixin" ? value : "telegram";
}

function normalizeBot(row) {
	const platform = platformOf(row.platform);
	return {
		id: typeof row.id === "string" && row.id !== "" ? row.id : `b_${randomUUID().slice(0, 8)}`,
		name: typeof row.name === "string" && row.name.trim() !== "" ? row.name.trim() : platformName(platform),
		platform,
		enabled: row.enabled !== false,
		token: typeof row.token === "string" ? row.token : "",
		webhookUrl: typeof row.webhookUrl === "string" ? row.webhookUrl : "",
		/** 微信扫码换来的三样：服务地址、它的机器人 id、扫码的人。 */
		baseUrl: typeof row.baseUrl === "string" ? row.baseUrl : "",
		accountId: typeof row.accountId === "string" ? row.accountId : "",
		ownerUserId: typeof row.ownerUserId === "string" ? row.ownerUserId : "",
		/** getupdates 的游标：重启后从上次的位置接着收，不重放。 */
		buf: typeof row.buf === "string" ? row.buf : "",
		/**
		 * 最近说过话的那几个聊天，落盘。
		 *
		 * 为什么必须落盘：回话靠「最近说话的那个聊天」路由（`lastChat()`），而这个表过去只在
		 * **收到**消息时才填。应用重启一次它就空了，于是桌面端我说的话一条也发不出去 ——
		 * 不报错、不提示，要等下一条微信消息进来才恢复（实测 #439 之后连丢 6 条）。
		 */
		chats: Array.isArray(row.chats)
			? row.chats
					.filter((item) => item !== null && typeof item === "object" && typeof item.id === "string" && item.id !== "")
					.map((item) => ({
						id: item.id,
						label: typeof item.label === "string" ? item.label : item.id,
						at: typeof item.at === "number" ? item.at : 0,
						contextToken: typeof item.contextToken === "string" ? item.contextToken : "",
					}))
					.slice(0, 20)
			: [],
		mode: row.mode === "all" ? "all" : "mention",
		allow: Array.isArray(row.allow) ? row.allow.map((item) => String(item).trim()).filter(Boolean) : [],
		createdAt: typeof row.createdAt === "number" ? row.createdAt : Date.now(),
	};
}

function problemOf(input, existing) {
	const platform = platformOf(input.platform);
	const token = typeof input.token === "string" ? input.token.trim() : "";
	const webhookUrl = typeof input.webhookUrl === "string" ? input.webhookUrl.trim() : "";
	if (platform === "weixin") {
		const effective = token !== "" ? token : (existing?.token ?? "");
		if (effective === "") return "微信要先扫码登录";
	}
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
	const platform = platformOf(input.platform);
	const token = typeof input.token === "string" ? input.token.trim() : "";
	const webhookUrl = typeof input.webhookUrl === "string" ? input.webhookUrl.trim() : "";
	return normalizeBot({
		id: existing?.id ?? `b_${randomUUID().slice(0, 8)}`,
		name: typeof input.name === "string" ? input.name : existing?.name,
		platform,
		enabled: input.enabled === undefined ? (existing?.enabled ?? true) : input.enabled === true,
		token: token !== "" ? token : (existing?.token ?? ""),
		webhookUrl: webhookUrl !== "" ? webhookUrl : (existing?.webhookUrl ?? ""),
		// 微信这三样是扫码换来的，界面上不填：保存名字 / 白名单时原样留住。
		baseUrl: existing?.baseUrl ?? "",
		accountId: existing?.accountId ?? "",
		ownerUserId: existing?.ownerUserId ?? "",
		buf: existing?.buf ?? "",
		// 「最近说话的聊天」也是攒下来的运行状态：改个名字 / 白名单不能把它清掉，
		// 否则下一次重启就又要「等一条新消息」才恢复回话。
		chats: existing?.chats ?? [],
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
		alive: true,
		controller: new AbortController(),
		chats: new Map(),
		/** 每个聊天「正等着的那个选择」：chatId → 那条带 options 的消息。 */
		pending: new Map(),
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
		remember(chatId, label, contextToken) {
			this.chats.set(chatId, { label, at: Date.now(), contextToken: contextToken ?? "" });
			// 只留最近 20 个，免得配置页面越看越长。
			if (this.chats.size > 20) {
				const oldest = [...this.chats.entries()].sort((left, right) => left[1].at - right[1].at)[0];
				if (oldest !== undefined) this.chats.delete(oldest[0]);
			}
			// 落盘：重启之后 `lastChat()` 还得能答上来，否则桌面端的话全被静默丢掉。
			// 不 await —— 收消息的循环不该为一次配置写入停一下；失败也只影响「重启后要等一条新消息」。
			this.manager.rememberChats(this.bot.id, this.chats);
		},
		lastChat() {
			const rows = [...this.chats.entries()].sort((left, right) => right[1].at - left[1].at);
			return rows[0];
		},
		async send(chatId, text) {
			if (this.bot.platform === "telegram") return sendTelegram(this, chatId, text);
			if (this.bot.platform === "weixin") return sendWeixin(this, chatId, text);
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
		// 把上次落盘的聊天装回来：重启之后「最近说话的那个聊天」还得在，
		// 否则桌面端我说的话没有去处，一条也发不出去（不报错、不提示）。
		for (const chat of bot.chats ?? []) {
			runtime.chats.set(chat.id, { label: chat.label, at: chat.at, contextToken: chat.contextToken ?? "" });
		}
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
		} else if (bot.platform === "weixin") {
			if (bot.token === "") {
				runtime.fail("微信登录凭据没了：删掉这个机器人，重新扫码");
			} else {
				weixinLoop(runtime).catch((error) => {
					if (runtime.alive) runtime.fail(error);
				});
			}
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

	/**
	 * 微信的登录是一条扫码流程，不是填一张表：这里只留最近的几次尝试，
	 * 扫码成功就把凭据落成一条普通机器人（和 Telegram 一样存进 bots.json）。
	 */
	const logins = new Map();
	let loginSeq = 0;

	function publicLogin(record) {
		return {
			id: record.id,
			status: record.status,
			url: record.url,
			qr: record.qr,
			error: record.error,
			botId: record.botId,
			expiresAt: record.expiresAt,
		};
	}

	function stopLogin(record) {
		record.controller.abort();
	}

	async function activateWeixin(record, body) {
		const token = typeof body.bot_token === "string" ? body.bot_token.trim() : "";
		const accountId = typeof body.ilink_bot_id === "string" ? body.ilink_bot_id.trim() : "";
		const ownerUserId = typeof body.ilink_user_id === "string" ? body.ilink_user_id.trim() : "";
		if (token === "" || accountId === "") throw new Error("微信授权成功，但返回的凭据不完整");
		const baseUrl = weixinBaseOf(body.baseurl === undefined ? record.baseUrl : body.baseurl);
		const existing = bots.find((bot) => bot.platform === "weixin" && bot.accountId === accountId);
		const next = normalizeBot({
			...(existing ?? {}),
			id: existing?.id ?? `b_${randomUUID().slice(0, 8)}`,
			name: existing?.name ?? "我的微信",
			platform: "weixin",
			token,
			baseUrl,
			accountId,
			ownerUserId,
			buf: "",
			enabled: true,
		});
		const index = bots.findIndex((bot) => bot.id === next.id);
		if (index >= 0) bots[index] = next;
		else bots.push(next);
		await writeBots(api.workspace, bots);
		stopBot(next.id);
		launch(next);
		record.status = "confirmed";
		record.botId = next.id;
		record.error = "";
		return next;
	}

	async function pollWeixinLogin(record) {
		while (!record.controller.signal.aborted && Date.now() < record.expiresAt) {
			const body = await wxCall(
				{ token: "" },
				"GET",
				`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(record.qrcode)}`,
				undefined,
				record.controller.signal,
				WEIXIN_POLL_TIMEOUT,
			);
			const status = typeof body?.status === "string" ? body.status : "";
			if (status === "wait") {
				record.status = "wait";
			} else if (status === "scaned") {
				record.status = "scanned";
			} else if (status === "scaned_but_redirect") {
				record.baseUrl = weixinBaseOf(body.redirect_host ?? record.baseUrl);
				record.status = "scanned";
			} else if (status === "confirmed") {
				await activateWeixin(record, body);
				return;
			} else if (status === "expired") {
				record.status = "expired";
				record.error = "二维码过期了，重新生成一个";
				return;
			} else if (status === "verify_code_blocked") {
				record.status = "failed";
				record.error = "配对码错太多次，重新生成二维码";
				return;
			} else if (status === "binded_redirect") {
				record.status = "failed";
				record.error = "这个微信号已经绑过机器人了：先删掉旧的那条再扫";
				return;
			} else if (status === "need_verifycode") {
				record.status = "failed";
				record.error = "微信要配对码，这一版先不支持";
				return;
			}
		}
		if (record.status !== "confirmed") {
			record.status = "expired";
			record.error = "二维码过期了，重新生成一个";
		}
	}

	async function startWeixinLogin() {
		for (const record of logins.values()) stopLogin(record);
		logins.clear();
		const body = await wxCall(
			{ token: "" },
			"POST",
			"ilink/bot/get_bot_qrcode?bot_type=3",
			{ local_token_list: [] },
			undefined,
			10_000,
		);
		const code = providerCode(body);
		if (code !== "") throw new Error(`微信服务拒绝了二维码申请（${code}）`);
		const token = typeof body?.qrcode === "string" ? body.qrcode : "";
		const url = weixinQrUrl(body?.qrcode_img_content);
		if (token === "") throw new Error("微信服务没有返回二维码");
		if (url === "") throw new Error("微信服务返回的扫码地址不可信");
		const record = {
			id: `w_${String(++loginSeq)}_${randomUUID().slice(0, 6)}`,
			qrcode: token,
			url,
			qr: qrMatrix(url),
			status: "wait",
			error: "",
			botId: "",
			baseUrl: WEIXIN_QR_BASE,
			expiresAt: Date.now() + WEIXIN_LOGIN_TTL,
			controller: new AbortController(),
		};
		logins.set(record.id, record);
		pollWeixinLogin(record).catch((error) => {
			if (record.controller.signal.aborted) return;
			record.status = "failed";
			record.error = textOf(error);
		});
		return publicLogin(record);
	}

	function weixinLoginStatus(id) {
		const record = logins.get(id);
		if (record === undefined) throw new Error("这次扫码已经结束，重新生成二维码");
		return publicLogin(record);
	}

	/** getupdates 的游标：隔一段才落一次盘，重启后不重放已经收过的消息。 */
	async function saveBuf(id, buf) {
		const bot = bots.find((row) => row.id === id);
		if (bot === undefined || bot.buf === buf) return;
		bot.buf = buf;
		await writeBots(api.workspace, bots);
	}

	/**
	 * 「最近说过话的聊天」落盘：重启之后桌面端我说的话还能找到去处。
	 *
	 * 和 `buf` 分开写：`buf` 很少变（有游标才变），这里是每收一条就动一次，
	 * 合在一起会让收消息的循环被配置写入拖住。
	 */
	async function rememberChats(id, chats) {
		const bot = bots.find((row) => row.id === id);
		if (bot === undefined) return;
		const next = [...chats.entries()]
			.map(([chatId, chat]) => ({
				id: chatId,
				label: chat.label,
				at: chat.at,
				contextToken: chat.contextToken ?? "",
			}))
			.sort((left, right) => right.at - left.at)
			.slice(0, 20);
		if (JSON.stringify(bot.chats ?? []) === JSON.stringify(next)) return;
		bot.chats = next;
		await writeBots(api.workspace, bots).catch(() => {});
	}

	const manager = {
		/** 收消息那边要的：助理私聊与 `api.post`。 */
		get assistant() {
			return assistant;
		},
		rememberChats,
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
			for (const record of logins.values()) stopLogin(record);
			logins.clear();
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
						accountId: bot.accountId,
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
		/** 微信扫码：开一次新的，或者读某一次的进度。 */
		async weixinLoginStart() {
			return startWeixinLogin();
		},
		weixinLoginStatus(id) {
			return weixinLoginStatus(id);
		},
		async rememberBuf(id, buf) {
			await saveBuf(id, buf);
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
		/**
		 * 助理私聊里的一条消息 → 最近说话的那个 IM 聊天。
		 *
		 * 桌面端（我）说的话也要送出去；只有桥自己发的那行 IM 回显不送（否则等于自说自话）。
		 */
		async onMessage(message, channelId) {
			await ensureAssistant();
			if (assistant === null || channelId !== assistant.channelId) return;
			if (message.kind !== "chat") return;
			// 助理 / 成员说的话才推到微信。人亲手打的那条不推（他自己写的，推过去只剩刷屏）。
			// 判据是 `human` 标记，不是 `from`：后端所有「我说话」都写 `from: "owner"`
			// （防冒充），只看 from 会把助理的回复也一起挡掉 —— 那是反的。
			if (message.human === true) return;
			const body = message.text.trim();
			if (body === "") return;
			if (body.startsWith(ECHO_PREFIX)) return;
			const outgoing = outboundText(message, body);
			for (const runtime of runtimes.values()) {
				if (!runtime.alive) continue;
				const chat = runtime.lastChat();
				if (chat === undefined) continue;
				try {
					await runtime.send(chat[0], outgoing);
					// 记下「这条带选项的消息推到哪个聊天了」：微信回来的编号要能对到它。
					if (hasOptions(message)) runtime.pending.set(chat[0], pendingOf(message));
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
		? `${ECHO_PREFIX}${platformName(runtime.bot.platform)} · ${input.name}]`
		: `${ECHO_PREFIX}${platformName(runtime.bot.platform)} · ${input.chatTitle} · ${input.name}]`;
	runtime.remember(
		input.chatId,
		input.chatTitle === "" ? input.name : `${input.chatTitle} · ${input.name}`,
		input.contextToken,
	);
	runtime.lastInboundAt = Date.now();
	const channelId = runtime.manager.assistant.channelId;

	// 回的是一个编号、而且这个聊天正等着选 → 那就是「选了第几项」，不是一句闲聊。
	// 必须带 `replyTo` 指回那条消息：界面认选择只看这个，不带就只是又说了句话。
	const pending = runtime.pending.get(input.chatId);
	const choice = choiceOf(input.text, pending);
	if (choice !== undefined && pending !== undefined) {
		runtime.pending.delete(input.chatId);
		await runtime.manager.api.post({
			channelId,
			text: choice.option,
			replyTo: pending.seq,
		});
		return;
	}

	await runtime.manager.api.post({ channelId, text: `${source} ${input.text}` });
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

// ── 微信（腾讯 iLink） ─────────────────────────────────────────────────

const WEIXIN_BASE_INFO = { channel_version: WEIXIN_VERSION, bot_agent: "Solo/1.0" };

/** 腾讯的域名：收到什么地址都先过这一道，别把凭据送去别处、也别把别的地址画成二维码。 */
function weixinHost(value) {
	const host = value.hostname;
	return host === "weixin.qq.com" || host.endsWith(".weixin.qq.com")
		|| host === "wechat.com" || host.endsWith(".wechat.com");
}

function weixinBaseOf(value) {
	const raw = typeof value === "string" ? value.trim() : "";
	if (raw === "") return WEIXIN_QR_BASE;
	let url;
	try {
		url = new URL(raw.includes("://") ? raw : `https://${raw}`);
	} catch {
		return WEIXIN_QR_BASE;
	}
	if (url.protocol !== "https:" || !weixinHost(url)) return WEIXIN_QR_BASE;
	url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
	url.search = "";
	url.hash = "";
	return url.toString();
}

/** 二维码里装的就是这个地址：不是 https + 腾讯域名就不画。 */
function weixinQrUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		return "";
	}
	return url.protocol === "https:" && weixinHost(url) ? url.toString() : "";
}

/** `ret` / `errcode` 非 0 就是平台拒了。 */
function providerCode(body) {
	const code = body?.errcode ?? body?.ret ?? 0;
	const text = String(code);
	return text === "0" || text === "" ? "" : text;
}

async function wxCall(bot, method, endpoint, body, signal, timeoutMs) {
	const url = new URL(endpoint, weixinBaseOf(bot.baseUrl));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs ?? 15_000);
	const relay = () => controller.abort();
	if (signal?.aborted) controller.abort();
	signal?.addEventListener("abort", relay, { once: true });
	try {
		const response = await fetch(url, {
			method,
			headers: {
				"iLink-App-Id": WEIXIN_APP_ID,
				"iLink-App-ClientVersion": WEIXIN_CLIENT_VERSION,
				...(bot.token === ""
					? {}
					: {
							"content-type": "application/json",
							AuthorizationType: "ilink_bot_token",
							"X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64"),
							Authorization: `Bearer ${bot.token}`,
						}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`微信服务回了 HTTP ${String(response.status)}`);
		return await response.json();
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", relay);
	}
}

/** 二维码只传一个方阵（0/1），由界面自己画：不引入图片编码，也不外发地址。 */
function qrMatrix(text) {
	const code = qrcode(0, "M");
	code.addData(text, "Byte");
	code.make();
	const size = code.getModuleCount();
	let bits = "";
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) bits += code.isDark(y, x) ? "1" : "0";
	}
	return { size, bits };
}

function weixinTextOf(message) {
	for (const item of message?.item_list ?? []) {
		if (item?.type === 1 && typeof item.text_item?.text === "string") {
			const text = item.text_item.text.trim();
			if (text !== "") return text;
		}
		if (item?.type === 3 && typeof item.voice_item?.text === "string") {
			const text = item.voice_item.text.trim();
			if (text !== "") return text;
		}
	}
	return "";
}

async function weixinLoop(runtime) {
	const { bot, controller } = runtime;
	runtime.ok("已连上微信");
	let buf = typeof bot.buf === "string" ? bot.buf : "";
	while (runtime.alive) {
		let body;
		try {
			body = await wxCall(
				bot,
				"POST",
				"ilink/bot/getupdates",
				{ get_updates_buf: buf, base_info: WEIXIN_BASE_INFO },
				controller.signal,
				WEIXIN_POLL_TIMEOUT,
			);
		} catch (error) {
			if (!runtime.alive) return;
			runtime.fail(`微信消息同步断了：${textOf(error)}`);
			await sleep(3000);
			continue;
		}
		if (!runtime.alive) return;
		const code = providerCode(body);
		if (code === "-14") {
			runtime.fail("微信登录凭据失效了：删掉这个机器人，重新扫码");
			return;
		}
		if (code !== "") {
			runtime.fail(`微信消息同步被拒（${code}）`);
			await sleep(3000);
			continue;
		}
		if (runtime.status === "error") runtime.ok("已连上微信");
		for (const message of body?.msgs ?? []) {
			await onWeixinMessage(runtime, message).catch((error) => {
				runtime.lastError = `收消息失败：${textOf(error)}`;
			});
		}
		const next = typeof body?.get_updates_buf === "string" ? body.get_updates_buf : "";
		if (next !== "" && next !== buf) {
			buf = next;
			await runtime.manager.rememberBuf(bot.id, next).catch(() => {});
		}
	}
}

async function onWeixinMessage(runtime, message) {
	// message_type 2 = 机器人自己发出去的，别把它当成新消息再送回来。
	if (message?.message_type === 2) return;
	const from = typeof message?.from_user_id === "string" ? message.from_user_id.trim() : "";
	if (from === "") return;
	const text = weixinTextOf(message);
	if (text === "") return;
	if (!allowed(runtime.bot, from)) return;
	await deliver(runtime, {
		chatId: from,
		userId: from,
		name: from,
		chatTitle: "",
		text,
		contextToken: typeof message.context_token === "string" ? message.context_token : "",
	});
}

async function sendWeixin(runtime, chatId, text) {
	const contextToken = runtime.chats.get(chatId)?.contextToken ?? "";
	for (const chunk of splitText(text)) {
		const body = await wxCall(
			runtime.bot,
			"POST",
			"ilink/bot/sendmessage",
			{
				msg: {
					from_user_id: "",
					to_user_id: chatId,
					client_id: `solo-weixin-${randomUUID()}`,
					message_type: 2,
					message_state: 2,
					item_list: [{ type: 1, text_item: { text: chunk } }],
					...(contextToken === "" ? {} : { context_token: contextToken }),
				},
				base_info: WEIXIN_BASE_INFO,
			},
			runtime.controller.signal,
			20_000,
		);
		const code = providerCode(body);
		if (code !== "") throw new Error(`微信拒收（${code}）`);
	}
}

/** 平台一条消息都有上限：按 3800 字切，尽量在换行处断。 */
/**
 * 按**字节**切，不是按字符。
 *
 * 为什么不能按 `length`：`"中".length === 1`，UTF-8 里却是 3 字节。以前按 3800 个
 * 字符切，中文一片能到 11400 字节，超过平台上限，整条被拒 —— 而且是从 700 字左右
 * 就开始，老板问个稍长的问题就中。
 *
 * 切点优先落在换行上（别把一句话劈两半），但**绝不超过字节上限**；
 * 每片切完自己再核一遍字节数，超了就往前收 —— 这道复核是为了防「代理对
 * （emoji、生僻字）被切一半」那类算漏。
 */
function splitText(text) {
	const rows = [];
	let rest = text;
	while (byteLength(rest) > MAX_SEND_BYTES) {
		// 先按字节贪心找到能放下的最大前缀（按码点走，不会劈开代理对）。
		let used = 0;
		let at = 0;
		for (const char of rest) {
			const size = byteLength(char);
			if (used + size > MAX_SEND_BYTES) break;
			used += size;
			at += char.length;
		}
		if (at === 0) break; // 一个字符都放不下：理论上不会有，别死循环。
		// 这一段里如果能退到换行处就退，读起来整齐；但退过头（不到一半）就不退。
		const cut = rest.lastIndexOf("\n", at - 1);
		const piece = cut >= at / 2 ? rest.slice(0, cut) : rest.slice(0, at);
		rows.push(piece);
		rest = rest.slice(piece.length).replace(/^\n+/, "");
	}
	if (rest !== "") rows.push(rest);
	const trimmed = rows.filter((row) => row !== "");
	// 最后再核一遍：任何一片超字节上限都是我们的错，宁可多切一片也别让整条被拒。
	const checked = [];
	for (const row of trimmed) {
		if (byteLength(row) <= MAX_SEND_BYTES) {
			checked.push(row);
			continue;
		}
		for (const piece of hardSplit(row)) checked.push(piece);
	}
	return checked.length === 0 ? [""] : checked;
}

/** 一个字符串占几个 UTF-8 字节（不依赖 Buffer：插件跑在浏览器 / 无 Node 的环境里）。 */
function byteLength(text) {
	let bytes = 0;
	for (const char of text) {
		const point = char.codePointAt(0) ?? 0;
		if (point <= 0x7f) bytes += 1;
		else if (point <= 0x7ff) bytes += 2;
		else if (point <= 0xffff) bytes += 3;
		else bytes += 4;
	}
	return bytes;
}

/** 兜底硬切：只在上面那轮复核发现某片还是超了的时候用。 */
function hardSplit(text) {
	const rows = [];
	let rest = text;
	while (rest !== "") {
		let used = 0;
		let at = 0;
		for (const char of rest) {
			const size = byteLength(char);
			if (used + size > MAX_SEND_BYTES) break;
			used += size;
			at += char.length;
		}
		if (at === 0) break;
		rows.push(rest.slice(0, at));
		rest = rest.slice(at);
	}
	return rows;
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
		pattern: "/api/p/im/weixin/login",
		handle: async () => manager.weixinLoginStart(),
	});

	api.route({
		method: "GET",
		pattern: "/api/p/im/weixin/login/:id",
		handle: async ({ params }) => manager.weixinLoginStatus(params.id ?? ""),
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
