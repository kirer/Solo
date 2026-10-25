/**
 * 模型访问的构建。
 *
 * 业务层与界面层不能直接导入 pi-ai（ADR-001），所以模型的创建与
 * 提供方选择都在这里完成。
 *
 * 默认使用本地 Command Code 网关（OpenAI Responses 协议），
 * 也可通过环境变量切到官方 Anthropic / OpenAI。
 *
 * 自定义模型：`workspace/settings.json` 里的 `models.custom` 会在启动时
 * 合并进来（设置页写入这个文件）。增删模型需要重启进程才生效——底层
 * 模型集合是启动时装配好的，运行中不动态替换（接口会回 restartRequired）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Models, Provider } from "@earendil-works/pi-ai";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
// 从 domain 取类型，**不要从 `../company/docs.ts` 取**。
// `company/docs.ts` 静态 import `../runtime/index.ts`（为了 `defineDoc`），
// 而 `runtime/index.ts` 又导出本文件 → 真实循环依赖 `runtime → company → runtime`。
// `ModelOption` / `ModelRef` 本来就是纯类型，真相源在 `src/domain/org-types.ts`，
// `company/docs.ts` 只是 re-export 它们。
import type { ModelOption, ModelRef } from "../domain/org-types.ts";

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
	/** 可选模型清单（带价格，供 CHRO 分配）。含自定义模型。 */
	readonly catalog: readonly ModelOption[];
	/**
	 * 仅「内置」模型清单（不含 settings.json 里的自定义模型）。
	 *
	 * 设置页要用它和 settings.models.custom 拼出带 `source` 的完整清单；
	 * 直接用 catalog 会把自定义模型算两遍（builtin + custom）。
	 */
	readonly builtinCatalog?: readonly ModelOption[];
};

/** 自定义模型支持的三类协议 / 提供方。 */
export const CUSTOM_MODEL_PROVIDERS = ["openai-responses", "anthropic", "openai"] as const;
export type CustomModelProvider = (typeof CUSTOM_MODEL_PROVIDERS)[number];

/**
 * 用户可以添加的一条自定义模型（`workspace/settings.json` 里 `models.custom` 的项）。
 *
 * `apiKey` 允许存明文：这是一个本机单人产品，设置文件就在 workspace 下；
 * 文档与设置页都会提醒「只在本机使用、不要把这个文件提交或共享」。
 */
export type CustomModelSettings = {
	/** 模型标识（同一份配置里唯一）。 */
	readonly id: string;
	readonly name?: string;
	/** 协议 / 提供方，默认 openai-responses。 */
	readonly provider?: string;
	/** 服务地址（OpenAI 兼容网关 / Anthropic 代理 / 自建端点）。 */
	readonly baseUrl?: string;
	/** 凭据（明文，仅本机）。 */
	readonly apiKey?: string;
	/** 美元 / 百万输入 token。 */
	readonly inputPerMTok?: number;
	/** 美元 / 百万输出 token。 */
	readonly outputPerMTok?: number;
	readonly contextWindow?: number;
	readonly maxOutput?: number;
};

/** settings.json 里与模型有关的部分（其他段由 src/server/settings.ts 负责）。 */
export type ModelSettings = {
	/** 默认模型的引用：`provider/modelId` 或唯一的模型 id。 */
	readonly default?: string;
	readonly custom: readonly CustomModelSettings[];
};

/** 自定义模型协议默认地址。 */
const DEFAULT_BASE_URL: Record<CustomModelProvider, string> = {
	"openai-responses": "http://127.0.0.1:3425/v1",
	anthropic: "https://api.anthropic.com",
	openai: "https://api.openai.com/v1",
};

/** 自定义模型默认上下文与输出上限（用户没填时用）。 */
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_OUTPUT = 32_000;

/** 把未知输入规范成 {@link ModelSettings}；无效项直接丢掉（启动不应因为手改坏 JSON 就起不来）。 */
export function parseModelSettings(raw: unknown): ModelSettings {
	if (typeof raw !== "object" || raw === null) return { custom: [] };
	const root = raw as Record<string, unknown>;
	// 允许直接传 settings.json 的根，也允许只传 `models` 段
	const models =
		typeof root.models === "object" && root.models !== null ? (root.models as Record<string, unknown>) : root;

	const rawCustom = Array.isArray(models.custom) ? models.custom : [];
	const custom: CustomModelSettings[] = [];
	const seen = new Set<string>();
	for (const item of rawCustom) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		const id = text(record.id);
		if (id === "" || seen.has(id)) continue;
		const provider = text(record.provider);
		const name = text(record.name);
		const baseUrl = text(record.baseUrl);
		const apiKey = text(record.apiKey);
		const inputPerMTok = number(record.inputPerMTok);
		const outputPerMTok = number(record.outputPerMTok);
		const contextWindow = positive(record.contextWindow);
		const maxOutput = positive(record.maxOutput);
		const entry: CustomModelSettings = {
			id,
			...(name === "" ? {} : { name }),
			...(provider === "" ? {} : { provider }),
			...(baseUrl === "" ? {} : { baseUrl }),
			...(apiKey === "" ? {} : { apiKey }),
			...(inputPerMTok === undefined ? {} : { inputPerMTok }),
			...(outputPerMTok === undefined ? {} : { outputPerMTok }),
			...(contextWindow === undefined ? {} : { contextWindow }),
			...(maxOutput === undefined ? {} : { maxOutput }),
		};
		seen.add(id);
		custom.push(entry);
	}

	const fallback = text(models.default);
	return { ...(fallback === "" ? {} : { default: fallback }), custom };
}

/**
 * 从 `workspace/settings.json` 同步读取模型配置。
 *
 * 启动阶段只读一次；文件不存在或坏了都返回空清单（自定义模型是增强，不是必需）。
 */
export function readModelSettings(workspace: string): ModelSettings {
	try {
		const content = readFileSync(join(workspace, "settings.json"), "utf8");
		return parseModelSettings(JSON.parse(content));
	} catch {
		return { custom: [] };
	}
}

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
 *
 * 第二参数用于合并 `workspace/settings.json` 里的自定义模型：
 * - `workspace`：启动时直接读该目录下的 settings.json（main.ts 用这个）
 * - `settings`：调用方已经解析好的模型设置（测试 / 其他入口用）
 *
 * 自定义模型会作为独立的 provider 注册（id 形如 `openai-responses`、
 * `anthropic-custom`，避免覆盖环境变量选中的内置 provider）。
 */
export function setupModels(
	environment: NodeJS.ProcessEnv = process.env,
	options: { readonly workspace?: string; readonly settings?: ModelSettings } = {},
): ModelSetup {
	const base = setupBuiltinModels(environment);
	const settings = options.settings ?? (options.workspace === undefined ? { custom: [] } : readModelSettings(options.workspace));
	const custom = settings.custom ?? [];

	const catalog: ModelOption[] = [...base.catalog];
	let fallback = base.defaultModel;

	if (custom.length > 0) {
		const taken = new Set(base.models.getProviders().map((provider) => provider.id));
		const usedIds = new Set<string>();
		for (const item of custom) {
			const kind = normalizeProvider(item.provider);
			if (kind === undefined) continue;
			const providerId = uniqueProviderId(kind, taken, usedIds);
			usedIds.add(providerId);
			(base.models as MutableModels).setProvider(createCustomProvider(providerId, kind, item));
			catalog.push({
				id: item.id,
				provider: providerId,
				modelId: item.id,
				label: item.name ?? item.id,
				inputPerMTok: item.inputPerMTok ?? 0,
				outputPerMTok: item.outputPerMTok ?? 0,
			});
		}
		fallback = resolveDefaultModel(settings.default, catalog, base.defaultModel);
	}

	return { models: base.models, defaultModel: fallback, catalog, builtinCatalog: base.catalog };
}

/** 按环境变量装配内置模型（原有行为，抽出来供自定义模型合并）。 */
function setupBuiltinModels(environment: NodeJS.ProcessEnv): ModelSetup {
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

/** 把用户填的 provider 规范成三类之一；认不出返回 undefined（该模型被跳过）。 */
function normalizeProvider(value: string | undefined): CustomModelProvider | undefined {
	const name = (value ?? "openai-responses").trim().toLowerCase();
	if (name === "" || name === "openai-responses" || name === "responses" || name === "local") {
		return "openai-responses";
	}
	if (name === "anthropic" || name === "claude") return "anthropic";
	if (name === "openai" || name === "gpt") return "openai";
	return undefined;
}

/**
 * 给自定义 provider 取一个不冲突的 id。
 *
 * 优先直接用协议名（`openai-responses` / `anthropic` / `openai`），
 * 与环境变量选中的内置 provider 撞名时加 `-custom` 后缀；同类多组再加序号。
 */
function uniqueProviderId(kind: CustomModelProvider, taken: ReadonlySet<string>, used: ReadonlySet<string>): string {
	const isFree = (id: string): boolean => !taken.has(id) && !used.has(id);
	if (isFree(kind)) return kind;
	let index = 1;
	let candidate = `${kind}-custom`;
	while (!isFree(candidate)) {
		index += 1;
		candidate = `${kind}-custom-${index}`;
	}
	return candidate;
}

/**
 * 用一个自定义模型构造 provider。
 *
 * 一个 provider 里可以放多个模型（同协议、同凭据），这里为了简单：
 * 每条自定义模型一个 provider（模型数量通常很少，独立 provider 让
 * baseUrl / apiKey 互不干扰，也避免同类多网关时串配置）。
 */
function createCustomProvider(providerId: string, kind: CustomModelProvider, item: CustomModelSettings): Provider {
	const baseUrl = item.baseUrl?.trim() || DEFAULT_BASE_URL[kind];
	const apiKey = item.apiKey?.trim() || envApiKeyOf(kind);
	const cost = {
		input: item.inputPerMTok ?? 0,
		output: item.outputPerMTok ?? 0,
		cacheRead: 0,
		cacheWrite: 0,
	};
	const shared = {
		id: item.id,
		name: item.name ?? item.id,
		type: "chat" as const,
		provider: providerId,
		baseUrl,
		// 自定义模型不支持方言探测；保守开 reasoning，关闭时底层会自动降级。
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost,
		contextWindow: item.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: item.maxOutput ?? DEFAULT_MAX_OUTPUT,
	};
	const auth = {
		apiKey: {
			name: "自定义模型凭据",
			resolve: async () => ({ auth: { apiKey }, source: "settings.json" }),
		},
	};

	// 分两个分支写：api 字段的字面量决定 createProvider 的泛型，合并写会把类型放宽成 string
	if (kind === "anthropic") {
		return createProvider({
			id: providerId,
			name: `自定义（${kind}）`,
			baseUrl,
			auth,
			models: [{ ...shared, api: "anthropic-messages" as const }],
			api: anthropicMessagesApi(),
		}) as unknown as Provider;
	}
	return createProvider({
		id: providerId,
		name: `自定义（${kind}）`,
		baseUrl,
		auth,
		models: [{ ...shared, api: "openai-responses" as const }],
		api: { stream, streamSimple },
	}) as unknown as Provider;
}

/** 未填 apiKey 时按协议退回环境变量，方便「只换地址、密钥在环境里」的用法。 */
function envApiKeyOf(kind: CustomModelProvider): string {
	if (kind === "anthropic") return process.env.ANTHROPIC_API_KEY ?? "";
	if (kind === "openai") return process.env.OPENAI_API_KEY ?? "";
	return process.env.COMMANDCODE_API_KEY ?? "";
}

/**
 * 解析设置里的默认模型。
 *
 * 支持三种写法：
 * - catalog 里唯一的 id（`gpt-5`）
 * - `provider/modelId`
 * - 认不出来 → 回退到环境变量选出的默认模型（并把坏配置当成「没设置」）
 */
export function resolveDefaultModel(
	reference: string | undefined,
	catalog: readonly ModelOption[],
	fallback: ModelRef,
): ModelRef {
	const value = (reference ?? "").trim();
	if (value === "") return fallback;

	const byId = catalog.filter((item) => item.id === value);
	if (byId.length === 1) {
		const only = byId[0];
		return only === undefined ? fallback : { provider: only.provider, modelId: only.modelId };
	}

	const slash = value.indexOf("/");
	if (slash > 0) {
		const provider = value.slice(0, slash);
		const modelId = value.slice(slash + 1);
		if (modelId !== "" && catalog.some((item) => item.provider === provider && item.modelId === modelId)) {
			return { provider, modelId };
		}
	}
	return fallback;
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

// ── 小工具 ──────────────────────────────────────────────────────────────────

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function positive(value: unknown): number | undefined {
	const parsed = number(value);
	return parsed !== undefined && parsed > 0 ? Math.floor(parsed) : undefined;
}
