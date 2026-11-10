/**
 * 用例层（app）看出去的世界：**装配好的核心**。
 *
 * 这个类型以前长在 `shell/assemble.ts` 里叫 `CoreShell`。搬到这里是因为依赖方向：
 * `shell → app → domain`，用例层不能反过来 import 外壳。`assemble.ts` 现在只是
 * `export type CoreShell = CoreServices`，两边不各写一份。
 *
 * 只放类型，不放实现 —— 实现仍然是 `assemble.ts` 那唯一一处装配点。
 */
import type { Conversation, Context, Harness, Models, Registry } from "../core/runtime/index.ts";
import type { DirectoryState } from "../core/channel/roster.ts";
import type { ChannelState, Attachment, Message } from "../core/channel/types.ts";
import type { DeliverResult } from "../core/flow/types.ts";
import type { Identity } from "../core/documents/member/identity.ts";
import type { Layout } from "../core/layout.ts";
import type { TextCatalog } from "../core/documents/base/catalog.ts";
import type { PluginHost } from "../core/plugin/index.ts";
import type { Diag } from "./diag.ts";

export type CoreServices = {
	readonly harness: Harness;
	readonly registry: Registry;
	/** slug → 会话。已经建好的都在里面。 */
	readonly conversations: ReadonlyMap<string, Conversation>;
	/** 名册快照（只读用途；写请走工具）。 */
	readonly directory: DirectoryState;
	/**
	 * 一条消息落地之后的钩子（插件听消息）。
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
			/** 唯一的非默认 kind：系统留痕。发言不传。 */
			readonly kind?: "note";
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
			/** 唯一的非默认 kind：系统留痕。发言不传。 */
			readonly kind?: "note";
			/** 附件引用。给了模型就能真的看见这些图片 / 读到这些文件。 */
			readonly attachments?: readonly Attachment[];
			/** 不按 @ 推算，直接叫醒这几个人（系统留痕叫人时用）。 */
			readonly wakeTo?: readonly string[];
			/**
			 * 这句是**人亲手打的**。只有「我这边的输入框」能传 `true`：
			 * 代理 / 工具替我说话一律不传，否则插件分不清谁说的。
			 */
			readonly human?: boolean;
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
	readonly plugins: PluginHost;
	/**
	 * 重新装一遍插件（开关 / 装 / 卸 / 改了后端代码都走它，不用重启 —— ADR-026）。
	 * 装完 `plugins` 就是新的那一份。
	 */
	reloadPlugins(): Promise<void>;
	/**
	 * 这个宿主能不能做系统动作（桌面壳给的那两个函数）。
	 *
	 * 界面要按它决定「批权限」那颗按钮显不显示：网页版后端做不了，批了也只是个摆设。
	 */
	readonly system?: {
		readonly act: (action: "reveal" | "open", absolutePath: string) => Promise<void>;
		readonly copyText: (text: string) => Promise<void>;
	};
	/**
	 * 两个根的布局：应用私有目录（助理、提示词、插件、配置、库）与用户目录（成员、团队、技能）。
	 * 用例层要拼路径时**只从这里取**，不要自己 `dirname`。
	 */
	readonly layout: Layout;
	/**
	 * 出厂插件账本（谁被用户删过、怎么装回来）。
	 *
	 * 由外壳装配时注入，不在这里 import `shell/` —— 依赖方向只有 `shell → app` 一条。
	 * 没有它（单测 / 精简装配）时，删掉的插件不会记进账本，装回入口也不出现。
	 */
	readonly seededPlugins?: {
		/** 记一笔「用户删了这个出厂插件」。 */
		readonly markRemoved: (name: string) => Promise<void>;
		/** 用户删掉的出厂插件名（界面上「装回来」能挑的）。 */
		readonly removed: () => Promise<readonly string[]>;
		/** 把删掉的出厂插件装回来（用出厂那份）。装上了返回 true。 */
		readonly restore: (name: string) => Promise<boolean>;
		/** 这个名字在不在出厂那份里（决定「删了还能不能装回来」，也决定日志怎么写）。 */
		readonly isShipped: (name: string) => Promise<boolean>;
	};
	/** 文案目录（`<appRoot>/text/`）：用例层要回一句话给模型/界面时从这里取。 */
	readonly text: TextCatalog;
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
	 * 给某个人换模型：校验（注册表里真有）→ 改会话 → 记进 `settings.json`。
	 * 空串 = 跟默认。招人和界面上的「换模型」走同一条路，不各写一份写盘逻辑。
	 */
	setModel?(slug: string, ref: string, context?: Context): Promise<{ readonly model: string }>;
	/**
	 * 现在能选的模型（`provider/modelId`）与默认值。招人时按角色挑，只能从这里挑 ——
	 * 写一个解析不到的引用，那个人此后每次都 `no_model`。
	 */
	modelChoices?(): Promise<{ readonly models: readonly string[]; readonly default?: string }>;
	/**
	 * 诊断出口。装配方（`shell/main.ts`）在 `openCore` **之前**就要建好它：底座的
	 * `onReport` 要往同一个实例里报，两边各建一个就看不到彼此的 `lastReport`。
	 * 必填：`createApp` 不再自己补一个 —— 补出来的那个收不到底座的报告。
	 */
	readonly diag: Diag;
	readonly close: (context?: Context) => Promise<void>;
};
