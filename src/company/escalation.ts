/**
 * 升级链：直属管理层 → CEO → 老板。
 *
 * 架构（design.md 决策 4）：
 * - 升级是一个**持久化任务**，每个层级一个阶段。
 * - 每级跃迁提交检查点，记录当前层级 → 崩溃重开从当前级继续，不重复询问。
 * - 问询不是同步阻塞：任务把问题写进「待决问题」文档，然后休眠；
 *   角色通过工具答复（写答复），任务醒来读答复推进。
 * - 等待老板同样用休眠 → 不占执行名额、可跨天。
 * - 全程写审计与沟通留痕 → 可重建完整路径。
 *
 * 实现要点：任务阶段需要访问公司运行时（读待决文档、找角色会话），
 * 所以用**工厂函数**创建任务定义，把运行时闭包进去。这是唯一能让
 * 任务代码与业务数据解耦又不污染全局状态的方式。
 */
import {
	BACKGROUND_CONTEXT,
	type Context,
	defineDoc,
	defineTask,
	type CompanyRuntime,
} from "../runtime/index.ts";
import type { Task } from "../runtime/index.ts";
import { type DecisionTopic, decideOwner, levelOfTarget } from "../domain/routing.ts";
import { nextLevelUp } from "../domain/membership.ts";
import { buildOrg } from "./org-model.ts";
import type { DispositionPayload } from "./disposition.ts";
import { deliverDecision } from "./channels.ts";
import {
	AuditDoc,
	CompanyDoc,
	type CompanyState,
	LEADER_REF_PREFIX,
	ROLE_LABELS,
	TrailDoc,
	isLeaderManagerRef,
	leaderSlugOf,
	managerLabelOf,
	type ManagerRef,
	type ManagementRole,
} from "./docs.ts";

/** 升级流程的输入。 */
export type EscalationInput = {
	readonly question: string;
	readonly from: string;
	readonly fromConversationId: number;
	/**
	 * 直属上级：管理层岗位（cto/...）或项目负责人（leader:<slug>）。
	 * 不传则从 CEO 开始（管理层与负责人本来就直接向 CEO 汇报）。
	 */
	readonly manager?: ManagerRef;
	readonly project?: string;
	/** 升级标识，用于关联审计与留痕。 */
	readonly escalationKey: string;
	/**
	 * 直接从「问老板」开始（跳过管理层与 CEO 两级）。
	 *
	 * **只允许 CEO 发起时置为 true**：只有 CEO 能把问题递到老板面前。
	 * 其他人的上报永远不会因为它而直达老板（`startEscalation` 会把它降级成
	 * 先问 CEO 复核，见 Defect B 的修法）。
	 */
	readonly startAtOwner?: boolean;
	/**
	 * 事项类别（ADR-026 决策 2 的权限矩阵，落地第 3 步）。
	 *
	 * 不传时按 `unclassified` 处理（沿汇报线上行），**不会**因此获得额外授权。
	 * 发起方能用它声明「这是本项目的排期问题」之类，从而让问题停在该拍的人那里。
	 */
	readonly topic?: DecisionTopic;
};

/**
 * 阶段状态。
 *
 * 只有**一个**阶段：`ask`。它回答的问题只有一个——「现在停在谁那儿」。
 *
 * 以前是三个阶段（`ask-manager` / `ask-ceo` / `ask-owner`），三份处理函数逐行
 * 相同：算 askedAt → `ensurePending` → `readOutcome` → 没有答案就 sleep 后重来 →
 * 有答案就「继续往上」或「收口」。差别只有「上一级算谁」和「path 里追加什么」，
 * 而这两件事本来就该由 `nextLevelUp()` 与 `level` 自己决定，不需要三个函数各写一遍。
 *
 * 合并之后「谁能到老板那儿」这条硬规则只剩一处可读：`nextLevelUp(org, level)`
 * 只有对 `level === "ceo"` 才返回 `"owner"`（ADR-033）。
 */
export type EscalationState = {
	readonly phase: "ask";
	/** 现在停在谁那儿：`ceo` / `owner` / 管理岗（`cto`…）/ `leader:<slug>`。 */
	readonly level: string;
	/** 这一级第一次被问到的时刻；0 表示「本轮刚进来，还没问过」。 */
	readonly askedAt: number;
	/** 已经真实问过、并且明确说了「拍不了」的那些层级，按顺序。 */
	readonly path: string[];
	/**
	 * 这一站是**公司级复核**（不是普通的「下级报上来」）。
	 *
	 * 上报方声明了 `company-level`，但声明是自证的，不能据此直接给老板，
	 * 所以先停 CEO 复核：确认 → 递老板；不确认 → CEO 自己答掉。
	 * 只用于待办条目的提示语与追溯，流转规则与非复核站完全一样。
	 */
	readonly review?: boolean;
};

/** 升级结果。 */
export type EscalationResult = {
	readonly decidedBy: string;
	readonly decision: string;
	readonly path: string[];
};

/** 待决问题项。 */
export type PendingItem = {
	readonly key: string;
	readonly question: string;
	readonly level: string;
	readonly from: string;
	readonly fromConversationId: number;
	project?: string;
	readonly askedAt: number;
	/**
	 * 这条问题该由谁拍（ADR-026 决策 2 / 6，落地第 3 步）。
	 *
	 * 取值与 `level` 同一口径：`owner` / 管理层岗位名 / `leader:<slug>`。
	 * 为什么和 `level` 分开存：`level` 是「这条待决项在升级链上停在哪一级」，
	 * `decisionOwner` 是「结构上该谁拍」。两者大多数时候相等，但升级链升一级后
	 * `level` 会变、`decisionOwner` 不变——保留它才能事后回答，
	 * 「这个问题原本该谁拍、为什么最后到了老板那儿」。
	 *
	 * 旧数据没有这个字段：读取时用 {@link decisionOwnerOfItem} 回退到 `level`。
	 */
	decisionOwner?: string;
	/** 已给出的答复；未答复时不存在。 */
	answer?: string;
	/** 答复者。 */
	answeredBy?: string;
	/** 表示「我也拍不了，继续往上」。 */
	escalate?: boolean;
	/**
	 * 处置结果（驳回 / 标记已解决）。
	 *
	 * 与 `answer` 的区别：`answer` 是「给出决定，工作继续往前走」，处置是「这条待办到此为止」。
	 * 两者语义相反且互斥：一条待办要么被答复、要么被处置。
	 *
	 * 旧数据没有这个字段：读到时就是 `undefined`（未处置），**无需迁移**。
	 * 所有判定务必用 `item.disposed === undefined` 而不是 truthiness——
	 * 未来若加了「处置中」之类的新状态，`if (!item.disposed)` 依旧成立。
	 */
	disposed?: PendingDisposal;
	/**
	 * 被 CEO 从老板层接管回来的记录（Defect B 要求 3）。
	 *
	 * 只在该条曾经是 owner 级、且被 CEO 拉回 ceo 级时存在。
	 * 旧数据没有这个字段：读到时就是 `undefined`。
	 */
	takenOver?: {
		readonly by: string;
		readonly at: number;
		readonly reason: string;
		/** 接管前停在哪一级（目前恒为 owner）。 */
		readonly fromLevel: string;
	};
	/**
	 * 这条待办「为什么该由这一级拍」的说明（Defect B 要求 4「来源可追溯」）。
	 *
	 * `company-level` 直落老板时最有价值：写清「上报方声明公司级 → 该声明为自证，
	 * 已由 CEO 复核确认」。界面直接展示，不必再猜。
	 * 旧数据没有这个字段。
	 */
	trace?: {
		/** 上报方声明的类别（company-level / project / domain / unclassified）。 */
		readonly declaredTopic?: string;
		/** 是否经过 CEO 复核（company-level 才有意义）。 */
		readonly ceoReviewed?: boolean;
		/** 人类可读的判定说明。 */
		readonly note: string;
	};
	/**
	 * **真实提问方**的会话（原始发起人）。
	 *
	 * 为什么和 `fromConversationId` 分开存：owner 级待办一律记在 CEO 名下
	 * （老板只看得到 CEO 报上来的问题），`fromConversationId` 因此被改写成 CEO。
	 * 但「拍板结果该投递给谁」的答案是**当初提问的那个人**，不是 CEO——
	 * 两者混用就会出现「老板拍完板，CTO 那边毫无反应，得手动再问一遍」。
	 *
	 * 旧数据没有这个字段：投递时回退到 `fromConversationId`（至少 CEO 能看到）。
	 */
	originConversationId?: number;
	/**
	 * 处置待办的附加载荷（ADR-026 落地第二步）。
	 *
	 * 普通升级项没有这个字段；只有「被打断工作的处置」会带。
	 * 用可选内联对象而不是独立文档：它必须和待决项同生同灭，
	 * 拆成两份文档就会出现「待办已答、载荷还在」的不一致。
	 */
	disposition?: DispositionPayload;
};

/**
 * 待办的处置结果。
 *
 * 为什么不用 `answer: ""` 或删掉条目来「关闭待办」：
 * - 删条目会丢掉「曾经有过这个问题、是谁关的、为什么」——而那正是审计要的；
 * - 用空 `answer` 会让 `readOutcome()` 把空字符串当成一句答复，升级链会把空决定交付给提问方；
 * - 显式状态而不是布尔位：以后若要加「已失效」「重开」，这里加一个取值即可。
 */
export type PendingDisposal = {
	/** `rejected` = 驳回（不认可/不需要），`resolved` = 标记已解决。 */
	readonly status: "rejected" | "resolved";
	/** 处置人（与 `answeredBy` 同口径：`owner` / 岗位名 / `leader:<slug>`）。 */
	readonly disposedBy: string;
	/** 处置时间（毫秒时间戳）。 */
	readonly disposedAt: number;
	/** 理由 / 备注，可为空字符串（「标记已解决」允许不写理由）。 */
	readonly reason: string;
};

/** 处置类型。 */
export type DisposalKind = PendingDisposal["status"];

/** 待决问题文档（公司级）。任务与角色之间的唯一通道。 */
export type PendingState = {
	items: PendingItem[];
};

export const PendingDoc = defineDoc<PendingState>({
	kind: "app.pending",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
	// 待办只增（处置后仍保留以便追溯）：每 256 条压一次基线。
	checkpointWhen: (value) => value.items.length >= 256,
});

/**
 * 轮询间隔（毫秒）。
 *
 * 升级任务不是同步阻塞，而是「睡一会儿、醒来看看有没有答复」。
 * 200ms 是为了让**人在界面里拍板**之后几乎立刻有反应——老板的感知上限是「一眨眼」。
 */
export const POLL_MS = 200;

/**
 * 退避后的轮询间隔（毫秒）。
 *
 * 为什么需要退避：等老板拍板可能跨天（规格明确要求「不占执行名额、可跨天」）。
 * 如果一直 200ms 轮询，一天就是 43 万次唤醒，每次都要读文档、判断、再睡回去——
 * 白白占着 CPU，还让运行时永远「有活可干」，进程没法真正安静下来。
 *
 * 30 秒的理由：老板真回来了，最多等 30 秒就有反应，比 200ms 差得远但可以接受；
 * 而唤醒次数降到原来的 1/150。等 CEO 的层级同理——它是人（模型）在另一轮里回答，
 * 一分钟内给答复是常态，超过一分钟就是「不在当前这一轮里」，慢轮询足够。
 */
export const SLOW_POLL_MS = 30_000;

/**
 * 快轮询窗口（毫秒）：提问后的头一分钟用 {@link POLL_MS}，之后降到 {@link SLOW_POLL_MS}。
 *
 * 一分钟的理由：模型一轮生成通常在 10–60 秒内完成，同层级管理层的答复几乎总在这个窗口里。
 * 窗口内用快轮询能保证「答复一落盘，任务立刻继续」；窗口外用慢轮询省资源。
 */
export const FAST_POLL_WINDOW_MS = 60_000;

/**
 * 计算下一次轮询该睡多久。
 *
 * 纯函数，便于测试与解释：等得越久，问得越稀。
 */
export function pollDelay(askedAt: number, now: number): number {
	if (askedAt <= 0) return POLL_MS;
	return now - askedAt < FAST_POLL_WINDOW_MS ? POLL_MS : SLOW_POLL_MS;
}

/**
 * 创建升级任务定义。
 *
 * @param runtime 公司运行时，用于读文档、找角色会话、写审计。
 */
export function createEscalationTask(
	runtime: CompanyRuntime,
): Task<EscalationInput, EscalationState, EscalationResult, object> {
	return defineTask<EscalationInput, EscalationState, EscalationResult>({
		name: "app.escalation",
		version: 2,

		/**
		 * v1 的三阶段 checkpoint 搬到 v2 的单阶段。
		 *
		 * 老库里还挂着 `ask-manager` / `ask-ceo` / `ask-owner` 的任务记录，
		 * 进程重启后 `recover()` 会按 v1 的形状恢复它们——不认识就崩。
		 * 映射是机械的：阶段名就决定了当时停在哪一级。
		 */
		migrate: (input, checkpoint) => {
			const old = checkpoint as {
				phase?: string;
				level?: string;
				askedAt?: number;
				path?: string[];
				review?: boolean;
			};
			const level =
				old.phase === "ask-owner" ? "owner" : old.phase === "ask-ceo" ? "ceo" : (old.level ?? "ceo");
			return {
				input: input as EscalationInput,
				checkpoint: {
					phase: "ask" as const,
					level,
					askedAt: old.askedAt ?? 0,
					path: old.path ?? [],
					...(old.review === true ? { review: true } : {}),
				},
			};
		},

		initial: (input) => {
			// ── Defect B 修复：公司级不再直达老板 ──
			//
			// 旧实现：`input.startAtOwner === true || input.topic === "company-level"`
			// → 直接 `ask-owner`，**完全跳过 ask-manager 与 ask-ceo**；且 path 写死
			// `[input.from, "ceo"]` —— 路径里写了 ceo 却从没问过 CEO，
			// 造成「看起来经过了、实际没经过」的假象（老板报警的就是这个现象）。
			//
			// 现在分三种情形，只有**真的够格**的才进老板站：
			// 1) `startAtOwner`：CEO 自己就是发起人（CEO 判断「只能老板定」）→ 老板站。
			//    `startEscalation` 已保证只有 CEO 能置 true；
			//    非 CEO 的 `topic=company-level` **不再**被译成 startAtOwner。
			// 2) 非 CEO 声明 company-level → 先落 ask-ceo 复核（review=true）。
			// 3) 其余 → 照旧从直属管理层开始。
			if (input.startAtOwner === true) {
				// CEO 自己发起：path 只包含发起人（CEO），不伪造中间层。
				return { phase: "ask", level: "owner", askedAt: 0, path: [input.from] };
			}
			if (input.topic === "company-level") {
				// 非 CEO 声明 company-level：必须先过 CEO 复核（由 CEO 判断是否真的只能老板定）。
				return { phase: "ask", level: "ceo", askedAt: 0, path: [input.from], review: true };
			}
			return {
				phase: "ask",
				level: input.manager ?? "ceo",
				askedAt: 0,
				path: [input.from],
			};
		},

		phases: {
			/**
			 * 停在某一级等答复；拿到答复就收口，拿到「拍不了」就往上走一级。
			 *
			 * 往上走一级永远经由 `nextLevelUp(org, level)`，**不自己判断**——
			 * 「员工 → 负责人 → 管理层 → CEO → 老板，一层都不能跳」这条规则
			 * 只存在于那个纯函数里（`src/domain/membership.ts`）。以前三个阶段各自
			 * 拼路径，跳级与假路径的 bug 都在那儿（见 ADR-033）。
			 */
			ask: async (task, taskRuntime, context) => {
				const state = task.state.checkpoint;
				const level = state.level;
				const askedAt = state.askedAt === 0 ? taskRuntime.now() : state.askedAt;

				await ensurePending(runtime, task.input, level, askedAt, context);
				const outcome = await readOutcome(runtime, task.input.escalationKey, level, context);

				if (outcome === undefined) {
					// 老板拍板可能跨天：休眠不占执行名额，进程重启后仍然有效。
					// 但轮询要退避，否则一天 43 万次唤醒（见 pollDelay 的说明）。
					const now = taskRuntime.now();
					await taskRuntime.sleepUntil(
						now + pollDelay(askedAt, now),
						{
							phase: "ask",
							level,
							askedAt,
							path: state.path,
							...(state.review === true ? { review: true } : {}),
						},
						context,
					);
					return;
				}

				// 老板那一级的答复就是终点：`escalate` 在这儿没有意义，
				// 硬要往上走会算出「老板的上级是 CEO」这种回环。
				if (outcome.escalate !== true || level === "owner") {
					await finish(
						taskRuntime,
						runtime,
						context,
						task.input,
						outcome.answeredBy ?? level,
						outcome.answer,
						[...state.path, level],
					);
					return;
				}

				const company = await runtime.harness.snapshot(CompanyDoc, context);
				const up = nextLevelUp(buildOrg(company), level);
				// 结构上 `nextLevelUp` 只对 ceo 返回 owner；这里再挡一道，
				// 免得以后有人改了那个纯函数就悄悄把某层的问题递给老板（ADR-033）。
				if (up === "owner" && level !== "ceo") {
					await finish(
						taskRuntime,
						runtime,
						context,
						task.input,
						outcome.answeredBy ?? level,
						outcome.answer,
						[...state.path, level],
					);
					return;
				}

				await recordHop(runtime, task.input, level, up, context);
				await taskRuntime.commit(
					() => ({
						status: "running",
						checkpoint: {
							phase: "ask",
							level: up,
							askedAt: 0,
							path: [...state.path, level],
						},
					}),
					context,
				);
			},
		},

		abort: async (_task, taskRuntime, context) => {
			await taskRuntime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
}

// ── 对外操作 ────────────────────────────────────────────────────────────────

/** 发起一次升级，返回任务标识。 */
export async function startEscalation(
	runtime: CompanyRuntime,
	task: Task<EscalationInput, EscalationState, EscalationResult, object>,
	input: EscalationInput,
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	// ADR-026 决策 2（落地第 3 步）：起点由**权限矩阵**决定，而不是固定 `manager ?? "ceo"`。
	//
	// 放在这里（唯一入口）而不是散在各个调用方：否则新增一个调用方就会忘接路由，
	// 问题又会被一律推到 CEO/老板。`org.ts` 的 escalate 工具已把结构信息（manager/project）
	// 备齐，这里统一算一次。
	//
	// `startAtOwner` 是显式的「只能老板定」声明，优先于 topic（见 org.ts 的说明）。
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	// 发起人层级也参与路由：没有直属上级时（例如管理层自己上报），
	// 矩阵要能按「发起人所在层级」落到对应岗位，而不是一律落到 CEO。
	const fromLevel = levelOfConversation(state, input.fromConversationId);
	const ownerLevel = input.startAtOwner === true
		? "owner"
		: levelOfTarget(
				decideOwner(state, input.topic ?? "unclassified", {
					...(input.manager === undefined ? {} : { manager: input.manager }),
					...(input.project === undefined ? {} : { project: input.project }),
					...(fromLevel === undefined ? {} : { fromLevel }),
				}),
			);

	// ── Defect B 修复（第二个短路点）──
	//
	// 旧实现：`const startAtOwner = ownerLevel === "owner"`。
	// 因为 `decideOwner(company-level)` 恒返回 owner，**任何**声明 company-level 的
	// 上报都会被译成 `startAtOwner: true` → 直接进 ask-owner，绕过我改过的 initial 分支。
	// 这里必须区分「谁在发起」：
	// - 发起人就是 CEO → CEO 的判断可信，直接递老板（`startAtOwner`）；
	// - 发起人不是 CEO → **不允许**因为它声明 company-level 就直落老板，
	//   交给 initial 走 ask-ceo 复核（`startAtOwner` 保持 false）。
	//
	// 判据用 `fromLevel === "ceo"`（身份反查），而不是信任 `input.startAtOwner`
	// ——后者是调用方可控的入参，信任它等于把「谁都能自称 CEO」写进路由。
	// 只认身份，不认入参：`input.startAtOwner` 是调用方可控的值，
	// 信任它等于允许任何人自称 CEO 直达老板。发起人确实是 CEO 才放行。
	const callerIsCeo = fromLevel === "ceo";
	const startAtOwner = ownerLevel === "owner" && callerIsCeo;
	// 非 CEO 声明 company-level：ownerLevel 仍是 owner，但起点交给 ask-ceo 复核，
	// 所以 manager 要落在 ceo（ask-ceo 不读 manager，这里只保证语义正确）。
	const manager = startAtOwner ? (input.manager ?? "ceo") : (ownerLevel === "owner" ? "ceo" : (ownerLevel as ManagerRef));

	const taskId = await runtime.harness.commit(
		(tx) =>
			tx.createTask(task, { ...input, manager, ...(startAtOwner ? { startAtOwner: true } : {}) }, {
				ownership: { kind: "conversation" },
				conversationId: input.fromConversationId as never,
			}),
		context,
	);

	// 真实留痕：只有真的直达老板才记 from → owner；
	// 非 CEO 的 company-level 记 from → ceo（它确实先到 CEO 复核）。
	await recordHop(runtime, input, input.from, startAtOwner ? "owner" : "ceo", context);
	return Number(taskId);
}

/**
 * 答复一条待决问题。
 *
 * 除了落库，还会**把决定投递给提问方**（`deliverDecision`）。原因见该模块顶部：
 * 原先这里只写 PendingDoc / AuditDoc，两者都不进会话流，于是
 * 「拍板的人以为没生效、被拍板的人永远等不到」——就是用户报的那个故障。
 *
 * 投递发生在提交**之后**：决定已成立就不能因为投递失败回滚。
 */
export async function answerPending(
	runtime: CompanyRuntime,
	input: {
		readonly key: string;
		readonly answer: string;
		readonly answeredBy: string;
		/**
		 * 只允许答复「停在这一级」的待决项。
		 *
		 * 传了就做层级闸门（`item.level !== level` → 拒绝），不传就不校验——两条
		 * 路径原本是三个几乎逐字相同的函数（`answerPendingAsCeo` /
		 * `answerPendingAtLevel`），差别只有这一行判断和 `answeredBy` 的取值。
		 * 合并成一个参数后，「谁能拍板」只剩一处代码可读。
		 */
		readonly level?: string;
		readonly escalate?: boolean;
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<boolean> {
	let delivered: { question: string; askerConversationId: number; askerLabel: string } | undefined;

	if (input.level !== undefined) {
		const state = await runtime.harness.snapshot(PendingDoc, context);
		const item = state?.items.find((entry) => entry.key === input.key);
		if (item === undefined) return false;
		if (item.level !== input.level) return false;
		if (item.answer !== undefined) return false;
		// 已处置的不再接受答复（防「复活」）。
		if (item.disposed !== undefined) return false;
	}

	const ok = await runtime.harness.commit(async (tx) => {
		const pending = await tx.doc(PendingDoc);
		// 已处置（驳回/标记已解决）的待办不能再被答复：处置 = 这条问题到此为止，
		// 允许再答会把它「复活」成待办，也会在审计里留下「关了又答」的矛盾记录。
		const index = pending.items.findIndex(
			(item) => item.key === input.key && item.answer === undefined && item.disposed === undefined,
		);
		if (index < 0) return false;

		const item = pending.items[index];
		if (item === undefined) return false;

		pending.items[index] = {
			...item,
			answer: input.answer,
			answeredBy: input.answeredBy,
			...(input.escalate === true ? { escalate: true } : {}),
		};

		const audit = await tx.doc(AuditDoc, item.fromConversationId as never);
		audit.events.push({
			at: Date.now(),
			type: input.escalate === true ? "escalate" : "decide",
			from: input.answeredBy,
			to: item.from,
			note: input.answer.slice(0, 200),
			ref: input.key,
		});

		delivered = {
			question: item.question,
			// 投给**真实提问方**；旧数据没有 originConversationId 时回退（至少 CEO 收得到）。
			askerConversationId: item.originConversationId ?? item.fromConversationId,
			askerLabel: item.from,
		};
		return true;
	}, context);

	// 升级（escalate=true）不在这里投递：问题还要继续往上走，真正的决定在上层。
	// 这时投一条「已升级」的条目即可，由上层拍板时再投最终结果。
	if (ok && delivered !== undefined && input.escalate !== true) {
		await deliverDecision(
			runtime,
			{
				key: input.key,
				question: delivered.question,
				answer: input.answer,
				answeredBy: input.answeredBy,
				askerConversationId: delivered.askerConversationId,
				askerLabel: delivered.askerLabel,
			},
			context,
		);
	}
	return ok;
}

/**
 * 一条待决问题的决策人（ADR-026 决策 2）。
 *
 * 优先读持久化的 `decisionOwner`；旧数据（字段引入前写入的）没有它就回退到 `level`。
 * 回退是安全的：那些数据本来就只沿汇报线上行，`level` 就是当时实际拍板的人。
 *
 * 处置待办（`item.disposition !== undefined`）例外：它的归属是「被打断工作的下达人」，
 * 已经由 `disposition.ts` 写成权限位并存在 `level` 里，不能再用 `topic` 重算。
 */
export function decisionOwnerOfItem(item: PendingItem): string {
	return item.decisionOwner ?? item.level;
}

/**
 * 列出当前未答复的待决问题。
 *
 * 读时兜底（审计 D-01）：先让到期的处置项按默认值结算，再列出。
 * 这里用**动态导入**是为了避免 `escalation ⇄ disposition` 的运行时环：
 * `disposition.ts` 在模块顶层静态导入本文件的 `PendingDoc` / `levelOfConversation`，
 * 若本文件反过来静态导入它，就会形成循环（其中一侧会拿到未初始化的绑定）。
 * 动态导入把解析推迟到调用时，环自然不存在。
 */
export async function listPending(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<PendingItem[]> {
	const { settleDueDispositions } = await import("./disposition.ts");
	await settleDueDispositions(runtime, Date.now(), context);

	const state = await runtime.harness.snapshot(PendingDoc, context);
	return state?.items.filter((item) => item.answer === undefined && item.disposed === undefined) ?? [];
}

/**
 * 一条待办该不该由「这个操作者」处置。（硬性验收项：无权限者不能操作他人待办）
 *
 * 判据与现有答复路径**同一口径**（`decisionOwnerOfItem`）：
 * - 普通待办：操作者的层级 == `decisionOwner`（缺省回退到 `level`）；
 * - 处置类待办（`item.disposition !== undefined`）：归属是「被打断工作的下达人」，
 *   其权限位已由 `disposition.ts` 写进 `level`，所以改用 `level`。
 *
 * 为什不用「操作者是不是老板」这种简判：老板只能处置**自己这一级**的待办。
 * 老板能驳回 CTO 该拍的问题，就等于把管理层的决策责任又掳回自己身上，
 * 而那正是「待拍板太多」的起因（参见 http.ts postAnswer 的同一道防线）。
 */
export function canDisposePending(item: PendingItem, operatorLevel: string | undefined): boolean {
	if (operatorLevel === undefined) return false;
	const required = item.disposition !== undefined ? item.level : decisionOwnerOfItem(item);
	return operatorLevel === required;
}

/** 处置被拒 / 幂等命中的可读原因（工具层与 HTTP 层共用，避免两边文案不一致）。 */
export type DisposeFailure =
	| { readonly ok: false; readonly code: "not-found"; readonly reason: string }
	| { readonly ok: false; readonly code: "forbidden"; readonly reason: string }
	| { readonly ok: false; readonly code: "answered"; readonly reason: string }
	| { readonly ok: false; readonly code: "archived"; readonly reason: string };

/**
 * 处置结果。`changed=false` 表示幂等命中（已经处置过，且状态一致）。
 *
 * `item` 是**普通快照**（结构化克隆过的），不是 commit 事务里的 overlay 代理。
 * 这个区别很关键：overlay 在 `commit()` 返回后就「结算」了，
 * 此时再读它的字段会抛 `Cannot use a settled overlay`（实测踩到过）。
 * 所以这里只回传一份脱离事务的副本。
 */
export type DisposeOutcome =
	| { readonly ok: true; readonly changed: boolean; readonly item: PendingItem }
	| DisposeFailure;

/**
 * 处置一条待办：驳回（`rejected`）或标记已解决（`resolved`）。
 *
 * 职责（四条硬要求一次写完）：写入状态 + 记录理由 + 写审计留痕 + **幂等**。
 * 幂等的具体含义：同一个人对同一条待办重复提交**同一种**处置 → 返回 `changed=false`、
 * 不重复写审计、不报错。重复提交**不同**处置（先驳回再标已解决）→ 拒绝，
 * 因为那会让审计里出现两个互相矛盾的结论。
 *
 * 权限校验在此处**再算一遍**（不依赖调用方传对）：操作者只能处置 `decisionOwnerOfItem`
 * （处置类看 `level`）等于自己层级的那条。这样 HTTP 层 / 工具层漏检查也不会越权。
 */
export async function disposePending(
	runtime: CompanyRuntime,
	input: {
		readonly key: string;
		readonly status: DisposalKind;
		readonly reason?: string;
		/** 处置人（写入 `disposedBy` 与审计 `from`）。 */
		readonly disposedBy: string;
		/** 操作者的层级，用于权限判定（= levelOfConversation(会话)）。 */
		readonly operatorLevel: string | undefined;
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<DisposeOutcome> {
	const reason = (input.reason ?? "").trim();
	let outcome: DisposeOutcome | undefined;

	await runtime.harness.commit(async (tx) => {
		const pending = await tx.doc(PendingDoc);
		// 同一个 `key` 会在多个层级各有一条（升级链每升一级 ensurePending 就新写一条，
		// 实测同一升级同时在 ceo 与 owner 各有一条）。所以不能只按 key 找：
		// 只按 key 会命中下层那条（它通常已经有 answer），
		// 于是老板要处置的 owner 级条目永远匹配不到，反而报「已经答复过了」。
		//
		// 定位口径（三层优先级）：
		// 1) 「该由操作者处置、且还没处置」的那条 —— 正常首次处置走这条；
		// 2) 「该由操作者处置、已处置」的那条 —— **幂等重试**走这条
		//    （不能因为「已处置」就跳到下层那条，否则重试会报「已经答复过了」）；
		// 3) 否则 key 相同的第一条 —— 为了给出准确的可读原因（越权 / 已答复）。
		const sameKey = pending.items
			.map((item, index) => ({ item, index }))
			.filter((entry) => entry.item.key === input.key);
		const mine = sameKey.filter((entry) => canDisposePending(entry.item, input.operatorLevel));
		const target =
			mine.find((entry) => entry.item.disposed === undefined) ?? mine[0] ?? sameKey[0];
		const item = target?.item;
		const index = target?.index ?? -1;
		if (item === undefined || index < 0) {
			outcome = { ok: false, code: "not-found", reason: "没有这条待办（可能已被处理）" };
			return;
		}

		// ① 已答复的不允许再处置：答复意味着工作已继续，再驳会让已交付的决定变成孤儿。
		if (item.answer !== undefined && item.disposed === undefined) {
			outcome = { ok: false, code: "answered", reason: "这条待办已经答复过了，不能再驳回/标记已解决" };
			return;
		}

		// ② 幂等：已处置且状态一致 → 不重写、不重留痕，直接成功。
		if (item.disposed !== undefined) {
			if (item.disposed.status === input.status) {
				outcome = { ok: true, changed: false, item: snapshotOf(item) };
				return;
			}
			outcome = {
				ok: false,
				code: "archived",
				reason: `这条待办已于 ${new Date(item.disposed.disposedAt).toISOString()} 被 ${item.disposed.disposedBy} 处置为「${disposeLabel(item.disposed.status)}」，不能改成「${disposeLabel(input.status)}」`,
			};
			return;
		}

		// ③ 权限：只能处置「该由自己拍」的那一条。
		if (!canDisposePending(item, input.operatorLevel)) {
			const required = item.disposition !== undefined ? item.level : decisionOwnerOfItem(item);
			outcome = {
				ok: false,
				code: "forbidden",
				reason: `这条待办该由「${required}」处置，你（${input.operatorLevel ?? "未知"}）无权操作`,
			};
			return;
		}

		const disposal: PendingDisposal = {
			status: input.status,
			disposedBy: input.disposedBy,
			disposedAt: Date.now(),
			reason,
		};
		const next: PendingItem = { ...item, disposed: disposal };
		pending.items[index] = next;

		// ④ 审计留痕：写在**提问方**的会话审计文档里（与 answerPending 同一位置），
		// 这样「谁问的」那条会话能回答「我这个问题最后怎么没了」。
		const audit = await tx.doc(AuditDoc, item.fromConversationId as never);
		audit.events.push({
			at: disposal.disposedAt,
			type: "dispose",
			from: input.disposedBy,
			to: item.from,
			// note 前缀固定为 `rejected`/`resolved` 便于机器检索；后面跟理由。
			note: `${disposal.status}${reason === "" ? "" : `: ${reason}`}`.slice(0, 200),
			// ref 带上 level：同一个升级在多层各有一条待办，只写 key 事后分不清
			// 「老板驳回的」与「CTO 驳回的」是哪一条。
			ref: `${item.key}@${item.level}`,
		});

		outcome = { ok: true, changed: true, item: snapshotOf(next) };
	}, context);

	// commit 保证回调已执行；这里仅收窄类型。
	return outcome ?? { ok: false, code: "not-found", reason: "没有这条待办（可能已被处理）" };
}

/**
 * 把一个（可能来自 commit overlay 的）待办条目拍成普通快照。
 *
 * 为什么必须做：`commit(tx => ...)` 里的 `tx.doc()` 返回的是 overlay 代理，
 * commit 一返回它就结算了，**事务外再读它的字段会抛 `Cannot use a settled overlay`**。
 * 处置结果要交给 HTTP/工具层在事务外使用（JSON.stringify、拼文案），
 * 所以这里先 JSON 往返一次，拿到一份纯数据。
 */
function snapshotOf(item: PendingItem): PendingItem {
	return JSON.parse(JSON.stringify(item)) as PendingItem;
}

/** 处置类型的中文名（界面与错误文案共用）。 */
export function disposeLabel(status: DisposalKind): string {
	return status === "rejected" ? "驳回" : "标记已解决";
}

/**
 * CEO 接管一条**老板级**待办：把它拉回自己层处理，不必等老板拍板。
 *
 * Defect B 要求 3「CEO 对老板级待办的处置权」的落地。
 * 场景：某条问题因上报方声明 company-level 而落到老板那儿，CEO 复核后认为
 * 「这在我授权范围内」（例如技术选型被误标成公司级）——CEO 应当能直接把它拉回来定，
 * 而不是只能干等着老板。
 *
 * 实现方式：**不删条目、不改其中的 answer**，而是把 `level` 与 `decisionOwner`
 * 改写为 `ceo`，并留下 `takenOver` 痕迹。这样：
 * - 它立刻从老板队列消失（forYou 要求 decisionOwner === owner）；
 * - 它出现在 CEO 队列（decisionOwner === ceo）；
 * - 审计里有据可查（谁在什么时候因为什么把老板的活拉走了）。
 *
 * 权限：只有 CEO 能接管（`operatorLevel === "ceo"`），且目标必须是 owner 级。
 * 老板自己不能「接管」——老板就是终点，他要么答、要么驳回（disposePending）。
 */
export async function takeOverPendingAtCeo(
	runtime: CompanyRuntime,
	input: { readonly key: string; readonly reason?: string; readonly operatorLevel: string | undefined },
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ readonly ok: true; readonly changed: boolean; readonly item: PendingItem } | DisposeFailure> {
	const reason = (input.reason ?? "").trim();
	let outcome: Awaited<ReturnType<typeof takeOverPendingAtCeo>> | undefined;

	await runtime.harness.commit(async (tx) => {
		if (input.operatorLevel !== "ceo") {
			outcome = {
				ok: false,
				code: "forbidden",
				reason: `只有 CEO 能接管老板级待办，你（${input.operatorLevel ?? "未知"}）无权操作`,
			};
			return;
		}

		const pending = await tx.doc(PendingDoc);
		// 同一 key 可能有多层条目（升级链在每层各写一条）。
		// 这里要认两种形态：
		// ① 仍是 owner 级、未处置 → 正常接管；
		// ② 已经被接管过（有 takenOver 痕迹、现在是 ceo 级）→ 幂等命中。
		const sameKey = pending.items.map((item, index) => ({ item, index })).filter((e) => e.item.key === input.key);
		const already = sameKey.filter((e) => e.item.takenOver !== undefined).at(-1);
		if (already !== undefined) {
			outcome = { ok: true, changed: false, item: snapshotOf(already.item) };
			return;
		}
		const target = sameKey.filter((e) => e.item.level === "owner").at(-1);
		const item = target?.item;
		const index = target?.index ?? -1;
		if (item === undefined || index < 0) {
			outcome = { ok: false, code: "not-found", reason: "没有这条老板级待办（可能已被处理）" };
			return;
		}
		if (item.answer !== undefined || item.disposed !== undefined) {
			outcome = { ok: false, code: "answered", reason: "这条已经答复或处置过了，不能再接管" };
			return;
		}

		const next: PendingItem = {
			...item,
			// 拉到 CEO 层：level 与 decisionOwner 一起改，两者必须同步——
			// 只改一个会出现「不在老板队列、也不在 CEO 队列」的消失状态。
			level: "ceo",
			decisionOwner: "ceo",
			takenOver: {
				by: "ceo",
				at: Date.now(),
				reason,
				// 记下原本停在哪一级，事后能回答「这条本来该老板定，CEO 给拉回来了」。
				fromLevel: "owner",
			},
		};
		pending.items[index] = next;

		const audit = await tx.doc(AuditDoc, item.fromConversationId as never);
		audit.events.push({
			at: next.takenOver?.at ?? Date.now(),
			type: "dispose",
			from: "ceo",
			to: item.from,
			note: `taken-over${reason === "" ? "" : `: ${reason}`}`.slice(0, 200),
			ref: `${item.key}@owner`,
		});

		outcome = { ok: true, changed: true, item: snapshotOf(next) };
	}, context);

	return outcome ?? { ok: false, code: "not-found", reason: "没有这条老板级待办（可能已被处理）" };
}

// ── 内部 ────────────────────────────────────────────────────────────────────

/** 确保问题出现在待决列表里（幂等）。 */
async function ensurePending(
	runtime: CompanyRuntime,
	input: EscalationInput,
	level: string,
	askedAt: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	await runtime.harness.commit(async (tx) => {
		const pending = await tx.doc(PendingDoc);
		const existing = pending.items.find(
			(item) => item.key === input.escalationKey && item.level === level,
		);
		if (existing !== undefined) return;

		// 公司结构：既用于「owner 级一律记在 CEO 名下」，也用于判定决策人。
		const company = await runtime.harness.snapshot(CompanyDoc, context);

		// 老板只看得到「CEO 报上来的问题」：owner 级待办一律记在 CEO 名下，
		// 哪怕最初是某个项目负责人发起的（中间已由 CEO 背书过一层）。
		let from = input.from;
		let fromConversationId = input.fromConversationId;
		if (level === "owner") {
			const ceoId = company?.roles.ceo;
			if (ceoId !== undefined) {
				from = "CEO";
				fromConversationId = ceoId;
			}
		}

		const item: PendingItem = {
			key: input.escalationKey,
			question: input.question,
			level,
			from,
			fromConversationId,
			askedAt,
			// 真实提问方：`fromConversationId` 在 owner 级会被改写成 CEO，
			// 投递拍板结果必须回到原始发起人（见字段注释）。
			originConversationId: input.fromConversationId,
		};
		if (input.project !== undefined) item.project = input.project;
		// ── Defect B 要求 4：来源可追溯 ──
		// 记下「上报方声明了什么类别、为什么到了这一级」，界面直接展示。
		// 重点是 company-level 落到 owner 时：说明它经过/待过 CEO 复核，
		// 而不是「模型说它是公司级，所以就给老板」。
		if (level === "owner") {
			item.trace = {
				...(input.topic === undefined ? {} : { declaredTopic: input.topic }),
				// owner 站的条目：若是 CEO 站转场过来的，说明 CEO 已复核；
				// 若是 CEO 自己发起（startAtOwner），CEO 本人即复核人。
				ceoReviewed: true,
				note:
					input.startAtOwner === true
						? "CEO 判断：只有老板能定（CEO 主动上报）"
						: "上报方声明公司级 → CEO 已复核确认，转老板",
			};
		} else if (level === "ceo" && input.topic === "company-level") {
			// CEO 复核站的条目：明确告诉 CEO「这是自证的声明，请你判断」。
			item.trace = {
				declaredTopic: "company-level",
				ceoReviewed: false,
				note: "上报方声明公司级（自证）→ 请 CEO 复核：是否真的只有老板能定",
			};
		} else if (input.topic !== undefined) {
			item.trace = { declaredTopic: input.topic, note: `上报方声明类别：${input.topic}` };
		}
		// ADR-026 决策 2（落地第 3 步）：在写入时就定下「该由谁拍」。
		// 用持久化而非每次读取时现算：规则以后调整时，历史待办不会被改写，
		// 事后才能回答「当时为什么到了老板那儿」（决策 8 的留痕要求）。
		//
		// 关键：**以当前 level 为准，而不是重新按 topic 算**。
		// 升级链已经把它推到这一级了（例如 CEO 拍不了、escalate 到 owner），
		// 这时「该谁拍」就是这一级本身。若重新按 topic 算，一条「项目负责人
		// 上报 → CEO 升级」的问题在 owner 层的 decisionOwner 会算回 ceo，
		// 于是它既不在 CEO 的待办里（level 已是 owner）、也不在老板的待办里
		// （forYou 要求 decisionOwner === owner）—— 两边都看不到，问题凭空消失。
		//
		// topic 只在**第一级**（起点）决定路由；后续层级由 level 决定。
		//
		// 与 startEscalation 用同一份结构信息（含发起人层级），否则「起点」与
		// 「落库时记下的决策人」会算出两个不同的答案，历史留痕就对不上。
		const isFirstLevel = level !== "owner" && level !== "ceo";
		const fromLevel = levelOfConversation(company, input.fromConversationId);
		const owner = isFirstLevel
			? decideOwner(company, input.topic ?? "unclassified", {
					...(input.manager === undefined ? {} : { manager: input.manager }),
					...(input.project === undefined ? {} : { project: input.project }),
					...(fromLevel === undefined ? {} : { fromLevel }),
				})
			: level === "owner"
				? ({ kind: "owner" } as const)
				: ({ kind: "role", role: "ceo" } as const);
		item.decisionOwner = levelOfTarget(owner);
		pending.items.push(item);
	}, context);
}

/**
 * 读某个升级在**指定层级**的答复；未答复返回 undefined。
 *
 * 必须按层级精确定位：同一升级在多个层级各有一条待决项，
 * 只按 key 读会读到下层的答复，导致上层被跳过。
 */
async function readOutcome(
	runtime: CompanyRuntime,
	escalationKey: string,
	level: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ answer: string; escalate: boolean; answeredBy?: string } | undefined> {
	const state = await runtime.harness.snapshot(PendingDoc, context);
	const item = state?.items.find(
		(entry) => entry.key === escalationKey && entry.level === level && entry.answer !== undefined,
	);
	if (item?.answer === undefined) return undefined;
	return {
		answer: item.answer,
		escalate: item.escalate === true,
		...(item.answeredBy === undefined ? {} : { answeredBy: item.answeredBy }),
	};
}

/** 结束升级，写终态。 */
async function finish(
	taskRuntime: {
		commit: (
			change: () => {
				status: "terminal";
				outcome: { status: "completed"; result: EscalationResult };
			},
			context: Context,
		) => Promise<void>;
	},
	runtime: CompanyRuntime,
	context: Context,
	input: EscalationInput,
	decidedBy: string,
	decision: string,
	path: readonly string[],
): Promise<void> {
	const result: EscalationResult = { decidedBy, decision, path: [...path] };

	// 先写审计与留痕，再提交终态。
	// 顺序很重要：调用方 waitEscalation() 在终态提交后立刻返回，
	// 若先提交终态，随后写的时间线可能还没落盘（竞态）。
	const companyAtDecision = await runtime.harness.snapshot(CompanyDoc, context);
	const deciderConversation =
		conversationOfLevelOrName(companyAtDecision, decidedBy) ?? input.fromConversationId;

	await runtime.harness.commit(async (tx) => {
		const audit = await tx.doc(AuditDoc, input.fromConversationId as never);
		audit.events.push({
			at: Date.now(),
			type: decidedBy === "owner" ? "owner-decision" : "decide",
			from: ROLE_LABELS[decidedBy as ManagementRole] ?? decidedBy,
			to: input.from,
			note: decision.slice(0, 200),
			ref: input.escalationKey,
		});

		const trail = await tx.doc(TrailDoc);
		const edge: (typeof trail.edges)[number] = {
			at: Date.now(),
			kind: "decide",
			fromConversation: deciderConversation,
			toConversation: input.fromConversationId,
			from: displayLevel(companyAtDecision, decidedBy),
			to: input.from,
			ref: input.escalationKey,
		};
		if (input.project !== undefined) edge.project = input.project;
		trail.edges.push(edge);
	}, context);

	await taskRuntime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
}

/** 记录一次层级跃迁。 */
async function recordHop(
	runtime: CompanyRuntime,
	input: EscalationInput,
	from: string,
	to: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	const company = await runtime.harness.snapshot(CompanyDoc, context);
	const fromConversation = conversationOfLevelOrName(company, from) ?? input.fromConversationId;
	const toConversation = conversationOfLevelOrName(company, to) ?? input.fromConversationId;
	const fromLabel = displayLevel(company, from);
	const toLabel = displayLevel(company, to);

	await runtime.harness.commit(async (tx) => {
		const trail = await tx.doc(TrailDoc);
		const edge: (typeof trail.edges)[number] = {
			at: Date.now(),
			kind: "escalate",
			fromConversation,
			toConversation,
			from: fromLabel,
			to: toLabel,
			ref: input.escalationKey,
		};
		if (input.project !== undefined) edge.project = input.project;
		trail.edges.push(edge);

		const audit = await tx.doc(AuditDoc, input.fromConversationId as never);
		audit.events.push({
			at: Date.now(),
			type: "escalate",
			from,
			to,
			note: input.question.slice(0, 200),
			ref: input.escalationKey,
		});
	}, context);
}

/**
 * 把「层级」解析成会话标识。
 *
 * 层级可能是岗位名（cto/ceo/owner）、项目负责人引用（leader:<slug>），
 * 或答复人显示名（许砚舟 / 员工名）。三种都要认，否则审计与留痕会把
 * 归属记到提问者自己头上（图谱出现自环）。
 */
function conversationOfLevelOrName(state: CompanyState | undefined, level: string): number | undefined {
	if (state === undefined) return undefined;

	const direct = state.roles[level];
	if (direct !== undefined) return Number(direct);
	if (level === "owner") {
		const ceo = state.roles.ceo;
		if (ceo !== undefined) return Number(ceo);
	}
	const slug = leaderSlugOf(level);
	if (slug !== undefined) return state.projects[slug]?.leader;

	// 显示名反查：负责人名字、员工名、岗位中文名
	for (const project of Object.values(state.projects)) {
		if (project.leaderName === level) return project.leader;
	}
	for (const person of Object.values(state.staff)) {
		if (person.name === level) return person.conversationId;
	}
	for (const [role, id] of Object.entries(state.roles)) {
		if (ROLE_LABELS[role as ManagementRole] === level) return Number(id);
	}
	return undefined;
}

/** 层级在审计/留痕里的显示名：负责人引用翻成负责人名字，岗位保持原样。 */
function displayLevel(state: CompanyState | undefined, level: string): string {
	return isLeaderManagerRef(level) ? managerLabelOf(state, level) : level;
}

/**
 * 会话在升级链里对应哪一级。
 *
 * CEO → "ceo"，其他管理层 → 岗位名，项目负责人 → "leader:<slug>"，员工 → undefined。
 * pending_list / answer_pending 用它判断「这条问题是不是到我这一级」，
 * 不能再写死 level === "ceo"。
 */
export function levelOfConversation(
	state: CompanyState | undefined,
	conversationId: number,
): string | undefined {
	if (state === undefined) return undefined;
	for (const [role, id] of Object.entries(state.roles)) {
		if (Number(id) === conversationId) return role;
	}
	for (const [slug, project] of Object.entries(state.projects)) {
		if (project.leader === conversationId) return `${LEADER_REF_PREFIX}${slug}`;
	}
	return undefined;
}
