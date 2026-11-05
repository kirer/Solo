/**
 * 工具的运行环境：装配给它们的那张依赖表，以及「我是谁 / 读状态」。
 *
 * 工具自己不读环境变量、不碰 `process`：需要什么全从这里拿。投递不在这里组装 ——
 * 接线只有一份（`wiring.flow`），工具只给「这次读到的频道快照」。
 */
import { BACKGROUND_CONTEXT, type Context, type Harness } from "../../runtime/index.ts";
import { readAllIdentities } from "../../agent/identity.ts";
import { slugFor, type DirectoryState } from "../../agent/roster.ts";
import { mentionRosterOf, type MentionRoster } from "../mentions.ts";
import type { ChannelWiring } from "../wiring.ts";
import { ChannelDoc, emptyChannelState, type ChannelState } from "../types.ts";
import type { Layout } from "../../layout.ts";
import { fill, type TextCatalog } from "../../md/catalog.ts";

/** 工具运行所需的一切。全部由外壳在启动时装配，工具自己不读环境变量。 */
export type CoreToolDeps = {
	readonly harness: Harness;
	/**
	 * 两个根的布局。工具要拼路径时只从这里取：
	 * 用户的组织在 `layout.userRoot`，应用自带的在 `layout.appRoot`。
	 */
	readonly layout: Layout;
	/**
	 * 文案目录（`<appRoot>/text/`）：工具描述、参数说明、拒绝话术全在里面。
	 * 缺省 = 空目录（测试与老工作区），此时工具只剩机械行为，不会抛。
	 */
	readonly text?: TextCatalog;
	/** 读名册（slug ↔ 会话）。 */
	readonly directory: (context: Context) => Promise<DirectoryState>;
	/** 落一次名册变更。 */
	readonly saveDirectory: (change: (state: DirectoryState) => DirectoryState, context: Context) => Promise<void>;
	/** 为某个 slug 建会话并绑定。缺省表示不支持热建（测试里可以不提供）。 */
	readonly openAgent?: (slug: string, context: Context) => Promise<number>;
	/** 按团队文件重建它的频道成员（幂等）。 */
	readonly syncTeam?: (team: string, context: Context) => Promise<void>;
	/**
	 * 叫这几个刚进团队频道的人自己报到（一条系统留痕，ADR-042）。
	 *
	 * 招人走这条：`openAgent` 会顺手把人加进频道，等 `syncTeam` 时「新进的」已经算没了，
	 * 所以招人自己说「谁刚进来」。
	 */
	readonly announceJoin?: (team: string, slugs: readonly string[], context: Context) => Promise<void>;
	/** 保证这个人有「我 ↔ 他」的私聊（幂等）。缺省表示不支持（测试里可以不提供）。 */
	readonly ensureDm?: (slug: string, context: Context) => Promise<void>;
	/** 现在能挑的模型与默认值（招人时按角色分）。 */
	readonly modelChoices?: () => Promise<{ readonly models: readonly string[]; readonly default?: string }>;
	/** 给某个人定模型（校验 → 改会话 → 记进 settings.json）。 */
	readonly setModel?: (slug: string, ref: string, context: Context) => Promise<{ readonly model: string }>;
	/**
	 * 频道层接线：投递门面（`wiring.flow`）与会话在哪、答完怎么收尾。
	 * 由 `channel/wiring.ts` 的 `wireChannel` 造一次，工具、我说话共用。
	 */
	readonly wiring: ChannelWiring;
};

/**
 * 工具的唯一出口：一段给模型读的自然语言。
 *
 * 也接受 `{ error }` —— `actionOf` / `defaultChannel` 这类「参数不合法」的结果直接
 * 丢进来就行，不用每个调用点再拆一次。
 */
export function text(value: string | { readonly error: string }) {
	return { output: [{ type: "text" as const, text: typeof value === "string" ? value : value.error }] };
}

/**
 * 读一个枚举型参数。
 *
 * 校验失败时要把合法值列出来 —— 模型看到「只有 list / read」才知道下一步该改什么，
 * 只回一句「参数不合法」它就只能乱试。
 */
export function actionOf(
	value: string | undefined,
	allowed: readonly string[],
	fallback: string,
	label = "action",
	catalog?: TextCatalog,
): string | { error: string } {
	if (value === undefined || value.trim() === "") return fallback;
	if (allowed.includes(value)) return value;
	const message = fill(catalog, "tool.action.invalid", {
		label,
		allowed: allowed.join(" / "),
		value,
	});
	return { error: message === "" ? `${label}: ${value}` : message };
}

/** 这个工具调用属于哪个 slug。名册里找不到就给一句明确的错误。 */
export async function selfOf(deps: CoreToolDeps, conversationId: number, context: Context): Promise<string | undefined> {
	const directory = await deps.directory(context);
	return slugFor(directory, conversationId);
}

/**
 * 「先知道自己是谁」：八个工具的第一句都是这件事，文案只在这里写一次。
 *
 * 查不到时返回一句能直接回给模型的话（工具不抛错：抛错它看到的是堆栈）。
 */
export async function selfOrError(
	deps: CoreToolDeps,
	conversationId: number,
	context: Context,
	key = "tool.self.missing",
): Promise<string | { readonly error: string }> {
	const slug = await selfOf(deps, conversationId, context);
	if (slug !== undefined) return slug;
	const message = fill(deps.text, key);
	return { error: message === "" ? key : message };
}

/** 当前名册：`@` 别名解析用。每次现读盘（`say` 不是热路径，且改 `identity.md` 要立刻生效）。 */
export async function mentionRoster(deps: CoreToolDeps): Promise<MentionRoster> {
	const all = await readAllIdentities(deps.layout.agentRoots);
	return mentionRosterOf(
		all.map((identity) => ({
			slug: identity.slug,
			name: identity.name,
		})),
	);
}

/**
 * 读一份频道状态。
 *
 * **必须用 `BACKGROUND_CONTEXT` 读，不能用工具自己的 `ctx`。**
 *
 * 踩过这个坑，症状是「一条消息发两遍」：`say` 用工具 ctx 读快照，紧接着又用同一个
 * ctx 提交；提交一结束，那份读覆盖层就被释放了，而 `postMessage` 在提交**之后**还要读
 * `channel.members` 去算收件人 —— 于是抛 `Cannot use a settled overlay`。消息其实已经
 * 落库，模型看到报错以为没发出去，再发一次，频道里就出现两条一模一样的话。
 *
 * 用背景上下文读拿到的是已提交的数据；这几个工具都是「先读、再提交」，读的时候还没有
 * 本次写入，语义完全一样，但读到的对象不会随提交失效。
 */
export async function readState(deps: CoreToolDeps): Promise<ChannelState> {
	return (await deps.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) ?? emptyChannelState();
}

