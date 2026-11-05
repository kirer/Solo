/**
 * 模型装配：读 `<appRoot>/settings.json`，注册 provider，返回默认模型。
 *
 * 全部配置在文件里，代码只做一件事：JSON → createProvider → setProvider。
 * 没有「内置三档清单」「网关身份三件套」「自定义模型去重」——那些是外部问题，
 * 写在 settings.json 里，不写在这里。
 */
import { join } from "node:path";
import type { Models, Provider } from "@earendil-works/pi-ai";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { readSettingsFile, updateSettingsFile, type ProviderConfig, type Settings } from "./settings.ts";

export type ModelRef = { readonly provider: string; readonly modelId: string };

export type ModelSetup = {
	readonly models: Models;
	/**
	 * 会话默认模型。**没配任何模型时是 `undefined`** —— 这时候会话不带模型，
	 * 第一次生成就会失败，而不是悄悄换一只模型顶上（ADR-023）。
	 */
	readonly defaultModel?: ModelRef;
	/**
	 * 单独给某个人指定的模型（`settings.json` 的 `agentModels`，slug → `provider/modelId`）。
	 * 没写的人用 `defaultModel`。
	 */
	readonly agentModels?: Readonly<Record<string, ModelRef>>;
};

/** `"provider/modelId"` → 引用；模型 id 自己可以带斜杠，所以只切第一个。 */
export function parseModelRef(value: string): ModelRef | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

/**
 * 把「某个人用哪只模型」记进 `settings.json`（`value === null` = 删掉这条，跟默认）。
 *
 * 写文件是产品行为的一部分：不记的话重启时装配会把他改回默认，界面上看起来就是
 * 「设置自己变回去」。只动 `agentModels` 这一个字段，别的配置原样保留。
 *
 * 坏文件会抛 `SettingsFileError`：这份文件不能被「当成空的」重写，那会抹掉全部提供商。
 */
export function setAgentModel(settingsFile: string, slug: string, value: string | null): void {
	updateSettingsFile(settingsFile, (settings) => {
		const raw = settings["agentModels"];
		const agentModels: Record<string, string> = {};
		if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
			for (const [key, item] of Object.entries(raw)) if (typeof item === "string") agentModels[key] = item;
		}
		if (value === null || value.trim() === "") delete agentModels[slug];
		else agentModels[slug] = value.trim();
		if (Object.keys(agentModels).length === 0) delete settings["agentModels"];
		else settings["agentModels"] = agentModels;
	});
}

const APIS = {
	"openai-responses": { stream, streamSimple },
	anthropic: anthropicMessagesApi(),
	openai: { stream, streamSimple },
} as const;

/**
 * 上下文窗口查不到时的保守默认：128k。
 *
 * **为什么不能是 1M**：这里原来是 `?? 1_000_000`。压缩的触发点是
 * `contextWindow - reserveTokens`，写死 1M 就得到一个 98 万 token 的阈值——永不触发，
 * 于是「压缩开着」只是名义上的（见 `docs/CONCESSIONS.md`）。宁可保守：128k 是当下
 * 绝大多数指令模型的真实下限，估小了只是多压几次，估大了会直接撞上游的上下文上限报错。
 * 真实值优先从 pi-ai 的模型目录取（`builtinModels()`，按 provider/modelId），
 * 只有目录里没有的（比如自建网关 `magpie`）才落到这个数。
 */
export const FALLBACK_CONTEXT_WINDOW = 128 * 1024;

/** 输出上限的保守默认：32k。目录里查得到就用目录的。 */
export const FALLBACK_MAX_TOKENS = 32 * 1024;

/** 目录只建一次：`builtinModels()` 会把上千个模型全构造出来。 */
let catalog: MutableModels | undefined;

function catalogMeta(provider: string, modelId: string): { contextWindow: number; maxTokens: number } | undefined {
	catalog ??= builtinModels();
	const model = catalog.getModel(provider, modelId);
	return model === undefined ? undefined : { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
}

/** 本机地址：本地网关不看密钥，可以省（官方 API 不行）。 */
const LOCAL_BASE_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;

/**
 * 用一份 provider 配置构造底层 Provider。
 *
 * **空密钥要补一个占位符**：底座不接受空凭据，apiKey 是空串时每次生成立刻失败
 * （`stop: error`、0ms、请求根本没发出去），界面上只留下「他这一轮没答上来」。
 * 实测踩过一次：插件里加了一家本地网关、密钥留空，两个 agent 全部哑掉；填上
 * `magpie` 立刻恢复。本地网关给同样的占位符，远端仍然留空 —— 那里的空密钥是配置错了，
 * 该失败得早。
 */
function makeProvider(config: ProviderConfig): Provider {
	const apiName = config.api ?? "openai-responses";
	const api = APIS[apiName as keyof typeof APIS];
	if (api === undefined) {
		throw new Error(
			`settings.json 的提供商 ${config.id} 写了不认识的 api：${apiName}（可选：${Object.keys(APIS).join(" / ")}）`,
		);
	}
	// 没写地址 = 早先的本地网关默认值。模型管理插件保存时总会写出来，这一条只兜老配置。
	const baseUrl = config.baseUrl?.trim() || "http://127.0.0.1:3425/v1";
	// 缺省和空串都算「没给」：实测写 `"apiKey": ""` 与不写字段一样，每次生成立刻失败。
	const given = config.apiKey ?? "";
	const apiKey = given !== "" ? given : LOCAL_BASE_URL.test(baseUrl) ? "magpie" : "";
	return createProvider({
		id: config.id,
		name: config.name ?? config.id,
		baseUrl,
		auth: {
			apiKey: {
				name: `${config.id} 凭据`,
				resolve: async () => ({ auth: { apiKey }, source: "settings.json" }),
			},
		},
		models: config.models.map((m) => {
			// settings.json 显式写了就以它为准；没写就查 pi-ai 目录；再查不到才保守回落。
			const meta = catalogMeta(config.id, m.id);
			return {
				id: m.id,
				name: m.name ?? m.id,
				type: "chat" as const,
				api: apiName === "anthropic" ? "anthropic-messages" as const : "openai-responses" as const,
				provider: config.id,
				baseUrl,
				reasoning: m.reasoning ?? true,
				input: ["text", "image"] as const,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.contextWindow ?? meta?.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
				maxTokens: m.maxTokens ?? meta?.maxTokens ?? FALLBACK_MAX_TOKENS,
			};
		}),
		api,
	}) as unknown as Provider;
}

/**
 * 确认一个模型引用真的能解析到模型；解析不到 = 配置错误，直接报出来。
 *
 * **为什么不能悄悄换一只**：这个引用会被写进每一个会话（`conversation.configure`），
 * 指向不存在的 provider 或 modelId 时每次生成都会立刻以 `no_model` 失败，而失败发生在
 * 模型产字之前 —— 界面上只留下一条「开始处理…」。实测踩过两次（provider 改名、defaultModel
 * 手改错），两次表现完全一样：所有人都像在休息。换成另一只模型更糟：人以为自己在用 A，
 * 实际每轮都在用 B。所以这里只做校验，配错了就报错让人改。
 */
function requireModel(models: Models, ref: ModelRef, source: string): ModelRef {
	if (models.getModel(ref.provider, ref.modelId) !== undefined) return ref;
	const available = models.getModels().map((model) => `${model.provider}/${model.id}`).join("、");
	throw new Error(
		`${source} 指向不存在的模型 ${ref.provider}/${ref.modelId}（可选：${available || "还没有配置模型"}）`,
	);
}

type AppliedModels = {
	readonly defaultModel: ModelRef;
	readonly agentModels?: Readonly<Record<string, ModelRef>>;
};

/** 把一份 settings 装进给定的注册表（原地 `setProvider`），算出默认模型与个人模型。 */
function applySettings(models: MutableModels, settings: Settings): AppliedModels {
	let defaultRef: ModelRef | undefined;
	for (const config of settings.providers ?? []) {
		models.setProvider(makeProvider(config));
		if (defaultRef === undefined && config.models.length > 0) {
			defaultRef = { provider: config.id, modelId: config.models[0]!.id };
		}
	}
	if (settings.defaultModel !== undefined) {
		defaultRef = parseModelRef(settings.defaultModel) ?? defaultRef;
	}
	if (defaultRef === undefined) throw new Error("settings.json 有 providers 但没有模型");
	// 单独指定的模型：指向已删 provider / 已删模型的记录当作过期，按默认走（DEPLOY §3）。
	// 一条残留不能让整个应用起不来 —— 界面删 provider 时不一定清得掉这一项。
	const agentModels: Record<string, ModelRef> = {};
	for (const [slug, value] of Object.entries(settings.agentModels ?? {})) {
		const ref = parseModelRef(value);
		if (ref === undefined || models.getModel(ref.provider, ref.modelId) === undefined) {
			console.warn(`[core] settings.json 的 agentModels.${slug} 指向不存在的模型（${value}），按默认走`);
			continue;
		}
		agentModels[slug] = ref;
	}
	return {
		defaultModel: requireModel(models, defaultRef, "settings.json 的 defaultModel"),
		...(Object.keys(agentModels).length === 0 ? {} : { agentModels }),
	};
}

/**
 * 把 `settings.json` 重新装进**已经在跑的**注册表 —— 加 / 改 / 删提供商不用重启（ADR-025）。
 *
 * 为什么原地改就够：`MutableModels.setProvider` 是 upsert，harness 拿的是同一个对象，
 * 下一个请求就解析得到；在跑的会话只认自己 `configure` 过的那只模型，不受影响。
 *
 * 返回装完之后的默认模型与个人模型。三种情况返回 `undefined` 且**什么都不动**：
 * 文件里没有 providers（环境变量那一路不归它管）、文件读不出来、配置装不上
 * （比如 defaultModel 指向不存在的模型且一个可用模型都没有）—— 跑着的服务不能
 * 因为一份坏配置就把全部模型换掉。
 */
export type ModelSync =
	| { readonly ok: true; readonly applied: AppliedModels }
	| { readonly ok: false; readonly error: string };

export function syncModels(target: Models, file: string): ModelSync | undefined {
	let settings: Settings | undefined;
	try {
		settings = readSettingsFile(file);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (settings?.providers === undefined || settings.providers.length === 0) return undefined;
	// 先装进一份临时注册表：装不上就整份丢弃，旧的还在。
	const staging = createModels();
	let applied: AppliedModels;
	try {
		applied = applySettings(staging, settings);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const live = target as MutableModels;
	live.clearProviders();
	for (const provider of staging.getProviders()) live.setProvider(provider);
	return { ok: true, applied };
}

/**
 * 装配模型。
 *
 * 优先级：
 * 1. `<appRoot>/settings.json` 里有 `providers` → 用它
 * 2. 环境变量 `ANTHROPIC_API_KEY` → Anthropic
 * 3. 环境变量 `OPENAI_API_KEY` → OpenAI
 * 4. 都没有 → **没有模型**（空注册表、`defaultModel: undefined`）
 *
 * 第四条原来是「悄悄回落到本地网关」。改掉的理由：没配的人看不出来自己没配 ——
 * 界面一切正常，只是所有人都在用一只他没选过、也不知道存在的模型。现在宁可
 * 什么都不响（设置 → 模型里写着「还没有配置模型」），也不替人做这个决定。
 */
export function setupModels(
	environment: NodeJS.ProcessEnv = process.env,
	options: { readonly workspace?: string; readonly settingsFile?: string } = {},
): ModelSetup {
	const file = options.settingsFile ?? (options.workspace === undefined ? undefined : join(options.workspace, "settings.json"));
	const settings = file === undefined ? undefined : readSettingsFile(file);

	if (settings?.providers !== undefined && settings.providers.length > 0) {
		const models = createModels();
		return { models, ...applySettings(models, settings) };
	}

	if (environment.ANTHROPIC_API_KEY !== undefined) {
		const models = createModels();
		models.setProvider(anthropicProvider());
		return {
			models,
			defaultModel: requireModel(models, { provider: "anthropic", modelId: "claude-sonnet-4-6" }, "环境变量 ANTHROPIC_API_KEY"),
		};
	}
	if (environment.OPENAI_API_KEY !== undefined) {
		const models = createModels();
		models.setProvider(openaiProvider());
		return {
			models,
			defaultModel: requireModel(models, { provider: "openai", modelId: "gpt-5" }, "环境变量 OPENAI_API_KEY"),
		};
	}

	// 什么都没配：空注册表 + 没有默认模型。这里不回落任何网关（ADR-023）。
	return { models: createModels() };
}

/** 一条压缩策略（形状对齐底座的 `CompactionPolicy`，但不 import 它：这里只产出普通数据）。 */
export type CompactionPolicyLike = {
	readonly enabled: boolean;
	readonly reserveTokens: number;
	readonly keepRecentTokens: number;
	readonly backgroundTokens: number;
};

/** 交给 `openCore({settings: {compaction}})` 的完整形状（含按模型覆写）。 */
export type CompactionSettingsLike = CompactionPolicyLike & {
	readonly modelOverrides: Readonly<Record<string, CompactionPolicyLike>>;
};

/**
 * 压缩触发点留多少余量：15%。
 *
 * 底座的判据是 `contextWindow - reserveTokens`（`thresholdCompaction`），所以
 * reserve 取 15% 就等于「上下文涨到 85% 开始压」，留出的一次摘要生成不会被掐。
 * **为什么不能沿用底座的 16384**：那是给 200k 模型的 8%，放到 32k 的小模型上就是
 * 一半窗口，放到 1M 上又等于没留余量——必须跟着窗口走。
 */
const COMPACTION_RESERVE_RATIO = 0.15;

/** 最近多少 token 原文不压（判定「压到哪儿」用）。按窗口的 10%，但不少于 8192。 */
const COMPACTION_KEEP_RECENT_RATIO = 0.1;
const COMPACTION_KEEP_RECENT_FLOOR = 8_192;

/** 后台压缩提前量：距阻塞阈值还有 5% 窗口就开始在后台压，不堵这一轮说话。 */
const COMPACTION_BACKGROUND_RATIO = 0.05;

/** 一个上下文窗口对应的压缩策略。纯函数。 */
export function compactionPolicyFor(contextWindow: number): CompactionPolicyLike {
	const window = contextWindow > 0 ? contextWindow : FALLBACK_CONTEXT_WINDOW;
	const reserveTokens = Math.ceil(window * COMPACTION_RESERVE_RATIO);
	const threshold = window - reserveTokens;
	// 窗口极小时比例会算出比阈值还大的「保留量」，那样一次都压不动：两个数都封顶在阈值一半。
	const half = Math.floor(threshold / 2);
	return {
		enabled: true,
		reserveTokens,
		keepRecentTokens: Math.min(Math.max(COMPACTION_KEEP_RECENT_FLOOR, Math.floor(window * COMPACTION_KEEP_RECENT_RATIO)), half),
		backgroundTokens: Math.min(Math.ceil(window * COMPACTION_BACKGROUND_RATIO), half),
	};
}

/**
 * 显式压缩配置：全局兜底用保守窗口算，每个已装配的模型各一条 `provider/modelId` 覆写。
 *
 * 覆写的 key 是底座的查找格式 `"${provider}/${modelId}"`（`compactionPolicy`）。
 */
export function compactionSettings(models: Models): CompactionSettingsLike {
	const modelOverrides: Record<string, CompactionPolicyLike> = {};
	for (const model of models.getModels()) {
		modelOverrides[`${model.provider}/${model.id}`] = compactionPolicyFor(model.contextWindow);
	}
	return { ...compactionPolicyFor(FALLBACK_CONTEXT_WINDOW), modelOverrides };
}
