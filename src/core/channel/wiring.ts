/**
 * 频道层要的那几根线：会话在哪、谁叫醒了他、模板在哪、答完怎么收尾。
 *
 * 这些东西以前在 `shell/assemble.ts`、`tools/context.ts`、`team/settle.ts`、
 * `ownerSpeak` 里各接一遍 —— 同一份 `directoryWake` 造了三次、收尾器造了两次，
 * 改一处就要记得改四处。现在只在这里接一次，谁要谁拿 `ChannelWiring`。
 *
 * 它只依赖 `harness` 与两个路径，不认识「工具」「沉淀」「我说话」这些用途。
 */
import type { Conversation, Context, Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT } from "../runtime/index.ts";
import {
	DirectoryDoc,
	directoryWake,
	emptyDirectory,
	wakeOf,
	type WakeRecord,
} from "../agent/roster.ts";
import { createTurnFinisher, type FinishTurn } from "./turn/index.ts";
import type { Layout } from "../layout.ts";
import type { TextCatalog } from "../md/catalog.ts";

export type ChannelWiring = {
	readonly harness: Harness;
	/** 提示词模板目录（`<workspace>/prompt`）：回话规矩每轮从这里现读。 */
	readonly promptDir: string;
	/** 附件根（`<workspace>/uploads`）：投递要把图片读成内容块。 */
	readonly uploadsRoot: string;
	/** 机械文案目录（`text/`）：投递头、留痕、摘要行从这里取。 */
	readonly text?: TextCatalog;
	/** 一轮答完的收尾（ADR-099）。投递、我说话、沉淀共用这一个。 */
	readonly finishTurn: FinishTurn;
	conversationOf: (slug: string, context?: Context) => Promise<Conversation | undefined>;
	rememberWake: (slug: string, wake: WakeRecord, context?: Context) => Promise<void>;
	wakeOf: (slug: string, context?: Context) => Promise<WakeRecord | undefined>;
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
	/** 机械文案目录（`text/`）。装配时读一次；不给就只留键名。 */
	readonly text?: TextCatalog;
}): ChannelWiring {
	const wakeDeps = directoryWake({
		harness: deps.harness,
		...(deps.live === undefined ? {} : { live: deps.live }),
	});
	const promptDir = deps.layout.promptRoot;

	const wakeOfOf = async (slug: string, context: Context = BACKGROUND_CONTEXT): Promise<WakeRecord | undefined> => {
		const directory = (await deps.harness.snapshot(DirectoryDoc, context)) ?? emptyDirectory();
		const id = directory.slugToConversation[slug];
		return id === undefined ? undefined : wakeOf(directory, id);
	};
	const conversationOf = (slug: string, context: Context = BACKGROUND_CONTEXT) =>
		wakeDeps.conversationOf(slug, context);
	const rememberWake = (slug: string, wake: WakeRecord, context: Context = BACKGROUND_CONTEXT) =>
		wakeDeps.rememberWake(slug, wake, context);

	const finishTurn = createTurnFinisher({
		harness: deps.harness,
		promptDir,
		...(deps.text === undefined ? {} : { text: deps.text }),
		// 收尾发生在背景上下文里（结算之后），用不到调用方那一轮的覆盖层。
		conversationOf: (slug) => conversationOf(slug),
		rememberWake: (slug, wake) => rememberWake(slug, wake),
		wakeOf: (slug) => wakeOfOf(slug),
	});

	return {
		harness: deps.harness,
		promptDir,
		uploadsRoot: deps.layout.uploadsRoot,
		...(deps.text === undefined ? {} : { text: deps.text }),
		finishTurn,
		conversationOf,
		rememberWake,
		wakeOf: wakeOfOf,
	};
}
