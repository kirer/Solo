/**
 * 频道：folder 版。
 *
 * 三条决定形状的规矩：
 *
 * 1. **成员就是 `@slug`**。不用数字 `conversationId`：会话 id 会随库重建而变，
 *    而 slug（`members/<slug>/`）是文件夹名，稳定。
 * 2. **没有「全员群 / 领导层 / 团队群 / 私聊 / 工作记录」这套预置频道**。频道是
 *    文档里的一条记录，谁需要谁建；`@所有人` 不是频道，是不 @ 任何人的时候的默认行为。
 * 3. **没有一条 `log:` 频道**。「工作记录」不是一个房间，是一条消息的 `kind`。
 *
 * 规则都放在这个文件里，且都是纯函数 —— 它们决定「谁是唤醒对象」，是整套系统里
 * 最容易写错、也最需要单测的一段。
 */
import { defineDoc, type JsonObject } from "../runtime/index.ts";
import { isDmChannel } from "./id.ts";
import type { WakeRecord } from "./turn/record.ts";

/**
 * 一条消息带的一个附件。**只有引用，没有内容。**
 *
 * 文件本体在 `<workspace>/uploads/<id>`，这里只放展示与下载要用的元数据。
 * 为什么不在文档里存 base64：频道文档是**一条**文档，每次写入都是一条增量 op，
 * 一条 3 MB 的图片会让这个频道的每条消息都在同一条时间线上多背 3 MB —— 这里
 * 已经吃过一次「一条消息重写整个频道」（189 条频道涨到 27 MB），见 ADR-050。
 */
export type Attachment = {
	/** 上传接口分配的 id（`crypto.randomUUID()`），同时也是磁盘上的文件名。 */
	id: string;
	/** 原始文件名。界面显示与下载时的默认名都取它。 */
	name: string;
	/** 类别。**由服务端按 mime 重算**，客户端传什么都不算数。 */
	kind: "image" | "file";
	bytes: number;
};

/** 一条频道消息。 */
export type Message = {
	/** 频道内自增序号，从 1 开始。全系统唯一的消息锚点（引用回复存的就是它）。 */
	seq: number;
	/** 发件人的 slug。我是 `owner`。 */
	from: string;
	at: number;
	/** 正文。`@slug` 在里面，解析结果另存 `mentions`。 */
	text: string;
	/** 正文里解析出的 `@slug`，去重、按出现顺序。 */
	mentions: string[];
	/** 引用的那条消息的 seq。 */
	replyTo?: number;
	/**
	 * 消息类别，只有两种：`chat` 发言、`note` 系统留痕（不唤醒、不计未读）。
	 *
	 * 历史库里旧版本写过的 kind（`say` / `question` / `decision` / `report` / `think` /
	 * `tool` / `work` / `step`）在文档升到 v2 时由 `migrateMessages` 归一，读的代码
	 * 不用再记「哪些算发言」。
	 */
	kind: "chat" | "note";
	/**
	 * 系统留痕是哪一种：`run` = 后台命令跑完。界面据此把它收成一行（点开才看全文），
	 * 别的 `note` 照旧平铺。没有种类时不写这个键。
	 */
	noteOf?: string;
	/** 附件（图片/文件）。没有附件时**不写这个键**，与 `replyTo` 一个规矩。 */
	/*
	 * 为什么是可变数组而不是 `readonly`：文档层的 `JsonValue` 里数组是 `JsonValue[]`，
	 * `readonly Attachment[]` 不满足它（`ChannelState` 整个就不符合 `JsonObject` 了）。
	 * 「调用方不该改别人给的数组」这条用 `appendMessage` 入参的 `readonly` 表达就够了。
	 */
	attachments?: Attachment[];
	/**
	 * 需要我选的时候给的选项（2–6 个）。有它就说明这条消息在等我回答，
	 * 回答就是一条普通消息 + `replyTo` 指向它，正文写选项文字。
	 */
	options?: string[];
	/**
	 * 这条消息是替哪一条会话答案补发的（`turn.report` 的答案条目 id）。
	 *
	 * 一条答案会被多条提交各结算一次；判重靠这个 id，而不是正文相同 —— 两个人真说了
	 * 一样的话（「在。」「收到。」）不该互相吞掉。只在系统补发时写。
	 */
	sourceEntry?: string;
};

/**
 * 没人 @ 时谁接话。
 *
 * **可选**：不写就是老行为 —— 团队频道由 `wakeOnAll` 守着（助理接），别的频道叫醒
 * 「接上一位说话的」。写了就以它为准；`@` 永远优先于它。
 *
 * 为什么不是枚举 + 一堆布尔：三种形态各自需要的事实不同（lead 要一个人、everyone
 * 不需要人），判别联合让「lead 没写人」在类型上就不存在。
 */
export type ChannelResponder =
	/** 固定一个人接（必须是成员）。 */
	| { readonly kind: "lead"; readonly slug: string }
	/** 没人 @ 就没人接。 */
	| { readonly kind: "mentions" }
	/** 这个频道里除发件人和我之外的成员都接。 */
	| { readonly kind: "everyone" };

/** 一个频道。 */
export type Channel = {
	/** 频道 id：`general` / `team:alpha` / `dm:owner-cto` 之类，由建频道的人自己起。 */
	id: string;
	title: string;
	/** 成员 slug 列表。我用 `owner`。 */
	members: string[];
	/**
	 * 这个频道里「不 @ 也会被唤醒」的成员。
	 *
	 * 建群时写一次，之后就是普通字段：团队群里放助理、全员群里放 `owner`（收件人
	 * 永远排除发件人、也排除我，所以它不会让谁多醒一次）。私聊不需要它 ——
	 * 两个人里说话的那个会被排除，剩下的本来就会被叫醒。
	 */
	wakeOnAll: string[];
	createdAt: number;
	archived?: true;
	/**
	 * 这个频道的共享指令（≤12,000 字）。每轮贴在投递正文里，和 delivery 的其它文案
	 * 同一处渲染 —— 不进系统提示词：那是按人渲染的，频道是按消息变的，塞进去会让
	 * prompt cache 按频道碎裂。
	 */
	bulletin?: string;
	/** 没人 @ 时谁接话。不写 = 老行为（见 `ChannelResponder`）。 */
	responder?: ChannelResponder;
};

export type ChannelState = {
	channels: Record<string, Channel>;
	messages: Record<string, Message[]>;
	/** 每个频道的下一个 seq。分开存是为了「只 append 一条消息」时不用重写整个数组。 */
	nextSeq: Record<string, number>;
	/** `slug → 频道 id → 已读到的 seq`。只记自己读过的位置。 */
	readMarks: Record<string, Record<string, number>>;
};

/** 空状态。每次调用给一个新对象：它会被 `ensureChannel` 等原地改。 */
export function emptyChannelState(): ChannelState {
	return { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
}

/**
 * v1 → v2：把历史上的消息 kind 归一到两种。
 *
 * v1 时代 kind 是自由字符串（`say` / `question` / `decision` / `report`，以及 ADR-081
 * 之前的过程行 `think` / `tool` / `work` / `step`）。读的每一处都得记着「哪些算发言」；
 * 现在在**升版本的那一刻**归一次，之后 `spokenKind` 只剩一句 `kind !== "note"`。
 *
 * 过程行落成 `note`：它们本来就不算发言（不计未读、不当接话人），投影层也一直把
 * 非发言画成留痕，所以这一改写不改变任何看得到的行为。
 */
function migrateMessages(value: JsonObject, fromVersion: number): ChannelState {
	if (fromVersion >= 2) return value as unknown as ChannelState;
	const legacyProcess = new Set(["think", "tool", "work", "step"]);
	// 老数据里 `@我` 存的是字面 token（那时 `parseMentions` 不传名册）。归一成 `owner`，
	// 投递时就不用再拿一份「只认我」的名册重解析一遍。
	const ownerTokens = new Set([OWNER, "我"]);
	const state = value as unknown as ChannelState;
	const messages: Record<string, Message[]> = {};
	for (const [id, list] of Object.entries(state.messages ?? {})) {
		messages[id] = (list ?? []).map((message) => {
			const kind: unknown = message.kind;
			const mentions = (message.mentions ?? []).map((token) =>
				ownerTokens.has(String(token).normalize("NFKC").trim().replace(/^@+/, "").toLowerCase()) ? OWNER : token,
			);
			return {
				...message,
				kind: kind === "note" ? "note" : legacyProcess.has(String(kind)) ? "note" : "chat",
				mentions,
			};
		});
	}
	return { ...value, messages } as unknown as ChannelState;
}

export const ChannelDoc = defineDoc<ChannelState>({
	kind: "core.channels",
	version: 2,
	migrate: migrateMessages,
	scope: "session",
	initial: emptyChannelState,
	// 什么时候把散着的增量压成一条基线。两个理由各占一半：
	//
	// 1. **重放成本**：基线之前的历史不用再重放，崩溃恢复只重放最多 64 条增量。
	// 2. **磁盘空间**：这个文档是 `scope: "session"` 的，存储层写基线时会把该文档的
	//    旧 revision 全删（`isCurrentOnly` 为真）。也就是说「压基线」在这里同时是
	//    **唯一的回收机制** —— 不压，历史只增不减。
	//
	// 早先只按「单频道 ≥ 256 条消息」判断，结果一直不触发（最多 189 条），库里的
	// 增量无限累积到 60 MB。按增量条数判断拿得到确定的回收上限，与消息分布无关。
	//
	// 但长频道那条**必须带一个增量下限**：写成 `|| 某频道 ≥ 256 条` 就变成恒真 ——
	// 单频道一旦超过 256 条，之后**每次提交都压一份完整基线**（这个文档是 current-only，
	// 压基线会删掉旧 revision），于是「发一条消息」的成本 = 序列化整份频道历史。
	// 实测（2026-10-30）：1600 条时单条提交 0.45ms，且随消息数线性增长；3000 条时
	// 每发一条要写 200KB 以上，RSS 也跟着涨。长频道现在改成每 16 条压一次，
	// 回收上限仍然确定，但不会每条都压。
	checkpointWhen: (value, _ops, info) => {
		const longChannel = Object.values(value.messages).some((list) => list.length >= 256);
		return info.deltasSinceBase >= (longChannel ? 16 : 64);
	},
});

/**
 * 这条消息算不算「人说的话」：`note` 不算（不唤醒、不计未读、不当接话人）。
 *
 * 旧数据里的过程行在文档 v2 迁移时已经落成 `note`，这里不再维护第二份名单。
 */
export function spokenKind(kind: Message["kind"]): boolean {
	return kind !== "note";
}

/** 我的 slug。不是 agent，但出现在成员表里。 */
export const OWNER = "owner";

/** 我 slug。与 `OWNER` 同值，单独的常量名便于在阅读时区分「常量」与「比较」。 */
export const OWNER_SLUG = OWNER;

// id 的构造与解析只有一份，在 `id.ts`；这里转出去，老调用方（`import { dmId } from "./types.ts"`）不用改。
export { dmId, groupId, isDmChannel, isGroupChannel, teamId, teamOfChannel } from "./id.ts";

/**
 * 一条频道是哪种会话：**`dm:` 前缀 + 恰好 `{我, 一个 agent}`** 才是私聊。
 *
 * 为什么不能只看成员表：只有我 + 一个 agent 两个人的团队频道，成员形状和私聊一模一样。
 * 旧判据把它当私聊，于是投递正文里出现「这是你和我的私聊，只回这里」—— 团队频道里的
 * 协作被模型理解成悄悄话。私聊现在是**显式建出来的**（`dmId`，见 `POST /api/people/:slug/dm`），
 * 所以前缀可以当判据；团队频道永远是群聊。
 *
 * 频道仍然没有 `kind` 字段 —— 加了就要维护两处事实（成员变了、kind 没变）。
 */
export function chatKind(channel: Channel): "dm" | "group" {
	if (!isDmChannel(channel.id)) return "group";
	if (channel.members.length !== 2) return "group";
	if (!channel.members.includes(OWNER)) return "group";
	return "dm";
}

/*
 * ── 分发与收尾的策略形状（ADR-080）──────────────────────────────────
 *
 * 为什么在频道原语里：`plugin/` 不许 import `flow/`（分层规则：策略由装配层注入），
 * 而插件要注册策略、flow 要消费策略，两边都得看得见这几种形状。它们只有数据，
 * 没有实现，也不碰 IO —— 放在这里，两边都只 import 这一份。
 *
 * 规矩：策略只能**提议**。写盘、入队、成员校验、判重永远由 core 做。
 */

/** 路由需要的全部事实（只读）。 */
export type RouteFacts = {
	readonly message: {
		readonly seq: number;
		readonly from: string;
		readonly text: string;
		readonly kind: "chat" | "note";
		readonly mentions: readonly string[];
		readonly replyTo?: number;
	};
	readonly channel: {
		readonly id: string;
		readonly kind: "dm" | "group";
		readonly members: readonly string[];
		readonly wakeOnAll: readonly string[];
	};
	/** 我上一句话之后第一个接话的人（`speakerBefore`）。 */
	readonly lastSpeaker?: string;
	/** 不干预时内置规则会叫谁；策略可以在此基础上加减。 */
	readonly defaultTargets: readonly string[];
};

/** 一个策略的提议：叫这几个人，或者明确不叫。 */
export type RouteDecision =
	| { readonly kind: "targets"; readonly targets: readonly string[]; readonly reason: string }
	| { readonly kind: "drop"; readonly reason: string };

/** 收尾判断要看的事实（只读）。 */
export type SettleFacts = {
	readonly slug: string;
	readonly wake: WakeRecord;
	/** 判断说过话、判重都要看整个频道状态。 */
	readonly state: ChannelState;
	/** 这次答案的最后一段正文（已 trim）；`undefined` = 会话里找不到答案条目。 */
	readonly text?: string;
	/** 这一轮最后一个动作是不是 `say` / `route`（`saidLast`）。 */
	readonly saidLast: boolean;
	/** 收尾的人是助理。助理在团队频道里只留派活与进展，结论不靠收尾补进任务频道（ADR-110）。 */
	readonly assistant?: boolean;
};

/** 收尾的提议：补一段正文进某个频道，或者明确不补。 */
export type SettleDecision =
	| { readonly kind: "repost"; readonly channelId: string; readonly text: string }
	| {
			readonly kind: "silent";
			readonly reason: "no-entry" | "pass" | "no-target" | "not-member" | "duplicate";
	  };

/**
 * 一条可注册的策略。`router` 参与「叫谁」的链（先注册的先问），
 * `settle` 替换默认收尾（最后注册的那条生效，弃权或抛错回退默认）。
 */
export type FlowPolicy =
	| {
			readonly kind: "router";
			run(facts: RouteFacts): RouteDecision | undefined | Promise<RouteDecision | undefined>;
	  }
	| {
			readonly kind: "settle";
			run(facts: SettleFacts): SettleDecision | undefined | Promise<SettleDecision | undefined>;
	  };
