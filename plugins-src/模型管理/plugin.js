/**
 * 模型管理的后端：三个 JSON 接口，读写 `<appRoot>/settings.json`。
 *
 * 只做三件事：读出来（密钥打码）、校验后写回去（先写临时文件再换名）、替浏览器去探一次
 * `<baseUrl>/models`。**不改运行中的模型** —— 模型是进程启动时装配的，这里只写文件。
 *
 * 写成 `.js` 不走类型擦除：单测要把这份文件原样装进临时工作区跑一遍（`loadPlugins` 的原生
 * `import` 在测试进程里读不了临时目录的 `.ts`，见 `test/core/plugin.test.ts` 头注释）。
 * 字段含义的唯一一份在 `docs/DEPLOY.md` §3；这里不重新解释，只做校验。
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const APIS = ["openai-responses", "anthropic", "openai"];
const DEFAULT_BASE_URL = "http://127.0.0.1:3425/v1";
/** 本机地址：本地网关不看密钥。远端没有密钥等于「配好了但用不了」，存下来只会静默失败。 */
const LOCAL_BASE_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
/** 本地网关的占位密钥：与 `setupModels` 的 `makeProvider` 一致，底座不接受空凭据。 */
const LOCAL_PLACEHOLDER_KEY = "magpie";

function settingsPath(workspace) {
	return join(workspace, "settings.json");
}

/** 临时文件名序号：和核心的写入口并发时互不覆盖。 */
let writeSeq = 0;

/**
 * 读整个 settings.json：别的键（不认识的那些）要原样写回去。
 *
 * 文件不存在 = 空配置（首次启动）；文件存在但坏了 = 抛错，**不能当成空文件**。
 * 当成空文件再写回去，会把全部提供商和默认模型一起抹掉。
 */
async function readSettings(workspace) {
	let raw;
	try {
		raw = await readFile(settingsPath(workspace), "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return {};
		throw error;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${settingsPath(workspace)} 不是合法 JSON：${error.message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${settingsPath(workspace)} 顶层必须是一个对象`);
	}
	return parsed;
}

/**
	 * 现在生效的是哪一路：与 `setupModels` 的优先级一致（settings.json → 环境变量 → 没有）。
	 * 只用来在界面上说人话 —— 没有配置时就说没有，别让人以为还有一只兜底模型在跑。
	 */
function sourceOf(providers) {
	if (providers.length > 0) return "<appRoot>/settings.json";
	if (process.env.ANTHROPIC_API_KEY !== undefined) return "环境变量 ANTHROPIC_API_KEY";
	if (process.env.OPENAI_API_KEY !== undefined) return "环境变量 OPENAI_API_KEY";
	return "还没有配置模型";
}

/**
 * 还没有 settings.json 时，给一份「照现在生效的那一路抄下来」的草稿。
 *
 * **不带密钥**：环境变量里的密钥不往浏览器送；界面会写清「保存后要重新填一次密钥」。
 */
function suggested() {
	if (process.env.ANTHROPIC_API_KEY !== undefined) {
		return { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", api: "anthropic", models: ["claude-sonnet-4-6"] };
	}
	if (process.env.OPENAI_API_KEY !== undefined) {
		return { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "openai", models: ["gpt-5"] };
	}
	return {
		id: "magpie",
		name: "本地网关",
		baseUrl: process.env.COMMANDCODE_BASE_URL ?? DEFAULT_BASE_URL,
		api: "openai-responses",
		models: [process.env.COMMANDCODE_MODEL_ID ?? "auto/deepseek-v4.1-flash"],
	};
}

/** 密钥只露尾巴：界面上要能分清「有 / 没有」和「是不是同一把」，但不需要看全。 */
function keyHint(key) {
	if (key === undefined || key === "") return undefined;
	return key.length <= 6 ? "••••" : `${key.slice(0, 2)}…${key.slice(-4)}`;
}

function providersOf(settings) {
	const raw = settings.providers;
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((item) => typeof item === "object" && item !== null)
		.map((item) => ({
			...item,
			id: String(item.id ?? ""),
			models: Array.isArray(item.models) ? item.models : [],
		}));
}

/** 对外的形状：密钥换成 `keyHint`，永远不发原文。 */
function view(workspace, settings) {
	const providers = providersOf(settings);
	return {
		source: sourceOf(providers),
		// 清单是空的：界面拿这个按钮起手，而不是让人对着空表单填。
		...(providers.length === 0 ? { suggested: suggested() } : {}),
		defaultModel: typeof settings.defaultModel === "string" ? settings.defaultModel : "",
		providers: providers.map((provider) => ({
			id: provider.id,
			name: provider.name ?? provider.id,
			baseUrl: provider.baseUrl ?? DEFAULT_BASE_URL,
			api: provider.api ?? "openai-responses",
			hasKey: (provider.apiKey ?? "") !== "",
			keyHint: keyHint(provider.apiKey),
			models: provider.models.map((model) => model.id),
		})),
		settingsFile: settingsPath(workspace),
	};
}

/** 校验一份提交上来的 providers。任何一条不合格就整份拒绝 —— 写坏这个文件等于全员不回话。 */
function clean(drafts, existing) {
	if (!Array.isArray(drafts)) return { error: "providers 要是数组" };
	const seen = new Set();
	const providers = [];
	for (const raw of drafts) {
		const id = typeof raw?.id === "string" ? raw.id.trim() : "";
		if (id === "") return { error: "每个提供商都要有 id" };
		if (id.includes("/") || /\s/.test(id)) return { error: `id 不能有斜杠或空格：${id}` };
		if (seen.has(id)) return { error: `提供商 id 重复：${id}` };
		seen.add(id);

		const models = Array.isArray(raw.models)
			? raw.models
					.map((model) => (typeof model === "string" ? model.trim() : ""))
					.filter((model) => model !== "")
					.map((model) => ({ id: model }))
			: [];
		if (models.length === 0) return { error: `「${id}」至少要有一个模型` };

		const baseUrl = typeof raw.baseUrl === "string" && raw.baseUrl.trim() !== "" ? raw.baseUrl.trim() : undefined;
		if (baseUrl !== undefined && !/^https?:\/\//.test(baseUrl)) return { error: `地址要以 http:// 或 https:// 开头：${baseUrl}` };
		const api = typeof raw.api === "string" && APIS.includes(raw.api) ? raw.api : undefined;

		// 密钥留空 = 沿用这一家已经保存的那一份（改地址 / 改名不该把密钥弄丢）。
		const typed = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
		const kept = existing.find((provider) => provider.id === id)?.apiKey ?? "";
		const url = baseUrl ?? DEFAULT_BASE_URL;
		// 本地网关给一个占位符（它不看密钥，但底座不接受空凭据：空着等于每次生成立刻失败，
		// 界面上只看到「他这一轮没答上来」）。远端留空直接拒绝 —— 存下来只会更晚才炸。
		const apiKey = typed !== "" ? typed : kept !== "" ? kept : LOCAL_BASE_URL.test(url) ? LOCAL_PLACEHOLDER_KEY : "";
		if (apiKey === "") return { error: `「${id}」还没有 API 密钥` };

		providers.push({
			id,
			...(typeof raw.name === "string" && raw.name.trim() !== "" ? { name: raw.name.trim() } : {}),
			// 总是写出来：核心按这一项构造 provider，省掉它等于存了一份装不上的配置。
			baseUrl: url,
			...(api === undefined ? {} : { api }),
			apiKey,
			models,
		});
	}

	if (providers.length === 0) return { error: "至少留一个提供商" };
	return { providers };
}

/** 默认模型要能解析到：`<provider>/<modelId>`，模型 id 自己可以再带斜杠。 */
function defaultProblem(providers, value) {
	if (value === "") return undefined;
	const slash = value.indexOf("/");
	if (slash <= 0) return `默认模型要写成 提供商/模型：${value}`;
	const provider = providers.find((item) => item.id === value.slice(0, slash));
	if (provider === undefined) return `没有叫「${value.slice(0, slash)}」的提供商`;
	const modelId = value.slice(slash + 1);
	if (!provider.models.some((model) => model.id === modelId)) return `「${provider.id}」没有模型 ${modelId}`;
	return undefined;
}

/** 探一次 `<baseUrl>/models`，把可用模型 id 列出来。失败不抛：界面上要能看见原因。 */
async function probe(baseUrl, apiKey, api) {
	const url = `${baseUrl.replace(/\/+$/, "")}/models`;
	const headers =
		apiKey === ""
			? {}
			: api === "anthropic"
				? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
				: { authorization: `Bearer ${apiKey}` };
	try {
		const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
		if (!response.ok) return { error: `${url} 返回 ${response.status}` };
		const body = await response.json();
		const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
		const models = list
			.map((item) => ({ id: String(item.id ?? item.name ?? ""), name: String(item.display_name ?? item.name ?? "") }))
			.filter((model) => model.id !== "");
		return models.length === 0 ? { error: `${url} 没有返回模型` } : { models };
	} catch (error) {
		return { error: `连不上 ${url}：${error.message}` };
	}
}

function text(value) {
	return typeof value === "string" ? value : "";
}

export async function apply(api) {
	const file = settingsPath(api.workspace);

	api.route({
		method: "GET",
		pattern: "/api/p/models",
		handle: async () => {
			try {
				return view(api.workspace, await readSettings(api.workspace));
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		},
	});

	api.route({
		method: "POST",
		pattern: "/api/p/models",
		handle: async (request) => {
			try {
				const body = request.body ?? {};
				const settings = await readSettings(api.workspace);
				const cleaned = clean(body.providers, providersOf(settings));
				if (cleaned.error !== undefined) return { error: cleaned.error };

				const defaultModel = text(body.defaultModel).trim();
				const problem = defaultProblem(cleaned.providers, defaultModel);
				if (problem !== undefined) return { error: problem };

				const next = { ...settings, providers: cleaned.providers };
				if (defaultModel === "") delete next.defaultModel;
				else next.defaultModel = defaultModel;

				// 指着已删 provider / 已删模型的记录一并清掉：核心会把它当成过期按默认走，
				// 留着只会在文件里越积越多，删一家 provider 看起来就像没删干净。
				const known = new Map(cleaned.providers.map((provider) => [provider.id, new Set(provider.models.map((model) => model.id))]));
				const agentModels = {};
				const saved = typeof settings.agentModels === "object" && settings.agentModels !== null ? settings.agentModels : {};
				for (const [slug, ref] of Object.entries(saved)) {
					if (typeof ref !== "string") continue;
					const slash = ref.indexOf("/");
					if (slash <= 0) continue;
					if (known.get(ref.slice(0, slash))?.has(ref.slice(slash + 1)) === true) agentModels[slug] = ref;
				}
				if (Object.keys(agentModels).length === 0) delete next.agentModels;
				else next.agentModels = agentModels;

				// 先写临时文件再换名：写到一半崩掉不会留下半份 JSON（这份文件坏了 = 全员不回话）。
				// 文件名带序号：核心的 `setAgentModel` 也会写这份文件，同名 `.tmp` 会互相覆盖。
				const temp = `${file}.${process.pid}.${writeSeq++}.tmp`;
				await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
				await rename(temp, file);
				api.log(`写了 ${file}（${cleaned.providers.length} 个提供商）`);
				return view(api.workspace, next);
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		},
	});

	api.route({
		method: "POST",
		pattern: "/api/p/models/probe",
		handle: async (request) => {
			try {
				const body = request.body ?? {};
				const existing = providersOf(await readSettings(api.workspace)).find(
					(provider) => provider.id === text(body.providerId),
				);
				const baseUrl = text(body.baseUrl).trim() || existing?.baseUrl;
				if (baseUrl === undefined) return { error: "先填一个地址再探测" };
				const apiKey = text(body.apiKey).trim() || existing?.apiKey || "";
				const kind = text(body.api) || existing?.api || "openai-responses";
				return await probe(baseUrl, apiKey, kind);
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		},
	});
}
