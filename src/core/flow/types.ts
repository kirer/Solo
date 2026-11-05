/**
 * 一条消息的一生：形状。
 *
 * 这里只有**数据**，没有实现。`publish.ts` / `forward.ts` 是三个动作的编排，
 * `runner.ts` 是「叫醒」的机械，`store.ts` 是落盘。读写这两条路都从这里拿类型。
 *
 * 为什么不直接用 `channel/types.ts`：那些是**领域原语**（消息、频道、附件），
 * 而这里是**流程的输入输出**（这次发布带不带 wakeTo、投递结果长什么样）。
 * 两者混在一起，读 `Channel` 的人就分不清哪些字段是落盘事实、哪些是这一次调用的参数。
 */
import type { Attachment, Channel, ChannelState, Message } from "../channel/types.ts";
import type { MentionRoster } from "../channel/mentions.ts";
import type { WakeRecord } from "../channel/turn/record.ts";
import type { Conversation, EntryRecord } from "../runtime/index.ts";
import type { Context } from "../runtime/index.ts";

/** 一次公开写入：一条新消息 + 它要不要唤醒谁。 */
export type PublishInput = {
	readonly channelId: string;
	readonly from: string;
	readonly text: string;
	readonly at: number;
	/** 唯一的非默认 kind：系统留痕。发言不传，落库就是 `chat`。 */
	readonly kind?: "note";
	/** 留痕的种类（`run` = 后台命令跑完）；只对 `note` 有意义，界面据此收成一行。 */
	readonly noteOf?: string;
	readonly replyTo?: number;
	/** 名册：给了就按名册把 `@我` / `@CEO` 落库成规范 slug。 */
	readonly roster?: MentionRoster;
	/** 正文里没写、但要记进 `mentions` 的 slug（带 `options` 时要叫醒我）。 */
	readonly mention?: readonly string[];
	/** 不想唤醒任何人（比如系统留痕）。缺省会唤醒。 */
	readonly wake?: false;
	/**
	 * 系统留痕也要叫醒谁时用（后台命令跑完，叫起跑的人回来看结果）。
	 *
	 * 给了就跳过「谁被 @」的推算：`note` 默认谁也不叫，而这条的收件人不是从正文里
	 * 解析出来的，是「谁起的这条命令」。
	 */
	readonly wakeTo?: readonly string[];
	/** 附件引用。必须在这里给（不是事后补），否则投递时还不知道有图，模型就看不见。 */
	readonly attachments?: readonly Attachment[];
	/** 要我选的选项（2–6 个）。落库、进界面，投递照常。 */
	readonly options?: readonly string[];
	/** 替哪条会话答案补发的（判重用，见 `Message.sourceEntry`）。 */
	readonly sourceEntry?: string;
};

/** 一条系统留痕：不叫醒、不计未读。 */
export type NoteInput = {
	readonly channelId: string;
	readonly text: string;
	readonly at: number;
};

/** 一次 `publish` 的结果。`delivery` 里没人时是三个空数组。 */
export type PublishResult = {
	readonly channel: Channel;
	readonly message: Message;
	readonly delivery: DeliverResult;
};

/** 逐条投递的结果。`delivered` 只代表进了队列，不代表已读。 */
export type DeliverResult = {
	/** 真的进了队列的 slug。不代表已读。 */
	readonly delivered: string[];
	/** 连队列都没进的 slug（消息仍在频道里）。 */
	readonly failed: string[];
	/** 没有会话、或就是我本人，跳过的 slug。 */
	readonly skipped: string[];
	/**
	 * 这次合并唤醒的账：谁本来已经有一条「还没开始」的排队项，被这一条取代了。
	 *
	 * 消息一条都没删（都在频道里），少掉的只是**重复的唤醒**。
	 */
	readonly merged?: readonly { readonly slug: string; readonly count: number }[];
};

/** 一个「叫了但没人会答」的收件人。拼成频道里的 `note` 用，我才能看见系统做了什么。 */
export type DeliverIssue = {
	readonly slug: string;
	/** 「还没有会话」还是「投递抛错」。两者文案不同，不能糊成一句。 */
	readonly reason: "no-conversation" | "failed";
	/** 抛错时的简短原因。 */
	readonly detail?: string;
};

/** 一次读盘：频道状态（算 @、算上下条）与这条消息要用的频道副本。 */
export type ChannelSnapshot = {
	readonly state: ChannelState;
	readonly channel: Channel;
};

/**
 * 策略形状住在 `channel/types.ts`：插件也要注册策略，而 `plugin/` 不许 import
 * `flow/`（分层规则）。这里转出去，`flow` 内部与既有调用点仍从这一份拿类型。
 */
export type {
	FlowPolicy,
	RouteDecision,
	RouteFacts,
	SettleDecision,
	SettleFacts,
} from "../channel/types.ts";

/** 经过策略与默认值之后、准备交给 core 校验的最终名单。 */
export type RecipientPlan = {
	readonly targets: readonly string[];
	/** 为什么是他们；写日志、测试断言、排障用。 */
	readonly reason: string;
};

/** 把一条**已经落库**的消息再交给几个人看（助理的后台分发）。 */
export type RouteExistingInput = {
	readonly channelId: string;
	readonly seq: number;
	readonly targets: readonly string[];
	/** 转交的人（助理的 slug）。投递正文里会写明。 */
	readonly routedBy?: string;
};

/** 收尾要读这次回答的最近条目：`Conversation` 与 task 的 `runtime` 都满足。 */
export type EntryReader = Pick<Conversation, "entries">;

/** 收尾要做的一切（拍平后方便测）。 */
export type FinishTurnInfo = {
	readonly slug: string;
	/** 只用来取答案条目；宿主路径给会话，durable task 给 `TaskRuntime`。 */
	readonly conversation: EntryReader;
	readonly answer: unknown;
	readonly wake: WakeRecord;
};

/** 一次收尾的结果：补发了哪条、为什么没补、或者补发失败（后者要进 durable 终态）。 */
export type SettleResult =
	| { readonly kind: "reposted"; readonly message: Message }
	| {
			readonly kind: "silent";
			readonly reason: "no-entry" | "pass" | "no-target" | "not-member" | "duplicate" | "unanswered";
	  }
	| { readonly kind: "failed"; readonly error: string };

export type FinishTurn = (info: FinishTurnInfo, context: Context) => Promise<SettleResult>;

/**
 * 一次结算。两种来源，一个入口：
 * - `done`：durable 收尾任务（`turn/report.ts`）给的答案；
 * - `unanswered`：投递后台等到的失败（`runner.ts` 的结算回调），只留痕。
 */
export type Settlement =
	| {
			readonly kind: "done";
			readonly slug: string;
			readonly answer: unknown;
			readonly wake: WakeRecord;
			readonly entries: EntryReader;
	  }
	| { readonly kind: "unanswered"; readonly channelId: string; readonly text: string };

/** 收尾判断产出的条目（`answerEntry` 的返回）。 */
export type AnswerEntry = {
	readonly entry: EntryRecord | undefined;
	readonly page: readonly EntryRecord[];
};
