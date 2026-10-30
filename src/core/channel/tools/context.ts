/**
 * 工具的运行环境：装配给它们的那张依赖表，以及「我是谁 / 读状态 / 组装投递」。
 *
 * 工具自己不读环境变量、不碰 `process`：需要什么全从这里拿。
 */
import { BACKGROUND_CONTEXT, type Context, type Harness } from "../../runtime/index.ts";
import { readAllIdentities } from "../../agent/identity.ts";
import { conversationFor, directoryWake, slugFor, wakeOf, type DirectoryState } from "../../agent/roster.ts";
import { type PostDeps } from "../post.ts";
import type { FinishTurn } from "../turn/index.ts";
import { mentionRosterOf, type MentionRoster } from "../mentions.ts";
import { ChannelDoc, emptyChannelState, type ChannelState, type Message } from "../types.ts";
import { promptDirOf } from "../../md/prompt.ts";

/** 工具运行所需的一切。全部由外壳在启动时装配，工具自己不读环境变量。 */
export type CoreToolDeps = {
	readonly harness: Harness;
	/**
	 * 工作区根。`agents/` 与 `skills/` 都在它下面。
	 *
	 * 为什么工具需要它：`npx skills add` 会把技能装到**当前目录**下，所以在哪儿跑
	 * 决定了装到哪儿。全员层就是工作区根下的 `skills/`。
	 */
	readonly workspaceRoot: string;
	/** `workspace/agents`。 */
	readonly agentsRoot: string;
	/** `workspace/teams`。 */
	readonly teamsRoot: string;
	/** 读名册（slug ↔ 会话）。 */
	readonly directory: (context: Context) => Promise<DirectoryState>;
	/** 落一次名册变更。 */
	readonly saveDirectory: (change: (state: DirectoryState) => DirectoryState, context: Context) => Promise<void>;
	/** 为某个 slug 建会话并绑定。缺省表示不支持热建（测试里可以不提供）。 */
	readonly openAgent?: (slug: string, context: Context) => Promise<number>;
	/** 一条消息落地之后的钩子。外壳用它接「团队记忆自动沉淀」。 */
	readonly afterPost?: (message: Message, channelId: string, context: Context) => Promise<void>;
	/** 按团队文件重建它的频道成员（幂等）。 */
	readonly syncTeam?: (team: string, context: Context) => Promise<void>;
	/** 一轮正常答完时把最终回答补进频道（`channel/turn/finish.ts`）。 */
	readonly finishTurn?: FinishTurn;
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
): string | { error: string } {
	if (value === undefined || value.trim() === "") return fallback;
	if (allowed.includes(value)) return value;
	return { error: `${label} 只有 ${allowed.join(" / ")}，没有「${value}」。` };
}

/** 这个工具调用属于哪个 slug。名册里找不到就给一句明确的错误。 */
export async function selfOf(deps: CoreToolDeps, conversationId: number, context: Context): Promise<string | undefined> {
	const directory = await deps.directory(context);
	return slugFor(directory, conversationId);
}

/**
 * 「先知道自己是谁」：七个工具的第一句都是这件事，文案只在这里写一次。
 *
 * 查不到时返回一句能直接回给模型的话（工具不抛错：抛错它看到的是堆栈）。
 */
export async function selfOrError(
	deps: CoreToolDeps,
	conversationId: number,
	context: Context,
	hint = "你还不在名册里。",
): Promise<string | { readonly error: string }> {
	const slug = await selfOf(deps, conversationId, context);
	return slug ?? { error: hint };
}

/** 当前名册：`@` 别名解析用。每次现读盘（`say` 不是热路径，且改 `identity.md` 要立刻生效）。 */
export async function mentionRoster(deps: CoreToolDeps): Promise<MentionRoster> {
	const all = await readAllIdentities(deps.agentsRoot);
	return mentionRosterOf(
		all.map((identity) => ({
			slug: identity.slug,
			name: identity.name,
			title: identity.title,
			manager: identity.manager,
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

/** 组装一次投递的全部依赖（`say` 共用）。 */
export function postDeps(deps: CoreToolDeps, state: ChannelState, context: Context): PostDeps {
	// 唤醒依赖只有一份（`agent/roster.ts` 的 `directoryWake`）：投递、我说话、沉淀
	// 三条路共用同一套「会话在哪 / 记下被谁叫醒」。
	const wakeDeps = directoryWake({ harness: deps.harness });
	return {
		harness: deps.harness,
		state,
		// 回话规矩（`prompt/80-reply.md` 等）每轮现读：**agent 叫醒 agent 也要贴**。
		// 以前这里漏了它，于是成员 `say` 叫管理员时，管理员那条唤醒没有回话规矩 ——
		// 表现是「能回，但不知道要先把话说进频道」，日志里一行 warn 谁也没注意。
		promptDir: promptDirOf(deps.agentsRoot),
		conversationOf: (slug: string) => wakeDeps.conversationOf(slug, context),
		// 不给 `labelOf`：`post.ts` 的缺省就是恒等（显示名由 `deliver` 那一层自己算），
		// 传一个 `(slug) => slug` 只是把缺省重写一遍。
		rememberWake: (slug, wake) => wakeDeps.rememberWake(slug, wake, context),
		// 插话时要从上一次的记录里继承 `task`；一次投递里多个收件人共用一份名册快照。
		wakeOf: (() => {
			let snapshot: Promise<DirectoryState> | undefined;
			return async (slug: string) => {
				snapshot ??= deps.directory(BACKGROUND_CONTEXT);
				const directory = await snapshot;
				const id = conversationFor(directory, slug);
				return id === undefined ? undefined : wakeOf(directory, id);
			};
		})(),
		...(deps.finishTurn === undefined ? {} : { finishTurn: deps.finishTurn }),
	};
}
