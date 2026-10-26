/**
 * 会话流：把已提交的会话状态转成界面能直接渲染的条目。
 *
 * 这是 Web UI 的唯一数据源。设计原则：
 * - 只读已提交状态（符合底层「只有已提交状态可观察」的保证）
 * - 每条条目自带类型与时间，界面不需要理解底层结构
 * - 思考、工具调用、工具输出分开呈现，让老板看得见「它在干什么」
 * - **每条消息都能回答「这是谁说的」**（契约第 3 节）：
 *   user 条目带 `from`，assistant/thinking/tool 的发言人由 `Feed.actor` 统一给出。
 */
import {
	BACKGROUND_CONTEXT,
	inspectLiveness,
	isConversationBusy,
	type CompanyRuntime,
	type Context,
} from "../runtime/index.ts";
import {
	ROLE_LABELS,
	isLeaderManagerRef,
	managerLabelOf,
	type CompanyState,
	type ManagementRole,
	type ManagerRef,
} from "../company/docs.ts";
import { readCompany } from "../company/org.ts";
import { canDisposePending, decisionOwnerOfItem, levelOfConversation, listPending } from "../company/escalation.ts";
import { ROLE_DEFINITIONS } from "../company/roles.ts";
import { actorRefOf, OWNER_REF, refOfLabel, type ActorRef } from "./actors.ts";

/** 一个发言人（契约第 3 节）。 */
export type { ActorRef } from "./actors.ts";

/** 流里的一条内容。 */
export type FeedItem =
	/** 老板或别的 agent 说的话。`from` 说明是谁说的。 */
	| {
			readonly id: number;
			readonly kind: "user";
			readonly text: string;
			readonly at: number;
			/** 谁说的：老板自己 → {label:"老板",kind:"owner"}；派活 → 派活方。 */
			readonly from: ActorRef;
	  }
	/** 角色的回复正文。发言人见 {@link Feed.actor}。 */
	| { readonly id: number; readonly kind: "assistant"; readonly text: string; readonly at: number }
	/** 思考过程（模型有 reasoning 能力时才有）。发言人见 {@link Feed.actor}。 */
	| { readonly id: number; readonly kind: "thinking"; readonly text: string; readonly at: number }
	/** 工具调用与它的结果。发言人见 {@link Feed.actor}。 */
	| {
			readonly id: number;
			readonly kind: "tool";
			readonly name: string;
			/** 参数摘要，一行。 */
			readonly args: string;
			/** 结果正文；未完成时为空。 */
			readonly output: string;
			/** running：正在执行；interrupted：中断后再也没拿到结果。 */
			readonly state: "running" | "ok" | "error" | "interrupted";
			/** 输出过长时折叠。 */
			readonly collapsible: boolean;
			/** 底层工具调用 ID，用于和实时状态对齐。 */
			readonly callId?: string;
			readonly at: number;
	  }
	/** 系统留痕（派活、回报、升级等）。`from`/`to` 说明谁对谁做。 */
	| {
			readonly id: number;
			readonly kind: "note";
			readonly text: string;
			readonly at: number;
			readonly from?: ActorRef;
			readonly to?: ActorRef;
	  }
	/** 一次运行失败或被截断。 */
	| {
			readonly id: number;
			readonly kind: "alert";
			readonly text: string;
			readonly at: number;
			/** 谁报的警（看门狗等）；没有就是系统。 */
			readonly from?: ActorRef;
	  };

/** 会话流的完整视图。 */
export type Feed = {
	readonly conversationId: number;
	readonly title: string;
	readonly role: string;
	/**
	 * 这个会话的主人：assistant / thinking / tool 的发言人。
	 *
	 * 老板通道里它是 CEO，员工会话里是那位员工——界面不用再猜。
	 */
	readonly actor: ActorRef;
	/** 已提交的条目，按时间正序。 */
	readonly items: readonly FeedItem[];
	/** 正在生成的内容（未提交的部分）。 */
	readonly streaming?: string;
	/** 正在思考的内容。 */
	readonly thinking?: string;
	/** 正在运行的工具。 */
	readonly running: readonly { readonly name: string; readonly args: string }[];
	/** 是否正在忙。 */
	readonly busy: boolean;
	/** 已提交但还在排队、尚未进入对话的消息。 */
	readonly queued: readonly {
		readonly id: number;
		readonly text: string;
		readonly mode: "steer" | "followUp";
		/** owner：老板自己发的；agent：别的 agent 派来的任务。 */
		readonly origin: "owner" | "agent";
		/** agent 来源时，是谁派来的。 */
		readonly from?: string;
	}[];
	/** 该会话的用量。 */
	readonly tokens: number;
	/** 会话种类：老板通道 / 管理层 / 项目 / 员工。 */
	readonly kind: "owner" | "role" | "project" | "staff" | "branch";
	/**
	 * 是否在等老板拍板。
	 *
	 * @deprecated ADR-026 决策 2（落地第 3 步）已把它泛化为 {@link awaitingDecision}。
	 * 保留为**派生字段**而不是删掉：现有界面（`ui/js/chat.js`）与设备数据
	 * （`ui/js/dev-fixtures.js`）还在读它，改结构不能把界面搞坏。
	 * 新代码请用 `awaitingDecision.decider === "owner"`。
	 */
	readonly awaitingOwner: boolean;
	/** 这个会话里有没有等**自己**拍板的事，以及到底该谁拍（ADR-026 决策 2）。 */
	readonly awaitingDecision: AwaitingDecision;
	/**
	 * 这个会话主人需要亲自拍的事（未答复的待决项）。
	 *
	 * 为什么放在 feed 里：界面上「待办」和「聊天」本来就是同一件事——
	 * 一条待决问题就是「有人在等你回话」。原先它在聊天面板顶部另开一块
	 * 黄框区域渲染，于是同一条问题既在顶部出现（可点）又在聊天里出现（只是文本），
	 * 用户的实际体验是「两边都有、答完没反应」。
	 * 现在只保留这个数据源，由聊天流自己渲染成一条可交互的事项（见 ui/js/chat.js）。
	 */
	readonly pending: readonly FeedPending[];
};

/**
 * 一条「等人拍板」的事项，随 feed 下发。
 *
 * 刻意带上 `options`：后端知道选项结构（处置类是结构化的，普通升级项可能从正文解析），
 * 界面不该再猜一遍；猜错就会把「1. 读文件」这种步骤当成可点的选项发出去。
 */
export type FeedPending = {
	readonly key: string;
	readonly question: string;
	/** 谁在问（显示名）。 */
	readonly from: string;
	/** 决策人（权限位）：owner / ceo / cto / leader:<slug>。 */
	readonly decisionOwner: string;
	readonly askedAt: number;
	/** 是不是处置类（暂搁 / 放弃）。 */
	readonly disposition: boolean;
	/** 结构化选项；没有就为空数组（界面自行降级成自由输入）。 */
	readonly options: readonly { readonly id: string; readonly label: string; readonly recommended: boolean }[];
	/**
	 * 当前这个会话（界面里正在看的这个人）能不能对它做「驳回 / 标记已解决」。
	 *
	 * 由后端算好下发，而不是让界面用 decisionOwner 自己比：
	 * 权限口径（canDisposePending）只该有一处定义，界面再算一遍早晚会两边不一致。
	 * 注意：这只是**显示依据**；真正的拦截在 disposePending 里（HTTP/工具都走它）。
	 */
	readonly canDispose: boolean;
	/** CEO 能否把它从老板层接管回来（只有 CEO + owner 级条目为 true）。 */
	readonly canTakeOver: boolean;
	/** 来源说明（Defect B 要求 4）：谁声明了什么类别、是否经 CEO 复核。 */
	readonly trace?: { readonly declaredTopic?: string; readonly ceoReviewed?: boolean; readonly note: string };
};

/**
 * 「有东西在等决策」的结构化描述。
 *
 * ADR-026 决策 2 的推论：老板待办里应该只剩「立项 / 砍项目 / 超预算 / 对外」。
 * 要把这句话变成可验证的事，界面就不能只知道「是不是等老板」，
 * 还必须知道「这条到底该谁拍」——否则一个本该 CTO 拍的架构问题
	 * 会以「等老板」的样子出现在老板的面板上。
 */
export type AwaitingDecision = {
	/** 有没有未答复的待决项指向这个会话的主人。 */
	readonly pending: boolean;
	/**
	 * 决策人类型。`none` = 没东西等；`owner` = 真该老板；
	 * `role` / `project` = 该管理层 / 项目负责人（不该骚扰老板）。
	 */
	readonly decider: "none" | "owner" | "role" | "project";
	/** 决策人的显示名（「老板」「CTO」「许砚舟」）；`none` 时为空串。 */
	readonly label: string;
	/** 等这个人拍的未决条数。 */
	readonly count: number;
};

/** 读取一条会话的完整流。 */
export async function readFeed(
	runtime: CompanyRuntime,
	conversationId: number,
	options: { readonly limit?: number; readonly state?: CompanyState; readonly before?: number } = {},
	context: Context = BACKGROUND_CONTEXT,
): Promise<Feed | undefined> {
	const conversation = await runtime.harness.conversation(conversationId as never, context);
	if (conversation === undefined) return undefined;

	// 组织索引：用来把「派活方」「留痕双方」解析成人，一次读，feed 与档案共用
	const state = options.state ?? (await readCompany(runtime, context));

	const limit = options.limit ?? 400;
	// **必须取最新的一页**：`entries({order:"ascending"}, limit)` 返回的是最旧 limit 条，
	// 会话历史一旦超过 limit（真实公司跑几轮就会超），新消息与新回复就永远进不了 feed，
	// 界面表现为「消息发出去了，但回复一直不显示」，而且还会把旧的 400 条反复重放。
	// 先按 descending 取最新的 limit 条，再翻回时间正序交给 buildItems（它按顺序合并工具调用）。
	//
	// `before`：可选游标（entry id，语义「严格早于」）。给它是为了支持**往前翻历史**
	// （UX-7 的「往上翻逐步加载」）。不给时行为与以前完全一致。
	//
	// ── 关键：`before` 必须交给**底层查询**（`maxEntryId`），不能在内存里过滤 ──
	//
	// 真实故障（会话 89，1036 条 entries）：
	// 原实现先取「全库最新 N 条」再在内存里按 `id < before` 过滤。
	// 翻到后段时 `before` 很小，而「最新 N 条」里 `id < before` 的所剩无几
	// （实测 cursor=3000 时 800 条里只有 221 条命中），
	// 调用方据此判「返回条数 < 请求条数 ⇒ 到头」，**于是静默丢掉剩下的历史**（实测丢 236 条）。
	//
	// `EntryQuery` 支持 `maxEntryId`（`@earendil-works/pi-durable` 的 `types.d.ts:708`：
	// 「Newest entry ID that may be returned」），所以直接把 `before` 下推给底层，
	// 让它直接扫「id < before」的那一段，内存里不必再过滤。
	const before = options.before;
	const query =
		before === undefined
			? { order: "descending" as const }
			: { order: "descending" as const, maxEntryId: before - 1 };
	const page = await conversation.entries(query as never, limit, undefined, context);
	// 底层 `maxEntryId` 是**闭区间**（inclusive），所以传 `before - 1` 才是「严格早于」。
	// 这里再挡一次 `>= before`，防止不同后端对边界的解释不一致。
	const raw = before === undefined ? page.items : page.items.filter((entry) => entry.id < before);
	const entries = [...raw].reverse();

	// 已提交的工具调用：用来给实时卡片补参数、判断哪些调用真的拿到了结果
	const committed = collectCommittedTools(entries);
	const items = buildItems(entries, state);

	// 实时状态：正在生成、正在思考、正在跑的工具
	const view = await conversation.watch(context);
	const live = view.value.docs["pi.live"] as LiveShape | undefined;
	await view.stop();

	const streaming = collectLiveText(live, "text");
	const thinking = collectLiveText(live, "thinking");

	// pi.live 只存 callId / name / taskId / status，不存参数。
	// 已经提交过的调用交给 buildItems 的卡片展示，避免同一调用出现两张卡片；
	// 其余实时调用从已提交的 assistant 工具参数里回填，不再显示「（无参数）」。
	// pi.live 的 tools 以内部键索引，优先用值里的 callId 对齐已提交调用
	const liveEntries = Object.entries(live?.tools ?? {}).map(
		([key, tool]) => [tool.callId ?? key, tool] as const,
	);
	const liveCallIds = new Set(liveEntries.map(([callId]) => callId));
	const running = liveEntries
		.filter(([callId]) => !committed.has(callId))
		.map(([callId, tool]) => ({
			name: tool.name ?? callId,
			args: summarize(tool.args ?? tool.details ?? committed.get(callId)?.arguments ?? ""),
		}));

	// 是否真的在忙：不能只看有没有流式文本——模型思考阶段没有正文，
	// 但确实在跑。以存活判定为准（僵住的 waiting 不算忙，见契约 §5.3），
	// 再用流式内容兜底。
	const liveness = await inspectLiveness(runtime, {}, context);
	const hasLiveTask = isConversationBusy(liveness, conversationId);

	// 中断过的工具调用：assistant 里提交了 toolCall，但永远没有 tool-result，
	// 也没有实时工具在跑。以前它会永远显示「运行中 / 等待输出…」。
	if (!hasLiveTask && running.length === 0) {
		for (let index = 0; index < items.length; index += 1) {
			const item = items[index];
			if (item?.kind !== "tool" || item.state !== "running" || item.callId === undefined) continue;
			if (liveCallIds.has(item.callId)) continue;
			if (committed.get(item.callId)?.hasResult === true) continue;
			items[index] = {
				...item,
				state: "interrupted",
				output: "（已中断：这次工具调用没有返回结果）",
			};
		}
	}

	// 排队的消息：已经提交但还没进入对话。
	// 不显示的话，老板会以为「消息没发出去」——它其实在等当前这轮结束。
	const inbox = await runtime.harness.snapshot(await inboxToken(), conversationId as never, context);
	const queued = (inbox?.items ?? []).flatMap((item) => {
		if (item.mode === "write") return [];
		const text = inboxText(item.content);
		if (text === "") return [];
		// 别的 agent 派来的任务会带 app.delegate 标记；老板自己发的没有 entry。
		// 不区分的话，员工会话里的派活会显示成「你的排队消息 / 立即处理」。
		const entry = item.entry as
			| { readonly kind?: string; readonly data?: { readonly from?: string } }
			| undefined;
		const delegated = entry?.kind === "app.delegate";
		return [
			{
				id: Number(item.id),
				text,
				mode: item.mode,
				origin: delegated ? ("agent" as const) : ("owner" as const),
				...(delegated ? { from: entry?.data?.from ?? "协作方" } : {}),
			},
		];
	});

	const usage = await runtime.harness.snapshot(await usageToken(), conversationId as never, context);
	const tokens = Object.values((usage as { models?: Record<string, { totalTokens?: number }> } | undefined)?.models ?? {}).reduce(
		(total, model) => total + (model.totalTokens ?? 0),
		0,
	);

	return {
		conversationId,
		title: "",
		role: "",
		// 先按组织索引给一个发言人；decorateFeed 会按会话种类再校正一次
		actor: actorRefOf(state, conversationId) ?? { label: "", kind: "system" },
		items,
		...(streaming === "" ? {} : { streaming }),
		...(thinking === "" ? {} : { thinking }),
		running,
		queued,
		busy: hasLiveTask || streaming !== "" || thinking !== "" || running.length > 0,
		tokens,
		kind: "branch",
		awaitingOwner: false,
		awaitingDecision: { pending: false, decider: "none", label: "", count: 0 },
		// 由 decorateFeed 填（它才读 PendingDoc）
		pending: [],
	};
}

/**
 * 给 feed 补上标题、角色、种类、发言人、待拍板状态。
 *
 * 从 http.ts 移到 feed.ts：发言人（`actor`）与条目里的 `from`/`to` 必须用
 * 同一套口径解析，分在两个文件里早晚会不一致。
 */
export async function decorateFeed(
	runtime: CompanyRuntime,
	feed: Feed,
	context: Context = BACKGROUND_CONTEXT,
): Promise<Feed> {
	const state = await readCompany(runtime, context);
	const pending = await listPending(runtime, context);
	// 只有 owner 级的问题才是「等老板拍板」；CEO 自己队列里的问题不算。
	//
	// 处置待办（item.disposition !== undefined）**不计入** awaitingOwner：
	// 它归「被打断工作的下达人」，不是「等老板拍板」。
	// 靠 `level` 字符串猜会把它和项目终止确认混在一条布尔里（审计 D-02(d)），
	// 所以显式排除。
	// ── 待决策项（ADR-026 决策 2 / 6）──
	//
	// 一条待决项算在哪个会话头上，看的是**决策人**，不是 `level`：
	// `level` 是「升级链停在哪一级」，升一级就变；`decisionOwner` 才是「结构上该谁拍」。
	//
	// 处置待办（item.disposition !== undefined）仍不计入：它归「被打断工作的下达人」，
	// 不是「等这条会话的主人拍板」（审计 D-02(d) 的结论，保留）。
	const myLevel = levelOfConversation(state, feed.conversationId);
	// `mine`（等这个人拍的全部）含处置类：处置也是「有人在等你回话」，
	// 界面上要和普通拍板一样出现在聊天里。`awaitingDecision.count` 只统计
	// 非处置项（处置是「被打断工作的下达人」的事，不该计进「等拍板」的角标），
	// 但 feed.pending 要全给，否则处置待办在聊天里就彻底没有入口了。
	const allMine = pending.filter(
		(item) =>
			myLevel !== undefined &&
			// 自己的待办
			(decisionOwnerOfItem(item) === myLevel ||
				// 缺陷 B：CEO 还要能看到**老板级**待办，否则「接管」这个动作在
				// CEO 的界面上根本没有入口（它 decisionOwner 是 owner，不会进 CEO 队列）。
				// 只给 CEO，且只给 owner 级；其他层级看不到别人的活。
				(myLevel === "ceo" && item.level === "owner")),
	);
	// 注意：`mine` 决定 `awaitingDecision.count`（角标）。
	// 老板级条目是「给 CEO 看的接管入口」，**不算** CEO 自己的待拍板数——
	// 否则 CEO 会以为自己有活没干，其实那是在等老板。
	const mine = allMine.filter(
		(item) => item.disposition === undefined && decisionOwnerOfItem(item) === myLevel,
	);

	const decider: AwaitingDecision["decider"] =
		mine.length === 0
			? "none"
			: myLevel === "owner"
				? "owner"
				: myLevel !== undefined && isLeaderManagerRef(myLevel)
					? "project"
					: "role";
	const deciderLabel =
		decider === "none"
			? ""
			: decider === "owner"
				? "老板"
				: managerLabelOf(state, myLevel as ManagerRef);

	const awaitingDecision: AwaitingDecision = {
		pending: mine.length > 0,
		decider,
		label: deciderLabel === undefined ? "" : deciderLabel,
		count: mine.length,
	};

	// 兼容字段：界面现在只关心「是不是等老板」。
	// **不是** `awaitingDecision.pending` —— 这里必须收窄到 owner，否则界面又会
	// 把「等 CTO 拍」渲染成「等老板」。`decider === "owner"` 已经蕴含
	// `myLevel === "owner" && mine.length > 0`（mine 全部 decisionOwner === myLevel）。
	const awaitingOwner = decider === "owner";

	let title = "会话";
	let kind: Feed["kind"] = "branch";
	let role = "";
	let actor: ActorRef = { label: "", kind: "system" };

	const roleEntry = Object.entries(state?.roles ?? {}).find(([, id]) => id === feed.conversationId);
	if (roleEntry !== undefined) {
		const roleKey = roleEntry[0] as ManagementRole;
		title = ROLE_LABELS[roleKey] ?? roleKey.toUpperCase();
		kind = roleKey === "ceo" ? "owner" : "role";
		role =
			roleKey === "ceo"
				? "唯一真人 · 直接向你汇报"
				: `${ROLE_DEFINITIONS[roleKey]?.summary ?? ""} · 向 CEO 汇报`;
		// CEO 通道的助手是 CEO；其他岗位就是它自己
		actor = { conversationId: feed.conversationId, label: title, kind: roleKey === "ceo" ? "owner" : "role" };
	}

	for (const project of Object.values(state?.projects ?? {})) {
		if (project.leader === feed.conversationId) {
			title = project.name;
			kind = "project";
			role = "项目负责人";
			actor = {
				conversationId: feed.conversationId,
				label: project.leaderName ?? project.name,
				kind: "project",
			};
		}
	}
	for (const staff of Object.values(state?.staff ?? {})) {
		if (staff.conversationId === feed.conversationId) {
			title = staff.name;
			kind = "staff";
			role = `${staff.role} · ${staff.project} 项目 · 向 ${managerLabelOf(state, staff.manager)} 汇报`;
			actor = { conversationId: feed.conversationId, label: staff.name, kind: "staff" };
		}
	}

	// 待办随 feed 下发：界面在聊天流里渲染成可交互事项，不再另开顶部区域。
	const pendingView: readonly FeedPending[] = allMine.map((item) => ({
		key: item.key,
		question: item.question,
		from: item.from,
		decisionOwner: decisionOwnerOfItem(item),
		askedAt: item.askedAt,
		disposition: item.disposition !== undefined,
		options: (item.disposition?.options ?? []).map((option) => ({
			id: option.id,
			label: option.label,
			recommended: option.recommended === true,
		})),
		canDispose: canDisposePending(item, myLevel),
		canTakeOver: myLevel === "ceo" && item.level === "owner" && item.answer === undefined && item.disposed === undefined,
		...(item.trace === undefined ? {} : { trace: item.trace }),
	}));

	return { ...feed, title, kind, role, actor, awaitingOwner, awaitingDecision, pending: pendingView };
}

/** 底层 pi.live 的结构（只声明用到的字段）。 */
type LiveShape = {
	readonly generation?: {
		readonly partial?: { readonly content?: readonly { readonly type: string; readonly text?: string; readonly thinking?: string }[] };
	};
	readonly tools?: Record<
		string,
		{
			readonly name?: string;
			readonly callId?: string;
			readonly status?: string;
			readonly args?: unknown;
			readonly details?: unknown;
		}
	>;
};

/** 已提交的工具调用：参数 + 是否已有结果。 */
type CommittedTool = {
	readonly arguments: unknown;
	readonly hasResult: boolean;
};

/** 扫描已提交条目，整理出 callId → 工具调用信息。 */
function collectCommittedTools(
	entries: readonly {
		readonly kind: string;
		readonly model?: readonly unknown[];
	}[],
): Map<string, CommittedTool> {
	const calls = new Map<string, { arguments: unknown; hasResult: boolean }>();

	for (const entry of entries) {
		if (entry.kind === "pi.assistant") {
			const message = entry.model?.[0] as
				| { readonly content?: readonly { readonly type: string; readonly id?: string; readonly arguments?: unknown }[] }
				| undefined;
			for (const part of message?.content ?? []) {
				if (part.type !== "toolCall" || part.id === undefined) continue;
				calls.set(part.id, { arguments: part.arguments, hasResult: false });
			}
		} else if (entry.kind === "pi.tool-result") {
			const message = entry.model?.[0] as { readonly toolCallId?: string } | undefined;
			const existing = message?.toolCallId === undefined ? undefined : calls.get(message.toolCallId);
			if (existing !== undefined) existing.hasResult = true;
		}
	}

	return calls;
}

/** 从实时生成里取某类文本。 */
function collectLiveText(live: LiveShape | undefined, type: "text" | "thinking"): string {
	const parts = live?.generation?.partial?.content ?? [];
	return parts
		.flatMap((part) => {
			if (part.type !== type) return [];
			const value = type === "text" ? part.text : part.thinking;
			return value === undefined ? [] : [value];
		})
		.join("");
}

/** 把底层条目转成界面条目。 */
function buildItems(
	entries: readonly {
		readonly id: number;
		readonly kind: string;
		readonly model?: readonly unknown[];
		readonly data?: unknown;
	}[],
	state: CompanyState | undefined,
): FeedItem[] {
	const items: FeedItem[] = [];
	// 工具调用先记下来，等它的结果到了再合并成一条
	const pendingTools = new Map<string, number>();

	for (const entry of entries) {
		switch (entry.kind) {
			case "pi.user": {
				const message = entry.model?.[0] as { content?: unknown; timestamp?: number } | undefined;
				const text = typeof message?.content === "string" ? message.content : extractText(message?.content);
				// pi.user 没有来源标记：走 HTTP 进来的只有老板（agent 派活会写成 app.delegate 条目）
				items.push({ id: entry.id, kind: "user", text, at: message?.timestamp ?? 0, from: OWNER_REF });
				break;
			}
			case "pi.assistant": {
				const message = entry.model?.[0] as
					| {
							readonly content?: readonly {
								readonly type: string;
								readonly text?: string;
								readonly thinking?: string;
								readonly name?: string;
								readonly id?: string;
								readonly arguments?: unknown;
							}[];
							readonly timestamp?: number;
							readonly stopReason?: string;
					  }
					| undefined;
				const at = message?.timestamp ?? 0;

				for (const part of message?.content ?? []) {
					if (part.type === "thinking" && part.thinking !== undefined && part.thinking !== "") {
						items.push({ id: entry.id, kind: "thinking", text: part.thinking, at });
					} else if (part.type === "text" && part.text !== undefined && part.text !== "") {
						items.push({ id: entry.id, kind: "assistant", text: part.text, at });
					} else if (part.type === "toolCall" && part.name !== undefined) {
						const index = items.length;
						items.push({
							id: entry.id,
							kind: "tool",
							name: part.name,
							args: summarize(part.arguments),
							output: "",
							state: "running",
							collapsible: false,
							...(part.id === undefined ? {} : { callId: part.id }),
							at,
						});
						if (part.id !== undefined) pendingTools.set(part.id, index);
					}
				}

				// 输出被截断或出错时给出显式提示，避免「看起来做完了其实没有」
				if (message?.stopReason === "length") {
					items.push({ id: entry.id, kind: "alert", text: "输出达到长度上限被截断，这一轮可能没做完", at });
				} else if (message?.stopReason === "error") {
					items.push({ id: entry.id, kind: "alert", text: "模型调用出错", at });
				} else if (message?.stopReason === "aborted") {
					items.push({ id: entry.id, kind: "alert", text: "已停止", at });
				}
				break;
			}
			case "pi.tool-result": {
				const message = entry.model?.[0] as
					| {
							readonly content?: unknown;
							readonly toolName?: string;
							readonly toolCallId?: string;
							readonly isError?: boolean;
							readonly timestamp?: number;
					  }
					| undefined;
				const text = extractText(message?.content);
				const index = message?.toolCallId === undefined ? undefined : pendingTools.get(message.toolCallId);
				const target = index === undefined ? undefined : items[index];

				if (target !== undefined && target.kind === "tool") {
					// 合并到已有的工具条目上
					items[index as number] = {
						...target,
						output: text,
						state: message?.isError === true ? "error" : "ok",
						collapsible: text.length > 240 || text.split("\n").length > 6,
					};
				} else {
					items.push({
						id: entry.id,
						kind: "tool",
						name: message?.toolName ?? "工具",
						args: "",
						output: text,
						state: message?.isError === true ? "error" : "ok",
						collapsible: text.length > 240,
						at: message?.timestamp ?? 0,
					});
				}
				break;
			}
			case "pi.reset":
				items.push({ id: entry.id, kind: "note", text: "对话上下文已重置", at: 0 });
				break;
			case "pi.compaction":
				items.push({ id: entry.id, kind: "note", text: "较早的对话已被压缩以节省上下文", at: 0 });
				break;
			// 拍板结果（decision-delivery.ts）：某人回答了某条待决问题。
			//
			// 必须在会话流里**看得见**：原先答复只写 PendingDoc / AuditDoc，
			// 两者都不进 feed，于是拍板的人以为没生效、被拍板的人永远等不到
			// （用户报的「回复完没反应，还得再在聊天里发一遍」就是这个）。
			// 渲染成 note 而不是 alert：它是正常业务留痕，不是故障告警。
			case "app.decision": {
				const data = entry.data as
					| {
							readonly from?: string;
							readonly text?: string;
							readonly question?: string;
							readonly label?: string;
					  }
					| undefined;
				const body = (data?.text ?? "").trim();
				if (body === "") break;
				const who = data?.from === undefined ? undefined : refOfLabel(state, data.from);
				const kindLabel = data?.label ?? "拍板结果";
				const question = (data?.question ?? "").trim();
				items.push({
					id: entry.id,
					kind: "note",
					text: `${kindLabel}：${body}${question === "" ? "" : `\n（针对：${question}）`}`,
					at: 0,
					...(who === undefined ? {} : { from: who }),
				});
				break;
			}
			// 受理回执（ADR-026 决策 7.1）：这条是**系统**写的「已收到」，不是用户消息。
			//
			// 原先它落进 default 分支被渲染成一条 note，且 `text` 就是原消息全文，
			// 于是老板每发一条消息，聊天里都会出现两遍一样的内容（回执 1 遍 + 真实 user 1 遍）。
			// 这里显式收窄成一条短提示：回执要看得见，但绝不重复正文。
			case "app.receipt": {
				const data = entry.data as { readonly timing?: string } | undefined;
				const timing =
					data?.timing === "step" ? "本轮工具结束后处理" : data?.timing === "turn" ? "本轮结束后处理" : "正在切换";
				items.push({ id: entry.id, kind: "note", text: `已收到 · ${timing}`, at: 0 });
				break;
			}
			// 看门狗写的告警（backend-core）：会话内 app.alert 条目
			case "app.alert": {
				const data = entry.data as
					| { readonly text?: string; readonly message?: string; readonly from?: string }
					| undefined;
				const body = (data?.text ?? data?.message ?? "").trim();
				if (body === "") break;
				items.push({
					id: entry.id,
					kind: "alert",
					text: data?.from === undefined ? body : `${data.from}：${body}`,
					at: 0,
					...(data?.from === undefined ? {} : { from: refOfLabel(state, data.from) }),
				});
				break;
			}
			default: {
				// 自定义条目：沟通留痕（派活 / 回报 / 升级 / 决定）
				const data = entry.data as
					| { readonly from?: string; readonly to?: string; readonly kind?: string; readonly text?: string }
					| undefined;
				if (data !== undefined && typeof data === "object" && data.from !== undefined) {
					const verb = verbOf(entry.kind, data.kind);
					const from = refOfLabel(state, data.from);
					const to = data.to === undefined ? undefined : refOfLabel(state, data.to);
					// from/to 已经由界面渲染成 chip，正文里不再重复「谁 → 谁」
					const body = data.text ?? "";
					items.push({
						id: entry.id,
						kind: "note",
						text: body === "" ? verb : verb === "" ? body : `${verb}：${body}`,
						at: 0,
						from,
						...(to === undefined ? {} : { to }),
					});
				}
				break;
			}
		}
	}

	return items;
}

/** 留痕动词：条目种类优先，其次是 data.kind。 */
function verbOf(entryKind: string, dataKind: string | undefined): string {
	const kind = dataKind ?? entryKind;
	if (kind === "app.delegate" || kind === "delegate") return "派活";
	if (kind === "report") return "回报";
	if (kind === "escalate") return "升级";
	if (kind === "decide") return "决定";
	if (kind === "hire") return "招聘";
	if (kind === "archive") return "归档";
	return "";
}

/** 从内容块抽文本。 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const record = part as { readonly type?: string; readonly text?: string };
			return record.type === "text" && record.text !== undefined ? [record.text] : [];
		})
		.join("");
}

/** 把参数压成一行摘要。 */
function summarize(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value.replace(/\s+/g, " ").slice(0, 160);

	try {
		const json = JSON.stringify(value);
		if (json === undefined) return "";
		return json.replace(/\s+/g, " ").slice(0, 160);
	} catch {
		return String(value).slice(0, 160);
	}
}

/** 从排队项的内容里取文本。 */
function inboxText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.flatMap((part) => {
				if (typeof part === "string") return [part];
				if (typeof part !== "object" || part === null) return [];
				const record = part as { readonly type?: string; readonly text?: string };
				return record.type === "text" && record.text !== undefined ? [record.text] : [];
			})
			.join("");
	}
	if (typeof content === "object" && content !== null) {
		const record = content as { readonly text?: string };
		return record.text ?? "";
	}
	return "";
}

/** 延迟取队列文档 token，避免顶层循环依赖。 */
async function inboxToken() {
	const { InboxDoc } = await import("../runtime/inbox.ts");
	return InboxDoc;
}

/** 延迟取用量文档 token，避免顶层循环依赖。 */
async function usageToken() {
	const { UsageDoc } = await import("../runtime/usage.ts");
	return UsageDoc;
}
