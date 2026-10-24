/**
 * 组织快照：主视图需要的一切。
 *
 * 一次请求拿到整块数据，界面不需要拼多次调用。
 * 状态判定：忙（有活跃任务）/ 待办（有你该拍板的事）/ 空闲。
 */
import {
	BACKGROUND_CONTEXT,
	inspectLiveness,
	type CompanyRuntime,
	type Context,
} from "../runtime/index.ts";
import { MANAGEMENT_ROLES, ROLE_LABELS, type ManagementRole, type TrailKind } from "../company/docs.ts";
import { listPending } from "../company/escalation.ts";
import { readCompany } from "../company/org.ts";
import { rollupAll, rollupProject } from "../company/cost.ts";
import { ROLE_DEFINITIONS } from "../company/roles.ts";
import { readLiveTrail, readTrail } from "../company/trail.ts";

/** 节点状态（契约第 2 节：四态，全站统一）。 */
export type NodeStatus = "busy" | "waiting" | "error" | "idle";

/** 一个可点开的角色节点。 */
export type ActorView = {
	readonly conversationId: number;
	/** 显示名：CTO / 产品-林一。 */
	readonly label: string;
	/** 一句话职责或角色。 */
	readonly subtitle: string;
	/** 组织类型。 */
	readonly kind: "owner" | "role" | "project" | "staff";
	readonly status: NodeStatus;
	/** 该会话的 token 用量。 */
	readonly tokens: number;
	/** 等你拍板的条数。 */
	readonly awaitingYou: number;
	/** 最近在做什么（一句话）。 */
	readonly activity: string;
	/** 是否已归档（项目终止后员工会被归档）。 */
	readonly archived?: boolean;
	/** 生效模型（provider/modelId）；档案浮层与卡片提示用。 */
	readonly model?: string;
	/** 员工角色（产品 / 设计 / 开发 / 测试 / 运营）。 */
	readonly role?: string;
	/** 所属项目 slug（项目会话与员工会话有）。 */
	readonly project?: string;
	/** 上级显示名。 */
	readonly parent?: string;
	/** 故障原因（status 为 error 时给界面一句话说明）。 */
	readonly error?: string;
};

/** 项目视图。 */
export type ProjectView = {
	readonly slug: string;
	readonly name: string;
	readonly status: string;
	readonly lead: ActorView;
	readonly staff: readonly ActorView[];
	readonly tokens: number;
	/** 已终止的项目带上原因与时间。 */
	readonly terminated?: { readonly at: number; readonly by: string; readonly reason: string };
};

/** 待你拍板的一条。 */
export type PendingView = {
	readonly key: string;
	readonly question: string;
	readonly from: string;
	readonly level: string;
	readonly askedAt: number;
	/** 是否真的在等你（已经升到你这一级）。 */
	readonly forYou: boolean;
};

/**
 * 一条沟通连线（给界面画「谁在跟谁说话」）。
 *
 * 只保留最近的一段时间窗口，界面按 `at` 决定亮度；`from`/`to` 是会话标识，
 * 界面用组织图里的节点做锚点。升级链的边首尾相同，界面自己跳过。
 */
export type LinkView = {
	readonly from: number;
	readonly to: number;
	readonly kind: TrailKind;
	readonly at: number;
	/** 一行人话：陆沉 → 林越。 */
	readonly label: string;
	readonly project?: string;
};

/** 组织快照。 */
export type OrgView = {
	readonly company: { readonly name: string; readonly model: string };
	readonly ceo: ActorView;
	readonly roles: readonly ActorView[];
	readonly projects: readonly ProjectView[];
	readonly pending: readonly PendingView[];
	/** CEO 自己队列里还没拍板的问题数（不占老板的注意力，仅供参考）。 */
	readonly ceoQueue: number;
	readonly costs: {
		readonly totalTokens: number;
		readonly totalCostUsd: number;
		readonly byProject: readonly { readonly slug: string; readonly tokens: number }[];
	};
	/** 最近的沟通连线，供组织图画流动的光线。 */
	readonly links: readonly LinkView[];
};

/** 构建组织快照。 */
export async function buildOrgView(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<OrgView> {
	const state = await readCompany(runtime, context);
	const pending = await listPending(runtime, context);

	// 活跃任务 → 哪些会话在忙。
	// 用统一存活判定：僵住的 waiting（等的东西早就结束了）不算忙，否则
	// 一个卡死的会话会永远顶着绿灯——这正是这次要修的「永远正在忙」。
	const liveness = await inspectLiveness(runtime, {}, context);
	const busyIds = new Set(liveness.busyConversations);
	// 故障会话：被永久挂起（blocked，反复崩溃触到上限 / 任务定义缺失）或已经僵住。
	// 这类会话不会自己好起来，界面必须如实标红，而不是显示成「空闲」。
	const errorIds = new Set<number>();
	const errorReasons = new Map<number, string>();
	for (const task of liveness.tasks) {
		const reason = failureReasonOf(task);
		if (reason === undefined) continue;
		errorIds.add(task.conversationId);
		if (!errorReasons.has(task.conversationId)) errorReasons.set(task.conversationId, reason);
	}
	// 两组计数语义不同，不能混用：
	// - pendingByConversation：这个人身上挂着未答复的问题 → 状态「等待中」
	// - awaitingYou：**只有老板才需要拍板的**（owner 级，且按新规则记在 CEO 名下）
	//   其他角色的待办是等 CEO 拍板，不是等老板——顶个「待你 N」的徽章只会误导老板。
	const pendingByConversation = new Map<number, number>();
	const awaitingYouByConversation = new Map<number, number>();
	for (const item of pending) {
		pendingByConversation.set(
			item.fromConversationId,
			(pendingByConversation.get(item.fromConversationId) ?? 0) + 1,
		);
		if (item.level !== "owner") continue;
		awaitingYouByConversation.set(
			item.fromConversationId,
			(awaitingYouByConversation.get(item.fromConversationId) ?? 0) + 1,
		);
	}

	const statusOf = (conversationId: number): NodeStatus => {
		// 故障优先于其它两态：一个被永久挂起的会话不能显示成「空闲」或「在跑」，
		// 否则老板会以为它在干活，而实际上没有任何东西会去收尾。
		if (errorIds.has(conversationId)) return "error";
		if (busyIds.has(conversationId)) return "busy";
		if ((pendingByConversation.get(conversationId) ?? 0) > 0) return "waiting";
		return "idle";
	};

	const roleIds = state?.roles ?? {};
	const ceoId = roleIds.ceo ?? 1;

	const errorField = (conversationId: number): { readonly error?: string } => {
		const reason = errorReasons.get(conversationId);
		return reason === undefined ? {} : { error: reason };
	};

	const actor = async (
		conversationId: number,
		label: string,
		subtitle: string,
		kind: ActorView["kind"],
		archived = false,
		extra: {
			readonly model?: string;
			readonly role?: string;
			readonly project?: string;
			readonly parent?: string;
		} = {},
	): Promise<ActorView> => {
		const base: ActorView = {
			conversationId,
			label,
			subtitle,
			kind,
			status: statusOf(conversationId),
			tokens: await tokensOf(runtime, conversationId, context),
			awaitingYou: awaitingYouByConversation.get(conversationId) ?? 0,
			activity: await describeActivity(runtime, conversationId, context),
			...(extra.model === undefined ? {} : { model: extra.model }),
			...(extra.role === undefined ? {} : { role: extra.role }),
			...(extra.project === undefined ? {} : { project: extra.project }),
			...(extra.parent === undefined ? {} : { parent: extra.parent }),
			...errorField(conversationId),
		};
		return archived ? { ...base, archived: true } : base;
	};

	const defaultModel = modelOf(state?.defaultModel) ?? "?";
	const ceo = await actor(ceoId, "CEO", "唯一真人 · 主 Agent 代你调度", "owner", false, {
		model: defaultModel,
		parent: "老板",
	});

	const roles: ActorView[] = [];
	for (const role of MANAGEMENT_ROLES) {
		if (role === "ceo") continue;
		const id = roleIds[role];
		if (id === undefined) continue;
		roles.push(
			await actor(
				id,
				ROLE_LABELS[role],
				ROLE_DEFINITIONS[role as ManagementRole]?.summary ?? "",
				"role",
				false,
				{ model: defaultModel, parent: "CEO" },
			),
		);
	}

	const projects: ProjectView[] = [];
	for (const project of Object.values(state?.projects ?? {})) {
		const lead = await actor(
			project.leader,
			project.leaderName,
			`${project.name} 项目负责人`,
			"project",
			false,
			{ model: defaultModel, project: project.slug, parent: "CEO" },
		);
		// 终止后员工会被归档：仍然列出来，标成已归档，让老板看得见「曾经有谁」
		const staff: ActorView[] = [];
		for (const person of Object.values(state?.staff ?? {})) {
			if (person.project !== project.slug) continue;
			staff.push(
				await actor(person.conversationId, person.name, person.role, "staff", person.archived, {
					model: modelOf(person.model) ?? "?",
					role: person.role,
					project: person.project,
					parent: ROLE_LABELS[person.manager],
				}),
			);
		}

		const rollup = await rollupProject(runtime, project.slug, context);
		const view: ProjectView = {
			slug: project.slug,
			name: project.name,
			status: project.status,
			lead,
			staff,
			tokens: rollup.totalTokens,
			...(project.terminated === undefined ? {} : { terminated: project.terminated }),
		};
		projects.push(view);
	}

	const all = await rollupAll(runtime, context);

	// 最近的沟通连线：界面据此在节点之间画流动的光线。
	// 只取尾部一小段，避免界面拿到整个历史；具体时间窗由界面判断。
	const trail = await readTrail(runtime, {}, context);
	// 正在发生的派活/转交：TrailDoc 里要等答完才落历史边，这里补上实时边。
	const liveLinks: LinkView[] = readLiveTrail().map((edge) => ({
		from: edge.fromConversation,
		to: edge.toConversation,
		kind: edge.kind,
		at: edge.startedAt,
		label: `${edge.from} → ${edge.to}`,
		...(edge.project === undefined ? {} : { project: edge.project }),
	}));
	const links: LinkView[] = [
		...liveLinks,
		...trail.slice(-200).map((edge) => ({
			from: edge.fromConversation,
			to: edge.toConversation,
			kind: edge.kind,
			at: edge.at,
			label: `${edge.from} → ${edge.to}`,
			...(edge.project === undefined ? {} : { project: edge.project }),
		})),
	];

	return {
		company: {
			name: state?.company.name ?? "",
			model: state?.defaultModel.modelId ?? "?",
		},
		ceo,
		roles,
		projects,
		ceoQueue: pending.filter((item) => item.level === "ceo").length,
		pending: pending.map((item) => ({
			key: item.key,
			question: item.question,
			from: item.from,
			level: item.level,
			askedAt: item.askedAt,
			forYou: item.level === "owner",
		})),
		costs: {
			totalTokens: all.totalTokens,
			totalCostUsd: all.costUsd,
			byProject: projects.map((project) => ({ slug: project.slug, tokens: project.tokens })),
		},
		links,
	};
}

/** 某会话的 token 用量。 */
async function tokensOf(runtime: CompanyRuntime, conversationId: number, context: Context): Promise<number> {
	const { UsageDoc } = await import("../runtime/usage.ts");
	const state = await runtime.harness.snapshot(UsageDoc, conversationId as never, context);
	const models = (state as { models?: Record<string, { totalTokens?: number }> } | undefined)?.models ?? {};
	return Object.values(models).reduce((total, model) => total + (model.totalTokens ?? 0), 0);
}

/**
 * 这个任务是不是「已经坏了、不会自己好」。
 *
 * 两种：
 * - `blocked`：反复崩溃触到重启上限、任务定义缺失、迁移失败——没有东西会收尾
 * - `stuck`：等的东西早就结束了 / 超期，看门狗可能还在重试，但当前确实卡着
 * 都要在界面上标红，否则老板看到的是「空闲」或「在跑」。
 */
function failureReasonOf(task: {
	readonly status: string;
	readonly stuck: boolean;
	readonly reason?: string;
	readonly blockedReason?: string;
}): string | undefined {
	if (task.status === "blocked") {
		if (task.blockedReason === "restart_limit") return "反复崩溃已暂停";
		if (task.blockedReason === "migration_failed") return "任务升级失败，无法恢复";
		return `任务受阻（${task.blockedReason ?? "未知原因"}）`;
	}
	if (task.reason === "waiting-on-dead") return "等待的对象已结束，任务卡住";
	if (task.reason === "waiting-on-blocked") return "等待的对象已受阻";
	// 注意：超期（overdue）不算故障——它可能只是活很长。看门狗会去收尾，
	// 收不掉之后才是真的坏，那时任务会变成 blocked。提前标红会误伤正常的慢活。
	return undefined;
}

/** provider/modelId。 */
function modelOf(model: { readonly provider: string; readonly modelId: string } | undefined): string | undefined {
	if (model === undefined) return undefined;
	return `${model.provider}/${model.modelId}`;
}


/**
 * 一句话描述「它最近在做什么」。
 *
 * 取最近一条助手正文的首行；没有就当空闲。
 */
async function describeActivity(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context,
): Promise<string> {
	const conversation = await runtime.harness.conversation(conversationId as never, context);
	const page = await conversation?.entries({ order: "descending" }, 12, undefined, context);
	for (const entry of page?.items ?? []) {
		if (entry.kind !== "pi.assistant") continue;
		const message = entry.model?.[0] as { content?: readonly { type: string; text?: string }[] } | undefined;
		const text = (message?.content ?? [])
			.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
			.join("")
			.trim();
		if (text === "") continue;
		const firstLine = text.split("\n").find((line) => line.trim() !== "") ?? "";
		return firstLine.replace(/^#+\s*/, "").slice(0, 60);
	}
	return "";
}
