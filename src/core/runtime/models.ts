/**
 * 模型装配：读 `workspace/settings.json`，注册 provider，返回默认模型。
 *
 * 全部配置在文件里，代码只做一件事：JSON → createProvider → setProvider。
 * 没有「内置三档清单」「网关身份三件套」「自定义模型去重」——那些是外部问题，
 * 写在 settings.json 里，不写在这里。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Models, Provider } from "@earendil-works/pi-ai";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export type ModelRef = { readonly provider: string; readonly modelId: string };

export type ModelSetup = {
	readonly models: Models;
	readonly defaultModel: ModelRef;
};

type ProviderConfig = {
	readonly id: string;
	readonly name?: string;
	readonly baseUrl?: string;
	readonly apiKey?: string;
	/** `openai-responses` | `anthropic` | `openai`，默认 `openai-responses`。 */
	readonly api?: string;
	readonly models: readonly {
		readonly id: string;
		readonly name?: string;
		readonly reasoning?: boolean;
		readonly contextWindow?: number;
		readonly maxTokens?: number;
	}[];
};

type Settings = {
	readonly defaultModel?: string;
	readonly providers?: readonly ProviderConfig[];
};

/** 读 settings.json；坏了返回 undefined（调用方回落环境变量默认）。 */
function readSettings(workspace: string): Settings | undefined {
	try {
		return JSON.parse(readFileSync(join(workspace, "settings.json"), "utf8")) as Settings;
	} catch {
		return undefined;
	}
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

/** 用一份 provider 配置构造底层 Provider。 */
function makeProvider(config: ProviderConfig): Provider {
	const apiName = config.api ?? "openai-responses";
	const api = APIS[apiName as keyof typeof APIS] ?? APIS["openai-responses"];
	const apiKey = config.apiKey ?? "";
	return createProvider({
		id: config.id,
		name: config.name ?? config.id,
		baseUrl: config.baseUrl ?? "http://127.0.0.1:3425/v1",
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
				baseUrl: config.baseUrl ?? "http://127.0.0.1:3425/v1",
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
 * 确认一个模型引用真的能解析到模型，解析不到就换一个能用的。
 *
 * **为什么必须有这一步**：这个引用会被写进每一个会话（`conversation.configure`），
 * 一旦它指向不存在的 provider 或 modelId，每次生成都会立刻以 `no_model` 失败，
 * 而失败发生在模型产字之前 —— 界面上只留下一条「开始处理…」，看不出任何异常。
 * 实测踩过两次：一次是 `commandcode/auto/deepseek-v4.1-flash`（provider 改名成 magpie），
 * 一次是 `commandcode/auto/hy3`（settings.json 的 defaultModel 手改错了 provider）。
 * 两次表现完全一样：所有人都像在休息。
 */
function usableDefault(models: Models, ref: ModelRef, source: string): ModelRef {
	if (models.getModel(ref.provider, ref.modelId) !== undefined) return ref;
	const first = models.getModels()[0];
	if (first === undefined) {
		throw new Error(
			`${source} 指向 ${ref.provider}/${ref.modelId}，而这个模型不存在，并且没有任何可用模型可回落`,
		);
	}
	console.warn(
		`[core] ${source} 指向不存在的模型 ${ref.provider}/${ref.modelId}，改用 ${first.provider}/${first.id}`,
	);
	return { provider: first.provider, modelId: first.id };
}

/**
 * 装配模型。
 *
 * 优先级：
 * 1. `workspace/settings.json` 里有 `providers` → 用它
 * 2. 环境变量 `ANTHROPIC_API_KEY` → Anthropic
 * 3. 环境变量 `OPENAI_API_KEY` → OpenAI
 * 4. 默认 → 本地网关（OpenAI Responses 协议，`http://127.0.0.1:3425/v1`）
 */
export function setupModels(
	environment: NodeJS.ProcessEnv = process.env,
	options: { readonly workspace?: string } = {},
): ModelSetup {
	const settings = options.workspace === undefined ? undefined : readSettings(options.workspace);

	if (settings?.providers !== undefined && settings.providers.length > 0) {
		const models = createModels();
		let defaultRef: ModelRef | undefined;
		for (const config of settings.providers) {
			(models as MutableModels).setProvider(makeProvider(config));
			if (defaultRef === undefined && config.models.length > 0) {
				defaultRef = { provider: config.id, modelId: config.models[0]!.id };
			}
		}
		if (settings.defaultModel !== undefined) {
			const slash = settings.defaultModel.indexOf("/");
			if (slash > 0) {
				defaultRef = { provider: settings.defaultModel.slice(0, slash), modelId: settings.defaultModel.slice(slash + 1) };
			}
		}
		if (defaultRef === undefined) throw new Error("settings.json 有 providers 但没有模型");
		return { models, defaultModel: usableDefault(models, defaultRef, "settings.json 的 defaultModel") };
	}

	if (environment.ANTHROPIC_API_KEY !== undefined) {
		const models = createModels();
		models.setProvider(anthropicProvider());
		return {
			models,
			defaultModel: usableDefault(models, { provider: "anthropic", modelId: "claude-sonnet-4-6" }, "环境变量 ANTHROPIC_API_KEY"),
		};
	}
	if (environment.OPENAI_API_KEY !== undefined) {
		const models = createModels();
		models.setProvider(openaiProvider());
		return {
			models,
			defaultModel: usableDefault(models, { provider: "openai", modelId: "gpt-5" }, "环境变量 OPENAI_API_KEY"),
		};
	}

	const models = createModels();
	const provider = makeProvider({
		id: "magpie",
		name: "本地网关",
		baseUrl: environment.COMMANDCODE_BASE_URL ?? "http://127.0.0.1:3425/v1",
		apiKey: environment.COMMANDCODE_API_KEY ?? "magpie",
		api: "openai-responses",
		models: [{ id: environment.COMMANDCODE_MODEL_ID ?? "auto/deepseek-v4.1-flash", reasoning: true }],
	});
	(models as MutableModels).setProvider(provider);
	return {
		models,
		defaultModel: usableDefault(
			models,
			{ provider: "magpie", modelId: environment.COMMANDCODE_MODEL_ID ?? "auto/deepseek-v4.1-flash" },
			"本地网关兜底模型",
		),
	};
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
