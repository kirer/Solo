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
		models: config.models.map((m) => ({
			id: m.id,
			name: m.name ?? m.id,
			type: "chat" as const,
			api: apiName === "anthropic" ? "anthropic-messages" as const : "openai-responses" as const,
			provider: config.id,
			baseUrl: config.baseUrl ?? "http://127.0.0.1:3425/v1",
			reasoning: m.reasoning ?? true,
			input: ["text", "image"] as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.contextWindow ?? 1_000_000,
			maxTokens: m.maxTokens ?? 200_000,
		})),
		api,
	}) as unknown as Provider;
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
		return { models, defaultModel: defaultRef };
	}

	if (environment.ANTHROPIC_API_KEY !== undefined) {
		const models = createModels();
		models.setProvider(anthropicProvider());
		return { models, defaultModel: { provider: "anthropic", modelId: "claude-sonnet-4-6" } };
	}
	if (environment.OPENAI_API_KEY !== undefined) {
		const models = createModels();
		models.setProvider(openaiProvider());
		return { models, defaultModel: { provider: "openai", modelId: "gpt-5" } };
	}

	const models = createModels();
	const provider = makeProvider({
		id: "commandcode",
		name: "本地网关",
		baseUrl: environment.COMMANDCODE_BASE_URL ?? "http://127.0.0.1:3425/v1",
		apiKey: environment.COMMANDCODE_API_KEY ?? "magpie",
		api: "openai-responses",
		models: [{ id: environment.COMMANDCODE_MODEL_ID ?? "auto/deepseek-v4.1-flash", reasoning: true }],
	});
	(models as MutableModels).setProvider(provider);
	return {
		models,
		defaultModel: { provider: "commandcode", modelId: environment.COMMANDCODE_MODEL_ID ?? "auto/deepseek-v4.1-flash" },
	};
}
