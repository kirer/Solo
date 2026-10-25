/**
 * IM 接入的两个钩子（不实现各平台协议，只做桥接点）。
 *
 * 参考 dsh-im-connect 的设置形态：把「哪个平台、叫什么、开没开」交给
 * `settings.im.accounts` 描述，真正的协议对接由外部桥负责：
 *
 *   微信/企微/飞书 Bot ──入站──▶ POST /api/im/inbound?token=…
 *   老板通道的助手回复 ──出站──▶ POST settings.im.outboundWebhook
 *
 * 出站失败的唯一处理是「静默」：IM 是附加通道，不能因为它挂了而拖慢
 * 或阻塞老板通道的对话（契约要求「失败静默不阻塞」）。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { BACKGROUND_CONTEXT } from "../runtime/index.ts";
import type { CompanyRuntime } from "../runtime/index.ts";
import { readCompany } from "../company/org.ts";
import type { ImSettings, SettingsStore } from "./settings.ts";

/** 出站推送体。 */
export type ImOutboundPayload = {
	readonly text: string;
	readonly conversationId: number;
	readonly at: number;
};

/** 出站 HTTP 超时：IM 桥通常很快；慢就不等它。 */
const OUTBOUND_TIMEOUT_MS = 3_000;
/** 提交很密集（工具调用一轮几十条），合并一下再推送。 */
const OUTBOUND_DEBOUNCE_MS = 300;

/**
 * 入站是否放行。
 *
 * 规则（契约）：未启用 → 403；token 为空 → 一律 403（没配 token 等于没开）；
 * token 不匹配 → 403。用等长比较避免明显的时序侧信道（内网也无妨，顺手）。
 */
export function inboundAllowed(im: ImSettings, token: string): boolean {
	if (!im.enabled) return false;
	if (im.inboundToken === "") return false;
	return safeEqual(token, im.inboundToken);
}

/** 入站文本加上来源标记，让 CEO 知道这句话不是老板在网页里打的。 */
export function composeInboundText(text: string, from?: string): string {
	const source = (from ?? "").trim();
	return source === "" ? `[IM] ${text}` : `[IM · ${source}] ${text}`;
}

/**
 * 把一条助手回复推给出站 webhook。
 *
 * 刻意不返回 Promise：调用方 fire-and-forget，失败只吞掉，不进入任何
 * 请求 / 提交的关键路径。
 */
export function postOutbound(webhook: string, payload: ImOutboundPayload, timeoutMs = OUTBOUND_TIMEOUT_MS): void {
	if (!/^https?:\/\//i.test(webhook)) return;
	void fetch(webhook, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(timeoutMs),
	}).catch(() => undefined);
}

/** 出站中继：订阅提交后把老板通道的新助手回复推出去。 */
export type ImOutboundRelay = {
	/** 有提交发生（调用方从 subscribeCommits 里调）。 */
	notify(): void;
	/** 立刻尝试一次（测试用）。 */
	flush(): Promise<void>;
	/** 停掉定时器。 */
	stop(): void;
};

/** 创建出站中继。 */
export function createImOutboundRelay(options: {
	readonly runtime: () => CompanyRuntime;
	readonly settings: SettingsStore;
	readonly debounceMs?: number;
}): ImOutboundRelay {
	/** 只推「本进程启动之后」的回复：避免一开设置就把历史全灌到微信里。 */
	const startedAt = Date.now();
	const debounceMs = options.debounceMs ?? OUTBOUND_DEBOUNCE_MS;
	let timer: NodeJS.Timeout | undefined;
	let running = false;
	let stopped = false;
	/** 已处理过的最大 entry id，防止重复推送。 */
	let lastSentEntryId = 0;

	const flush = async (): Promise<void> => {
		if (stopped || running) return;
		running = true;
		try {
			const settings = await options.settings.read();
			if (!settings.im.enabled || settings.im.outboundWebhook === "") return;
			const runtime = options.runtime();
			const state = await readCompany(runtime, BACKGROUND_CONTEXT);
			const conversationId = Number(state?.roles?.ceo);
			if (!Number.isFinite(conversationId)) return;
			const conversation = await runtime.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
			if (conversation === undefined) return;

			const page = await conversation.entries({ order: "descending" }, 60, undefined, BACKGROUND_CONTEXT);
			const assistants = (page?.items ?? []).filter((entry) => entry.kind === "pi.assistant");
			const maxId = assistants.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), lastSentEntryId);
			const fresh = assistants
				.filter((entry) => Number(entry.id) > lastSentEntryId)
				.sort((left, right) => Number(left.id) - Number(right.id));
			// 先推进水位：即使文本为空也算处理过，免得每轮重复扫同一条
			lastSentEntryId = maxId;

			for (const entry of fresh) {
				const message = entry.model?.[0] as
					| {
							readonly content?: readonly { readonly type?: string; readonly text?: string }[];
							readonly timestamp?: number;
					  }
					| undefined;
				const text = (message?.content ?? [])
					.flatMap((part) =>
						part.type === "text" && part.text !== undefined && part.text !== "" ? [part.text] : [],
					)
					.join("")
					.trim();
				if (text === "") continue;
				const at = message?.timestamp ?? Date.now();
				// 进程启动前的历史回复不推
				if (at < startedAt) continue;
				postOutbound(settings.im.outboundWebhook, { text, conversationId, at });
			}
		} catch {
			// 出站是附加能力：读配置 / 读会话失败都不影响主流程
		} finally {
			running = false;
		}
	};

	return {
		notify(): void {
			if (stopped) return;
			if (timer !== undefined) return;
			timer = setTimeout(() => {
				timer = undefined;
				void flush();
			}, debounceMs);
		},
		flush,
		stop(): void {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		},
	};
}

/**
 * 常量时间字符串比较。
 *
 * 旧实现先比长度、长度不同立刻 return（泄露长度），再按 UTF-16 code unit
 * 逐位异或——JS 的 `charCodeAt` 只覆盖低 16 位，且字符串长度是字符数不是字节数，
 * 「常量时间」并不成立。用 `node:crypto` 的实现：两侧先 SHA-256 成定长摘要，
 * 再 `timingSafeEqual`，长度差异被哈希抹平，不泄露任何前缀信息。
 */
function safeEqual(left: string, right: string): boolean {
	const a = createHash("sha256").update(left, "utf8").digest();
	const b = createHash("sha256").update(right, "utf8").digest();
	return timingSafeEqual(a, b);
}
