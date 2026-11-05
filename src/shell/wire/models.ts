/**
 * 模型切换：`settings.json` 一改就就地重装，不用重启（ADR-025）。
 *
 * 只认「配置 + 会话表」，不认频道、插件、工具。留在装配函数里时，改模型的人
 * 要先读完整个装配顺序；拆出来之后它是装配里最独立的一段。
 */
import type { Conversation, Context, Models } from "../../core/runtime/index.ts";
import { BACKGROUND_CONTEXT, syncModels } from "../../core/runtime/index.ts";
import { parseModelRef, setAgentModel } from "../../core/runtime/models.ts";
import { mtimeOrUndefined } from "../../core/runtime/io.ts";
import type { Layout } from "../../core/layout.ts";

export type ModelRef = { readonly provider: string; readonly modelId: string };

export type ModelSwitchOptions = {
	/** 模型注册表：界面改某个人的模型时要先确认那只模型真的存在。 */
	readonly models?: Models | undefined;
	readonly defaultModel?: ModelRef | undefined;
	readonly agentModels?: Readonly<Record<string, ModelRef>> | undefined;
};

export type ModelSwitcher = ReturnType<typeof createModelSwitcher>;

export function createModelSwitcher(deps: {
	readonly options: ModelSwitchOptions;
	readonly layout: Layout;
	readonly conversations: ReadonlyMap<string, Conversation>;
}) {
	const { options, layout, conversations } = deps;
	let defaultModel = options.defaultModel;
	let agentModels = options.agentModels;
	let settingsStamp: number | undefined;

	/**
	 * `settings.json` 变了就把提供商重新装进注册表（原地 upsert，不用重启）。
	 *
	 * 每处「要读模型」的地方先调一次：一次 stat，没变就返回。默认模型换了还要把
	 * **没单独指定模型的人**重新对齐 —— 他们身上挂的是旧的那一只。
	 */
	async function refreshModels(ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
		if (options.models === undefined) return;
		const file = layout.settingsFile;
		const stamp = await mtimeOrUndefined(file);
		if (stamp === undefined || stamp === settingsStamp) return;
		settingsStamp = stamp;
		const applied = syncModels(options.models, file);
		if (applied === undefined) return;
		defaultModel = applied.defaultModel;
		agentModels = applied.agentModels;
		for (const [slug, conversation] of conversations) {
			if (agentModels?.[slug] !== undefined) continue;
			await applyModel(conversation, slug, ctx).catch(() => undefined);
		}
	}

	/** 这个人该用哪只模型：单独指定的压过默认。都没有就是「没有模型」（ADR-023）。 */
	function modelFor(slug: string): ModelRef | undefined {
		return agentModels?.[slug] ?? defaultModel;
	}

	/** 能挑的模型（招人时按角色分）。先刷一遍配置：刚在设置里加的提供商要能被看见。 */
	async function modelChoices(ctx: Context = BACKGROUND_CONTEXT): Promise<{ models: readonly string[]; default?: string }> {
		await refreshModels(ctx);
		const models = (options.models?.getModels() ?? []).map((model) => `${model.provider}/${model.id}`);
		return { models, ...(defaultModel === undefined ? {} : { default: `${defaultModel.provider}/${defaultModel.modelId}` }) };
	}

	/**
	 * 给某个人换模型：**当场生效**，并记进 `settings.json` 的 `agentModels`。
	 *
	 * 空串 = 跟默认（删掉这条记录）。只认注册表里真有的模型：写一个解析不到的引用，
	 * 这个人此后每轮都 `no_model`，而界面上只是一句「他这一轮没答上来」。
	 */
	async function setModel(slug: string, ref: string, ctx: Context = BACKGROUND_CONTEXT): Promise<{ model: string }> {
		await refreshModels(ctx);
		if (!conversations.has(slug)) throw new Error(`没有这个人的会话：${slug}`);
		const value = ref.trim();
		const wanted = value === "" ? defaultModel : parseModelRef(value);
		if (wanted === undefined) {
			throw new Error(value === "" ? "还没有配置默认模型，先配一只" : `模型要写成 提供商/模型：${value}`);
		}
		if (options.models !== undefined && options.models.getModel(wanted.provider, wanted.modelId) === undefined) {
			const available = (await modelChoices(ctx)).models;
			throw new Error(`没有这个模型：${value}（可选：${available.join("、") || "（还没有配置模型）"}）`);
		}
		await conversations.get(slug)?.configure({ model: { provider: wanted.provider, modelId: wanted.modelId } }, ctx);
		const next = { ...(agentModels ?? {}) };
		if (value === "") delete next[slug];
		else next[slug] = { provider: wanted.provider, modelId: wanted.modelId };
		agentModels = Object.keys(next).length === 0 ? undefined : next;
		setAgentModel(layout.settingsFile, slug, value === "" ? null : value);
		return { model: value };
	}

	/** 补模型（幂等：已经是这个模型就不写，避免每次重启都产生一次提交）。 */
	async function applyModel(conversation: Conversation, slug: string, ctx: Context): Promise<void> {
		const wanted = modelFor(slug);
		if (wanted === undefined) return;
		const agent = await conversation.agent(ctx);
		const current = agent.model;
		if (current !== undefined && current.provider === wanted.provider && current.modelId === wanted.modelId) {
			return;
		}
		await conversation.configure({ model: { provider: wanted.provider, modelId: wanted.modelId } }, ctx);
	}

	return {
		refreshModels,
		modelFor,
		modelChoices,
		setModel,
		applyModel,
		// getter：读的人每次都拿当下那一只。
		get defaultModel() {
			return defaultModel;
		},
	};
}
