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
import { defineDoc } from "../runtime/index.ts";

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
	 * 消息类别。生成侧只有：`chat` 普通发言、`say`（agent 说的话）、`note` 系统留痕
	 * （不唤醒、不计未读）、`question` / `decision` / `report` 语义标签。
	 *
	 * 类型是 `string` 而不是联合类型：历史库里还躺着 `think` / `tool` / `work` / `step`
	 * 这些不再产生的 kind（ADR-081 删掉过程投影后不清理旧数据），读取侧按普通行显示。
	 */
	kind: string;
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
};

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

export const ChannelDoc = defineDoc<ChannelState>({
	kind: "core.channels",
	version: 1,
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

/** 我的 slug。不是 agent，但出现在成员表里。 */
export const OWNER = "owner";

/** 我 slug。与 `OWNER` 同值，单独的常量名便于在阅读时区分「常量」与「比较」。 */
export const OWNER_SLUG = OWNER;

/** 私聊频道的命名规则。双方 slug 排序后拼接，保证 `a-b` 与 `b-a` 是同一个频道。 */
export function dmId(a: string, b: string): string {
	const [left, right] = [a, b].sort();
	return `dm:${left}-${right}`;
}

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
	if (!channel.id.startsWith("dm:")) return "group";
	if (channel.members.length !== 2) return "group";
	if (!channel.members.includes(OWNER)) return "group";
	return "dm";
}

/** 团队频道的命名规则。 */
export function teamId(team: string): string {
	return `team:${team}`;
}
