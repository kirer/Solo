/**
 * 第一次打开：接上模型（稿子 11）。
 *
 * 两件事：先探一次这家接口通不通（界面上那颗「已连通」的圆点），再把选中的提供商写进
 * `settings.json`。写完调 `refreshModels()` 就地重装，不用重启（ADR-025）。
 *
 * 为什么不做成插件：这一步发生在插件装上之前 —— 一台还没接过模型的机器，连助理都发不出话。
 * 密钥与模型管理插件一样存在 `settings.json` 里，界面只显示尾号。
 */
import { updateSettingsFile, type ProviderConfig } from "../core/runtime/settings.ts";
import { AppError } from "./errors.ts";
import type { CoreServices } from "./types.ts";

/** 引导里能选的那三个。`custom` 是任何 OpenAI 兼容的地址。 */
export type SetupChoice = "opus" | "sonnet" | "custom";

type Preset = {
	readonly provider: string;
	readonly name: string;
	readonly model: string;
	readonly label: string;
};

const PRESETS: Record<"opus" | "sonnet", Preset> = {
	opus: { provider: "anthropic", name: "Anthropic", model: "claude-opus-5-5", label: "Claude Opus 5.5" },
	sonnet: { provider: "anthropic", name: "Anthropic", model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
};

const ANTHROPIC_BASE = "https://api.anthropic.com";

/** 本机地址不看密钥；远端空密钥等于「配好了但用不了」，存下来只会更晚才炸。 */
const LOCAL_BASE_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
const LOCAL_PLACEHOLDER_KEY = "magpie";

export type SetupDraft = {
	readonly choice: SetupChoice;
	readonly apiKey: string;
	readonly baseUrl: string;
	readonly model: string;
	readonly api: "anthropic" | "openai-responses";
};

/**
 * 请求体 → 一份能落盘的草稿。任何一条不合格都当场说清哪一条。
 *
 * `needModel: false` 是「获取模型」那一次：还没选，正是要去问它有哪些。
 */
function draftOf(body: unknown, needModel = true): SetupDraft {
	const raw = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
	const choice = raw["choice"];
	if (choice !== "opus" && choice !== "sonnet" && choice !== "custom") {
		throw new AppError("bad-request", "先选一个模型");
	}
	const typed = typeof raw["apiKey"] === "string" ? raw["apiKey"].trim() : "";
	if (choice === "opus" || choice === "sonnet") {
		const preset = PRESETS[choice];
		if (typed === "") throw new AppError("bad-request", "还没有填 API 密钥");
		return { choice, apiKey: typed, baseUrl: ANTHROPIC_BASE, model: preset.model, api: "anthropic" };
	}
	const baseUrl = (typeof raw["baseUrl"] === "string" ? raw["baseUrl"] : "").trim().replace(/\/+$/, "");
	if (!/^https?:\/\//.test(baseUrl)) throw new AppError("bad-request", "地址要以 http:// 或 https:// 开头");
	const model = (typeof raw["model"] === "string" ? raw["model"] : "").trim();
	if (needModel && model === "") throw new AppError("bad-request", "要填一个模型名");
	const apiKey = typed !== "" ? typed : LOCAL_BASE_URL.test(baseUrl) ? LOCAL_PLACEHOLDER_KEY : "";
	if (apiKey === "") throw new AppError("bad-request", "远端接口要填一个 API 密钥");
	return { choice, apiKey, baseUrl, model, api: "openai-responses" };
}

/** 草稿 → `settings.json` 里的那一条 provider。 */
function providerOf(draft: SetupDraft): ProviderConfig {
	const preset = draft.choice === "custom" ? undefined : PRESETS[draft.choice];
	return {
		id: preset?.provider ?? "custom",
		name: preset?.name ?? "自定义接口",
		baseUrl: draft.baseUrl,
		api: draft.api,
		apiKey: draft.apiKey,
		models: [{ id: draft.model, ...(preset === undefined ? {} : { name: preset.label }) }],
	};
}

/** 从两家都可能回的两种形状里取模型 id：`{data:[…]}` 与 `{models:[…]}`。 */
function modelIdsOf(body: unknown): string[] {
	if (typeof body !== "object" || body === null) return [];
	const raw = body as { data?: unknown; models?: unknown };
	const list = Array.isArray(raw.data) ? raw.data : Array.isArray(raw.models) ? raw.models : [];
	const ids: string[] = [];
	for (const item of list) {
		const id =
			typeof item === "string"
				? item
				: typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string"
					? (item as { id: string }).id
					: "";
		if (id !== "" && !ids.includes(id)) ids.push(id);
	}
	// 一个网关挂几百只模型时，界面上只列前面这些就够了；填不进去的还能手打。
	return ids.slice(0, 200);
}

/** 探一次「列模型」接口：通不通 + 它有哪些模型。 */
async function probe(draft: SetupDraft): Promise<{ readonly ok: true; readonly ms: number; readonly models: string[] }> {
	const url = draft.api === "anthropic" ? `${draft.baseUrl}/v1/models` : `${draft.baseUrl}/models`;
	const headers =
		draft.api === "anthropic"
			? { "x-api-key": draft.apiKey, "anthropic-version": "2023-06-01" }
			: { authorization: `Bearer ${draft.apiKey}` };
	const started = Date.now();
	let response: Response;
	try {
		response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new AppError("bad-request", `连不上 ${url}：${reason}`);
	}
	if (!response.ok) throw new AppError("bad-request", `${url} 返回 ${String(response.status)}`);
	const ms = Date.now() - started;
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	return { ok: true, ms, models: modelIdsOf(body) };
}

export function createSetup(services: CoreServices) {
	return {
		/** 只探不写：界面上那颗圆点与「获取模型」都用它。 */
		async check(body: unknown): Promise<{ readonly ok: true; readonly ms: number; readonly models: string[] }> {
			return probe(draftOf(body, false));
		},

		/** 写进 `settings.json` 并就地重装；返回默认模型的引用。 */
		async save(body: unknown): Promise<{ readonly defaultModel: string }> {
			const draft = draftOf(body);
			const provider = providerOf(draft);
			const ref = `${provider.id}/${draft.model}`;
			updateSettingsFile(services.layout.settingsFile, (settings) => {
				const raw = settings["providers"];
				const kept = Array.isArray(raw)
					? raw.filter(
							(item) =>
								typeof item !== "object" ||
								item === null ||
								typeof (item as { id?: unknown }).id !== "string" ||
								(item as { id: string }).id !== provider.id,
						)
					: [];
				settings["providers"] = [...kept, provider];
				settings["defaultModel"] = ref;
			});
			await services.refreshModels?.();
			return { defaultModel: ref };
		},
	};
}
