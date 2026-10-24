/**
 * 模型访问的构建。
 *
 * 业务层与界面层不能直接导入 pi-ai（ADR-001），所以模型的创建与
 * 提供方选择都在这里完成。
 *
 * 默认使用本地 Command Code 网关（OpenAI Responses 协议），
 * 也可通过环境变量切到官方 Anthropic / OpenAI。
 */
import type { Models, Provider } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { ModelOption, ModelRef } from "../company/docs.ts";

/** 本地网关的默认配置。 */
export const LOCAL_GATEWAY = {
	id: "commandcode",
	baseUrl: "http://127.0.0.1:3425/v1",
	modelId: "auto/deepseek-v4.1-flash",
	apiKey: "magpie",
} as const;

/** 模型装配结果。 */
export type ModelSetup = {
	readonly models: Models;
	readonly defaultModel: ModelRef;
	/** 可选模型清单（带价格，供 CHRO 分配）。 */
	readonly catalog: readonly ModelOption[];
};

/**
 * 创建指向本地网关的 provider。
 *
 * 用 OpenAI Responses 协议实现，只把 baseUrl 与服务地址换掉。
 * 模型声明里的 `cost` 必须填真实单价，否则成本统计恒为零
 * （见 cost-accounting 规格与 ADR-003 的说明）。
 */
export function createLocalGatewayProvider(options?: {
	readonly baseUrl?: string;
	readonly apiKey?: string;
	readonly modelIds?: readonly string[];
	readonly pricing?: { readonly inputPerMTok: number; readonly outputPerMTok: number };
}): Provider {
	const baseUrl = options?.baseUrl ?? LOCAL_GATEWAY.baseUrl;
	const apiKey = options?.apiKey ?? LOCAL_GATEWAY.apiKey;
	const modelIds = options?.modelIds ?? [LOCAL_GATEWAY.modelId];
	const pricing = options?.pricing ?? { inputPerMTok: 0, outputPerMTok: 0 };

	// 必须用 createProvider 构造：它把 models 数组包装成 getModels() 等方法，
	// 直接写字面量对象会导致模型注册为空（拿不到模型，报 no_model）。
	return createProvider({
		id: LOCAL_GATEWAY.id,
		name: "Command Code（本地网关）",
		baseUrl,
		auth: {
			apiKey: {
				name: "Command Code 网关凭据",
				resolve: async () => ({ auth: { apiKey }, source: "COMMANDCODE_API_KEY" }),
			},
		},
		models: modelIds.map((id) => ({
			id,
			name: id,
			type: "chat" as const,
			api: "openai-responses" as const,
			provider: LOCAL_GATEWAY.id,
			baseUrl,
			// 网关声明该模型支持 reasoning（low/high/max 三档）
			reasoning: true,
			input: ["text", "image"] as const,
			cost: {
				input: pricing.inputPerMTok,
				output: pricing.outputPerMTok,
				cacheRead: 0,
				cacheWrite: 0,
			},
			// 网关 /v1/models 声明：context 1M、max_output 200k。
			// 之前填 16k 导致长任务被 stopReason:"length" 截断，
			// 工具参数来不及生成（表现为「工具调用参数为空」）。
			contextWindow: 1_000_000,
			maxTokens: 200_000,
		})),
		api: { stream, streamSimple },
	}) as unknown as Provider;
}

/**
 * 按环境选择提供方。
 *
 * 优先级：
 * 1. `AI_COMPANY_PROVIDER=anthropic|openai|local` 显式指定
 * 2. 存在 ANTHROPIC_API_KEY → Anthropic
 * 3. 存在 OPENAI_API_KEY → OpenAI
 * 4. 默认 → 本地 Command Code 网关
 */
export function setupModels(environment: NodeJS.ProcessEnv = process.env): ModelSetup {
	const explicit = environment.AI_COMPANY_PROVIDER;

	if (explicit === "anthropic" || (explicit === undefined && environment.ANTHROPIC_API_KEY !== undefined)) {
		const models = createModels();
		models.setProvider(anthropicProvider());
		return {
			models,
			defaultModel: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
			catalog: [
				{
					id: "claude-sonnet-4-6",
					provider: "anthropic",
					modelId: "claude-sonnet-4-6",
					label: "Claude Sonnet 4.6",
					inputPerMTok: 3,
					outputPerMTok: 15,
				},
			],
		};
	}

	if (explicit === "openai" || (explicit === undefined && environment.OPENAI_API_KEY !== undefined)) {
		const models = createModels();
		models.setProvider(openaiProvider());
		return {
			models,
			defaultModel: { provider: "openai", modelId: "gpt-5" },
			catalog: [
				{
					id: "gpt-5",
					provider: "openai",
					modelId: "gpt-5",
					label: "GPT-5",
					inputPerMTok: 1.25,
					outputPerMTok: 10,
				},
			],
		};
	}

	// 默认：本地网关
	const pricing = {
		inputPerMTok: Number(environment.COMMANDCODE_INPUT_PRICE ?? 0),
		outputPerMTok: Number(environment.COMMANDCODE_OUTPUT_PRICE ?? 0),
	};
	const models = createModels();
	models.setProvider(
		createLocalGatewayProvider({
			baseUrl: environment.COMMANDCODE_BASE_URL ?? LOCAL_GATEWAY.baseUrl,
			apiKey: environment.COMMANDCODE_API_KEY ?? LOCAL_GATEWAY.apiKey,
			pricing,
		}),
	);

	return {
		models,
		defaultModel: { provider: LOCAL_GATEWAY.id, modelId: LOCAL_GATEWAY.modelId },
		catalog: [
			{
				id: LOCAL_GATEWAY.modelId,
				provider: LOCAL_GATEWAY.id,
				modelId: LOCAL_GATEWAY.modelId,
				label: "DeepSeek v4.1 Flash（本地网关）",
				inputPerMTok: pricing.inputPerMTok,
				outputPerMTok: pricing.outputPerMTok,
			},
		],
	};
}

/** 探测本地网关是否可用。 */
export async function probeLocalGateway(options?: {
	readonly baseUrl?: string;
	readonly apiKey?: string;
	readonly timeoutMs?: number;
}): Promise<{ readonly ok: boolean; readonly detail: string }> {
	const baseUrl = options?.baseUrl ?? LOCAL_GATEWAY.baseUrl;
	const apiKey = options?.apiKey ?? LOCAL_GATEWAY.apiKey;
	const timeoutMs = options?.timeoutMs ?? 5_000;

	try {
		const response = await fetch(`${baseUrl}/responses`, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ model: LOCAL_GATEWAY.modelId, input: "ping" }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
		return { ok: true, detail: `${baseUrl} 可用` };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}
