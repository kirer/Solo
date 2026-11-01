/**
 * 用例层（app）看出去的世界：**装配好的核心**。
 *
 * 这个类型以前长在 `shell/assemble.ts` 里叫 `CoreShell`。搬到这里是因为依赖方向：
 * `shell → app → domain`，用例层不能反过来 import 外壳。`assemble.ts` 现在只是
 * `export type CoreShell = CoreServices`，两边不各写一份。
 *
 * 只放类型，不放实现 —— 实现仍然是 `assemble.ts` 那唯一一处装配点。
 */
import type { Conversation, Context, Harness, Models, Registry } from "../runtime/index.ts";
import type { DirectoryState } from "../agent/roster.ts";
import type { ChannelState, Attachment, Message } from "../channel/types.ts";
import type { DeliverResult } from "../channel/dispatch.ts";
import type { Identity } from "../agent/identity.ts";
import type { PluginHost } from "../plugin/index.ts";
import type { Diag } from "./diag.ts";

export type CoreServices = {
	readonly harness: Harness;
	readonly registry: Registry;
	/** slug → 会话。已经建好的都在里面。 */
	readonly conversations: ReadonlyMap<string, Conversation>;
	/** 名册快照（只读用途；写请走工具）。 */
	readonly directory: DirectoryState;
	/**
	 * 一条消息落地之后的钩子（团队记忆自动沉淀）。
	 *
	 * 装配时只造一个：它无状态（读的都是当下的事实），每个发言入口再造一个就是两份语义。
	 */
	readonly afterPost: (message: Message, channelId: string, context: Context) => Promise<void>;
	/** 重新扫描文件夹，给新出现的人开会话。返回新建的 slug。 */
	readonly rescan: (context?: Context) => Promise<readonly string[]>;
	/**
	 * 给某个人开会话（已存在就直接返回）。`hire` 内部就用它，外壳/测试也用同一个入口。
	 *
	 * 返回会话的数字 id（界面拿它当 `conversationId`）。
	 */
	readonly openAgent: (slug: string, context?: Context) => Promise<number>;
	/** 读一次频道状态（工具内部已自带，这个是给外壳/API 用的）。 */
	readonly channels: (context?: Context) => Promise<ChannelState>;
	/** 我说话。宿主入口，语义与 agent 的 `say` 完全一致。 */
	readonly ownerSay: (
		options: {
			readonly channelId: string;
			readonly text: string;
			readonly replyTo?: number;
			readonly kind?: string;
			/** 附件引用。给了模型就能真的看见这些图片 / 读到这些文件。 */
			readonly attachments?: readonly Attachment[];
		},
		context?: Context,
	) => Promise<{ readonly seq: number; readonly delivery: DeliverResult }>;
	/**
	 * **任何**一方在频道里说话（我走 `OWNER`，agent 走自己的 slug）。
	 *
	 * 与 `ownerSay` 是同一个动作，只差发件人是谁 —— 所以它排在 `ownerSay` 里面
	 * （`ownerSay = postAs(OWNER, ...)`），不写第二份语义。
	 */
	readonly postAs: (
		options: {
			readonly channelId: string;
			readonly from: string;
			readonly text: string;
			readonly replyTo?: number;
			readonly kind?: string;
			/** 附件引用。给了模型就能真的看见这些图片 / 读到这些文件。 */
			readonly attachments?: readonly Attachment[];
		},
		context?: Context,
	) => Promise<{ readonly seq: number; readonly delivery: DeliverResult }>;
	/** 名册：slug ↔ 会话 id 的当前快照（界面拿它把 slug 翻成数字 id）。 */
	readonly bindings: () => DirectoryState;
	/** 显示名：slug → `identity.md` 里的 name。 */
	readonly labelOf: (slug: string) => string;
	/** 当前所有身份（每次都重读盘：改 `identity.md` 立刻反映到档案页）。 */
	readonly identities: () => Promise<readonly Identity[]>;
	/** 按团队文件重建它的频道成员（幂等）。`write_team` 里用过，界面也用它。 */
	readonly syncTeam: (team: string, context?: Context) => Promise<void>;
	/**
	 * 某人**此刻**会看到的提示词原文。
	 *
	 * 给自测与调试用：断言「规矩真的进了提示词」时不该靠猜。它调的是会话里同一个
	 * section 的 `render`，所以拿到的就是模型下次开口时会读到的东西。
	 */
	readonly promptOf: (slug: string, context?: Context) => Promise<string>;
	/**
	 * 装上的插件（工具 / 提示词 / 路由 / 消息钩子 / 清单）。
	 *
	 * 重装插件时整份换掉（见 `reloadPlugins`），所以读的人不要把它缓存下来。
	 * 没有插件时是 `emptyPluginHost`，不是 `undefined` —— 免得每个用到的地方都写分支。
	 */
	readonly plugins?: PluginHost;
	/**
	 * 重新装一遍插件（开关 / 装 / 卸 / 改了后端代码都走它，不用重启 —— ADR-026）。
	 * 装完 `plugins` 就是新的那一份。
	 */
	reloadPlugins?(): Promise<void>;
	readonly agentsRoot: string;
	readonly teamsRoot: string;
	readonly allChannel: string;
	/**
	 * 装配好的模型注册表与默认模型。给「单独给某个人换模型」用：先确认那只模型真的
	 * 存在，再写进会话 —— 写一个解析不到的引用，那个人此后每次都 `no_model`。
	 */
	readonly models?: Models;
	/** 当下用的默认模型：`settings.json` 改了会变，所以读它、别缓存。 */
	readonly defaultModel?: { readonly provider: string; readonly modelId: string } | undefined;
	/**
	 * `settings.json` 变过就重新装一遍提供商（ADR-025）。改模型配置的用例在**读注册表之前**
	 * 调一次，否则刚加的模型要等重启才认得。
	 */
	refreshModels?(): Promise<void>;
	/**
	 * 诊断出口。装配方（`shell/main.ts`）在 `openCore` **之前**就要建好它：底座的
	 * `onReport` 要往同一个实例里报，两边各建一个就看不到彼此的 `lastReport`。
	 */
	readonly diag?: Diag;
	readonly close: (context?: Context) => Promise<void>;
};
