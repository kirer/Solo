/**
 * 频道层要的那几根线：会话在哪、谁叫醒了他、模板在哪、答完怎么收尾。
 *
 * 这些东西以前在 `shell/assemble.ts`、`tools/context.ts`、`documents/team/doc.ts`、
 * `ownerSpeak` 里各接一遍 —— 同一份 `directoryWake` 造了三次、收尾器造了两次，
 * 改一处就要记得改四处。现在只在这里接一次，谁要谁拿 `ChannelWiring`。
 *
 * 它只依赖 `harness` 与两个路径，不认识「工具」「我说话」这些用途。
 */
import type { Conversation, Context, Harness, Submission, SubmissionId, Tx } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT } from "../runtime/index.ts";
import {
	DirectoryDoc,
	conversationFor,
	directoryWake,
	emptyDirectory,
	wakeOf,
	type WakeRecord,
} from "./roster.ts";
import { createTurnFinisher, type FinishTurn } from "./turn/index.ts";
import { assistantsOf, readAllIdentities } from "../documents/member/identity.ts";
import { mentionRosterOf } from "./mentions.ts";
import { createChannelFlow, type ChannelFlow } from "./post.ts";
import type { FlowPolicy, Message } from "./types.ts";
import type { FlowReport } from "../flow/ports.ts";
import type { Layout } from "../layout.ts";
import type { TextCatalog } from "../documents/base/catalog.ts";

export type ChannelWiring = {
	readonly harness: Harness;
	/** 提示词模板目录（`<workspace>/prompt`）：回话规矩每轮从这里现读。 */
	readonly promptDir: string;
	/** 附件根（`<workspace>/uploads`）：投递要把图片读成内容块。 */
	readonly uploadsRoot: string;
	/** 机械文案目录（`text/`）：投递头、留痕、摘要行从这里取。 */
	readonly text?: TextCatalog;
	/**
	 * 投递门面：工具、我说话、系统留痕共用这一个。
	 *
	 * 接线（会话在哪、谁叫醒了他、模板在哪）只在这里接一次，调用方只给「这次读到的
	 * 频道快照」和输入。
	 */
	readonly flow: ChannelFlow;
	/** 一轮答完的收尾（ADR-099）。投递、我说话共用这一个。 */
	readonly finishTurn: FinishTurn;
	/** 会话键（就是 slug）→ 会话。 */
	conversationOf: (key: string, context?: Context) => Promise<Conversation | undefined>;
	rememberWake: (key: string, wake: WakeRecord, context?: Context) => Promise<void>;
	wakeOf: (key: string, context?: Context) => Promise<WakeRecord | undefined>;
	/**
	 * 原子唤醒：名册的 wake 与「这条输入入队」写进同一个 commit（ADR-076）。
	 *
	 * `submissionOf` 是 commit 之后重新拿句柄用的：事务形式只给 id，不给可等待的句柄。
	 */
	readonly wakeTogether?: {
		readonly rememberWake: (tx: Tx, key: string, wake: WakeRecord) => Promise<void>;
		readonly submissionOf: (id: SubmissionId, context?: Context) => Promise<Submission | undefined>;
	};
};

/**
 * 接一次线。
 *
 * `live`：装配期内存里的会话表。名册是异步落盘的，刚 `hire` 出来的人可能还没写进去，
 * 先查内存才不会把「新招的人」静默算成「没有人」。
 */
export function wireChannel(deps: {
	readonly harness: Harness;
	/** 两个根的布局：提示词在 app 根，上传也在 app 根。 */
	readonly layout: Layout;
	readonly live?: () => ReadonlyMap<string, Conversation>;
	/** 会话键找不到时开一条（装配层给）。 */
	readonly open?: (key: string, context: Context) => Promise<Conversation | undefined>;
	/** 机械文案目录（`text/`）。装配时读一次；不给就只留键名。 */
	readonly text?: TextCatalog;
	/** 一条公开消息落盘并投递之后（插件听消息）。收尾补发也要走到它。 */
	readonly afterPublish?: (message: Message, channelId: string, context: Context) => Promise<void>;
	/** 插件注册的分发 / 收尾策略：补发与投递走同一条策略链。 */
	readonly policies?: () => readonly FlowPolicy[];
	/** 策略出问题的出口（装配层接到 diag）。不给就 `console.warn`。 */
	readonly report?: FlowReport;
}): ChannelWiring {
	const wakeDeps = directoryWake({
		harness: deps.harness,
		...(deps.live === undefined ? {} : { live: deps.live }),
		...(deps.open === undefined ? {} : { open: deps.open }),
	});
	const promptDir = deps.layout.promptRoot;
	// 助理的结论回我的私聊（投递正文每轮据此选 `91-where-assistant.md`）。
	const assistants = async () => assistantsOf(deps.layout, await readAllIdentities(deps.layout.agentRoots));

	const wakeOfOf = async (key: string, context: Context = BACKGROUND_CONTEXT): Promise<WakeRecord | undefined> => {
		const directory = (await deps.harness.snapshot(DirectoryDoc, context)) ?? emptyDirectory();
		const id = conversationFor(directory, key);
		return id === undefined ? undefined : wakeOf(directory, id);
	};
	const conversationOf = (key: string, context: Context = BACKGROUND_CONTEXT) =>
		wakeDeps.conversationOf(key, context);
	const rememberWake = (key: string, wake: WakeRecord, context: Context = BACKGROUND_CONTEXT) =>
		wakeDeps.rememberWake(key, wake, context);
	const wakeTogether = {
		rememberWake: wakeDeps.rememberWakeTx,
		submissionOf: (id: SubmissionId, context: Context = BACKGROUND_CONTEXT) =>
			deps.harness.submission(id, context),
	};
	// 补发也要按名册解析 `@`：跟 `say` / `ownerSpeak` 存下来的 `mentions` 保持同一形状。
	// 收尾与投递共用这一份 —— 两处各写一遍时，漏掉的那一处会把 `@我` 存成字面 token。
	const roster = async () =>
		mentionRosterOf(
			(await readAllIdentities(deps.layout.agentRoots)).map((identity) => ({
				slug: identity.slug,
				name: identity.name,
			})),
		);

	const finishTurn = createTurnFinisher({
		harness: deps.harness,
		promptDir,
		assistants,
		...(deps.text === undefined ? {} : { text: deps.text }),
		roster,
		// 收尾发生在背景上下文里（结算之后），用不到调用方那一轮的覆盖层。
		conversationOf: (slug) => conversationOf(slug),
		rememberWake: (slug, wake) => rememberWake(slug, wake),
		wakeTogether,
		wakeOf: (slug) => wakeOfOf(slug),
		...(deps.afterPublish === undefined ? {} : { afterPublish: deps.afterPublish }),
		...(deps.policies === undefined ? {} : { policies: deps.policies }),
		...(deps.report === undefined ? {} : { report: deps.report }),
	});

	const flow = createChannelFlow({
		harness: deps.harness,
		conversationOf,
		rememberWake,
		wakeTogether,
		wakeOf: wakeOfOf,
		uploadsRoot: deps.layout.uploadsRoot,
		promptDir,
		assistants,
		roster,
		...(deps.text === undefined ? {} : { text: deps.text }),
		...(deps.afterPublish === undefined ? {} : { afterPublish: deps.afterPublish }),
		...(deps.policies === undefined ? {} : { policies: deps.policies }),
		...(deps.report === undefined ? {} : { report: deps.report }),
	});

	return {
		harness: deps.harness,
		promptDir,
		uploadsRoot: deps.layout.uploadsRoot,
		...(deps.text === undefined ? {} : { text: deps.text }),
		flow,
		finishTurn,
		conversationOf,
		rememberWake,
		wakeOf: wakeOfOf,
		wakeTogether,
	};
}
