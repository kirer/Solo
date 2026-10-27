/**
 * 组织操作：初始化公司、创建项目、招聘员工、模型分配、归档。
 *
 * 这些操作都遵循同一条原则：会话创建与名册登记必须在**同一次原子提交**内完成，
 * 否则崩溃后会留下「会话已建但名册未记」的不一致（见 org-structure 规格）。
 *
 * 注意底层限制：commit 回调里只能通过 tx 读写，不能 await 任何 Session API
 * （会死锁，而且是间歇性的）。
 */
import {
	BACKGROUND_CONTEXT,
	type Context,
	configure,
	defineExtension,
	defineTask,
	defineTool,
	type CompanyRuntime,
	type Registry,
	type Task,
} from "../runtime/index.ts";
import {
	AuditDoc,
	type CompanyState,
	CompanyDoc,
	TrailDoc,
	LEADER_REF_PREFIX,
	type ManagerRef,
	managerLabelOf,
	isLeaderManagerRef,
	isValidManagerRef,
	type ManagementRole,
	MANAGEMENT_ROLES,
	type ModelOption,
	type ModelRef,
	type ProjectEntry,
	type ProjectStatus,
	ProfileDoc,
	ROLE_LABELS,
	type StaffEntry,
} from "./docs.ts";
import { createRoleExtension, ROLE_DEFINITIONS } from "./roles.ts";
import { decideOwner, levelOfTarget, type DecisionTopic } from "./decision-routing.ts";
import {
	PendingDoc,
	decisionOwnerOfItem,
	disposePending,
	takeOverPendingAtCeo,
	levelOfConversation,
	listPending,
	answerPendingAtLevel,
	answerPendingAsCeo,
} from "./escalation.ts";
import { settleDisposition } from "./disposition.ts";
import {
	PROJECT_LEADER_CHARTER,
	PROJECT_LEADER_READONLY_CHARTER,
	LEADER_EXECUTION_TOOLS,
	createProjectLeaderExtension,
	createProjectLeaderReadOnlyExtension,
	createRoleExtensionWithTools,
	type ManagementToolset,
} from "./tools.ts";
import {
	type EscalationInput,
	type EscalationResult,
	type EscalationState,
	startEscalation,
} from "./escalation.ts";
import { escalationId } from "../runtime/ids.ts";
import { toolsForNames } from "./staff-tools.ts";
import { startWatchdog, type WatchdogOptions } from "./watchdog.ts";
import { roundtableExtension } from "./roundtable.ts";
// **不能静态 import**：`management-tools.ts` 静态 import 本文件的 11 个函数，
// 静态互引会形成真实的 ESM 循环依赖（DFS 实测确认）。当前恰好没有模块顶层求值，
// 所以还没炸；但任何一侧在顶层算一个值就会拿到 `undefined`。
// 这里改成动态 import（`bootstrapCompany` 本来就是 async），依赖方向变成单向：
// management-tools → org。同仓 `escalation.ts:684` 对 `disposition.ts` 用的是同一手法。
type ManagementToolsModule = typeof import("./management-tools.ts");
import { createAllRoleExtensionsWithTools, createEmployeeExtension } from "./tools.ts";
import { isAbsolute, resolve as resolvePath } from "node:path";

/**
 * 每个运行时对应的管理层工具集。
 *
 * `bootstrapCompany` 在装配时登记，`createProject` 立项时取用——这样
 * 「谁都能建项目，但负责人一定有工具」不依赖调用方是否记得传参数。
 */
const LEADER_TOOLSETS = new WeakMap<CompanyRuntime, ManagementToolset>();

/**
 * 每个运行时对应的「上报」工具。
 *
 * 员工要能把问题报给直属上级，就必须有 escalate。它由装配层从管理层工具集里
 * 取出来，招聘/重建员工能力包时追加到执行工具后面——这样全体员工共用同一个
 * 工具实现，上报时按 `staff.manager` 决定落到谁那里。
 */
const EMPLOYEE_EXTRA_TOOLS = new WeakMap<CompanyRuntime, readonly ReturnType<typeof defineTool>[]>();

/**
 * 员工要拿到的「通用工具」（say / ask / read_channel / inbox / task_* / whoami）。
 *
 * 与 `EMPLOYEE_EXTRA_TOOLS`（escalate + my_capabilities）分开存：那两个是
 * 「员工专属的额外能力」，这些是「每个 agent 都该有的通信能力」。
 * 合并会让「谁有什么」变得难以审计。
 */
const EMPLOYEE_UNIVERSAL_TOOLS = new WeakMap<CompanyRuntime, readonly ReturnType<typeof defineTool>[]>();

/** 员工可用的通用工具（招聘、改名、自愈三处共用同一份）。 */
export function employeeUniversalTools(runtime: CompanyRuntime): readonly ReturnType<typeof defineTool>[] {
	return EMPLOYEE_UNIVERSAL_TOOLS.get(runtime) ?? [];
}

/**
 * 员工实际可用的工具：被授予的原子执行工具 + 向直属上级上报。
 *
 * 单独导出：招聘、重启自愈、职工档案三处必须用同一份，否则「档案里写的工具」
 * 与「真正拿到的工具」又会不一致。
 *
 * 入参是**工具名列表**而不是角色名：能力由招聘时显式声明的 tools 决定，
 * 角色只是名册上的标签（以前按角色查表，未知角色会静默退化成只读员工）。
 *
 * 工具名可带目录范围（`write:src/`），范围在这里一层就包好了（见 `scopedTools`，ADR-035）：
 * 招聘、重启、档案三处都经过本函数，所以不存在「重启后范围丢了」这条路。
 */
export function employeeToolsFor(
	runtime: CompanyRuntime,
	toolNames: readonly string[],
): ReturnType<typeof defineTool>[] {
	const tools: ReturnType<typeof defineTool>[] = [...toolsForNames(toolNames)];
	tools.push(...(EMPLOYEE_EXTRA_TOOLS.get(runtime) ?? []));
	return tools;
}

/** 默认模型清单（价格单位为美元 / 百万 token）。 */
/**
 * 默认模型清单。
 *
 * 生产环境应当由 `setupModels()` 提供的清单填充（见 src/runtime/models.ts）。
 * 这里留空而不是塞测试模型——测试用的 faux 模型一旦进了清单，
 * CHRO 会因为它「零成本」而优先选中，导致生产环境真实员工拿到假模型，
 * 表现为 `no_model`。
 */
export const DEFAULT_MODEL_CATALOG: ModelOption[] = [];

/** 初始化选项。 */
export type BootstrapOptions = {
	readonly companyName: string;
	/**
	 * 能力注册表。传入后会把全部角色能力包注册进去。
	 *
	 * 必须传：底层按名字存能力包选择，未注册的能力包在会话上取不到，
	 * 表现为「职责描述为空、工具为空」。
	 */
	readonly registry?: Registry;
	/** 工作空间根目录，供立项工具使用。 */
	readonly workspaceRoot?: string;
	/** 公司默认模型；不传则用清单第一项。 */
	readonly defaultModel?: ModelRef;
	readonly modelCatalog?: readonly ModelOption[];
	/** 老板与 CEO 的对话通道所用的模型。 */
	readonly ownerModel?: ModelRef;
	/** 管理层岗位的模型覆盖。 */
	readonly roleModels?: Partial<Record<ManagementRole, ModelRef>>;
	/** 成本报告实现，注入给 CFO 的工具。 */
	readonly costReport?: (input: { readonly project?: string }) => Promise<string>;
	/** 员工可用的执行类工具；招聘时注入给每个员工。 */
	readonly employeeTools?: readonly ReturnType<typeof defineTool>[];
	/** 升级任务定义；装入后管理层的 escalate 会真的创建升级流程。 */
	readonly escalationTask?: Task<EscalationInput, EscalationState, EscalationResult, object>;
	/**
	 * 看门狗（契约 §5.2）：定期收尾僵住的任务、排空队列。
	 *
	 * **默认不启动**：`bootstrapCompany` 是装配函数，被测试、终端、网页三种
	 * 入口共用；在库里偷偷起一个会主动 abort/投递消息的后台循环，会让调用方
	 * 完全无法掌控调度（测试里表现为「消息还没断言就被投出去了」）。
	 *
	 * 真正需要兜底的入口（`serve()` / TUI）显式打开：
	 * - `true`：按默认阈值启动
	 * - 对象：自定义阈值
	 * - `false` / 不传：不启动
	 */
	readonly watchdog?: boolean | WatchdogOptions;
};

/** 初始化结果。 */
export type BootstrapResult = {
	/** 老板与 CEO 的对话通道。 */
	readonly ownerConversationId: number;
	/** 各管理层岗位的会话标识。 */
	readonly roleConversations: Record<ManagementRole, number>;
	readonly created: boolean;
	/**
	 * 停掉看门狗（幂等）。
	 *
	 * 必须给出来：网页服务退出、测试收尾时要停掉定时器，
	 * 否则进程会被残留的巡检拖着不走。
	 */
	readonly stopWatchdog?: () => void;
};

/**
 * 初始化公司。
 *
 * 幂等：已初始化则直接返回现有结构，不重复创建。
 */
export async function bootstrapCompany(
	runtime: CompanyRuntime,
	options: BootstrapOptions,
	context: Context = BACKGROUND_CONTEXT,
): Promise<BootstrapResult> {
	// 看门狗：默认不启动，由入口（serve / TUI）显式打开，见 BootstrapOptions.watchdog
	const watchdogOption: boolean | WatchdogOptions = options.watchdog ?? false;

	// 管理层工具集合：由公司运行时闭包而成。
	const { createManagementTools }: ManagementToolsModule = await import("./management-tools.ts");
	const managementTools = createManagementTools({
		runtime,
		workspaceRoot: options.workspaceRoot ?? process.cwd(),
		...(options.registry === undefined ? {} : { registry: options.registry }),
		...(options.costReport === undefined ? {} : { costReport: options.costReport }),
		...(options.employeeTools === undefined ? {} : { employeeTools: options.employeeTools }),
		// 上报路由的全部逻辑在 `escalateUp` 里（唯一入口，可被直接测试）；
		// 工具层只负责把参数转过去，避免「工具能用、直调 API 不能用」两套口径。
		escalate: async (input) => escalateUp(runtime, input, options.escalationTask, context),
		pendingList: async (input) => {
			const pending = await listPending(runtime, BACKGROUND_CONTEXT);
			const state = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
			const myLevel = levelOfConversation(state, input.conversationId);
			// ADR-026 决策 2（落地第 3 步）：按**决策人**过滤，不按 level。
			// level 是「升级链停在哪」，升一级就变；decisionOwner 才是「结构上该谁拍」。
			// 这样该 CTO 拍的架构问题会出现在 CTO 的队列里，而不是被一路推到 CEO/老板。
			const mine = pending.filter((item) => myLevel !== undefined && decisionOwnerOfItem(item) === myLevel);
			if (mine.length === 0) return "没有等你拍板的问题。";
			return [
				"等着你拍板的问题（用 answer_pending 回答，key 原样填）：",
				...mine.map(
					(item, index) =>
						`${index + 1}. [${item.key}] 来自 ${item.from}：${item.question.replace(/\s+/g, " ").slice(0, 300)}`,
				),
			].join("\n");
		},
		answerPending: async (input) => {
			const state = await runtime.harness.snapshot(PendingDoc, BACKGROUND_CONTEXT);
			const item = state?.items.find((entry) => entry.key === input.key);
			if (item === undefined) return `没有编号为 ${input.key} 的待决问题。先用 pending_list 看队列。`;
			// ADR-026 决策 5：「默认值可被事后推翻」。超时默认结算掉的处置项
			// （decidedBy === "timeout-default"）仍然允许人重新回答；人自己答过的不许反复改，
			// 否则留痕变成儿戏、网络重试也会静默改掉别人已经拍下的板。
			const overturnable = item.disposition?.decidedBy === "timeout-default";
			if (item.answer !== undefined && !overturnable) return `这条已经答复过了（${item.answeredBy ?? "?"}）。`;

			const company = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
			const myLevel = levelOfConversation(company, input.conversationId);
			const owner = decisionOwnerOfItem(item);
			if (myLevel === undefined || owner !== myLevel) {
				return `编号 ${input.key} 应该由 ${labelOfLevel(company, owner)} 拍板，不是到你这一级的，你不能替它拍板。`;
			}

			// 处置类待办必须走 settleDisposition（会校验「暂搁/放弃」并强制恢复条件）。
			// 原先这里直接落到 answerPendingAtLevel，自由文本被当成普通答复写进 answer，
			// `disposition.disposition` 永远为空——待办从 listPending 里消失，
			// 看起来「答过了」，实际处置从未成立（审计 D-02(b)）。
			if (item.disposition !== undefined) {
				const settled = await settleDisposition(
					runtime,
					{
						key: input.key,
						answer: input.answer,
						answeredBy: labelOfConversation(company, input.conversationId) ?? myLevel,
					},
					BACKGROUND_CONTEXT,
				);
				if (!settled.ok) return `处置未生效：${settled.reason}`;
				return settled.disposition === "shelve"
					? `已暂搁（恢复条件：${settled.resumeCondition}）。`
					: "已标记为永久放弃。";
			}

			const ok = await answerPendingAtLevel(
				runtime,
				{
					key: input.key,
					answer: input.answer,
					level: myLevel,
					answeredBy: labelOfConversation(company, input.conversationId) ?? myLevel,
					...(input.escalate === true ? { escalate: true } : {}),
				},
				BACKGROUND_CONTEXT,
			);
			if (!ok) return `答复失败：编号 ${input.key} 可能已被处理。`;
			return input.escalate === true
				? "已转为老板待办，等老板拍板。"
				: "已拍板并记录在案。";
		},
		disposePending: async (input) => {
			const company = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
			const myLevel = levelOfConversation(company, input.conversationId);
			if (myLevel === undefined) return "认不出你是哪一级，不能处置待办。";
			// 驳回必须给理由（验收口径里的「以什么理由」）。标记已解决可以不带。
			const reason = (input.reason ?? "").trim();
			if (input.status === "rejected" && reason === "") {
				return "驳回必须给理由（reason）：为什么不认可这条待办。";
			}
			const outcome = await disposePending(
				runtime,
				{
					key: input.key,
					status: input.status,
					reason,
					disposedBy: labelOfConversation(company, input.conversationId) ?? myLevel,
					operatorLevel: myLevel,
				},
				BACKGROUND_CONTEXT,
			);
			if (!outcome.ok) {
				if (outcome.code === "forbidden") return `无权处置：${outcome.reason}`;
				if (outcome.code === "archived") return `处置失败：${outcome.reason}`;
				if (outcome.code === "answered") return `处置失败：${outcome.reason}`;
				return `处置失败：${outcome.reason}`;
			}
			const label = input.status === "rejected" ? "已驳回" : "已标记为已解决";
			return outcome.changed ? `${label}，已从待办列表移除。` : `这条之前${label}过了（重复操作已忽略）。`;
		},
		takeOverPending: async (input) => {
			const company = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
			const myLevel = levelOfConversation(company, input.conversationId);
			if (myLevel !== "ceo") {
				return `只有 CEO 能把老板级待办接管回自己层，你（${myLevel ?? "未知"}）无权操作。`;
			}
			const outcome = await takeOverPendingAtCeo(
				runtime,
				{ key: input.key, reason: input.reason ?? "", operatorLevel: myLevel },
				BACKGROUND_CONTEXT,
			);
			if (!outcome.ok) return `接管失败：${outcome.reason}`;
			return outcome.changed
				? `已把 ${input.key} 接管回你这一层，现在用 answer_pending 回答它。`
				: `${input.key} 之前已接管过了（重复操作已忽略）。`;
		},
		decide: async (input) => {
			// 记录决定到审计，使「谁在什么时候定了什么」可追溯
			await runtime.harness.commit(async (tx) => {
				const audit = await tx.doc(AuditDoc, input.conversationId as never);
				audit.events.push({
					at: Date.now(),
					type: "decide",
					from: input.from,
					note: input.decision.slice(0, 200),
				});
			}, context);
		},
		reassignStaff: async (input) => (await reassignStaff(runtime, input, context)).message,
		setProjectStatus: async (input) =>
			(
				await setProjectStatus(
					runtime,
					{
						project: input.project,
						to: input.status,
						by: input.by,
						fromConversationId: input.fromConversationId,
					},
					context,
				)
			).message,
	});

	// 员工额外工具：上报（落到 staff.manager 指定的上级）+ 能力自查。
	// 能力自查不是锦上添花：员工经常被问「你能不能做 X」，没有它只能凭记忆答。
	EMPLOYEE_EXTRA_TOOLS.set(runtime, [managementTools.escalate, managementTools.myCapabilities]);
	// 通用通信能力：员工也要能在项目群里 ask / say / 看任务。
	// 没有这组工具，员工只能「干等」——这正是「员工有问题不问上级」的结构性原因。
	EMPLOYEE_UNIVERSAL_TOOLS.set(runtime, [
		managementTools.whoami,
		managementTools.say,
		managementTools.ask,
		managementTools.readChannel,
		managementTools.inbox,
		managementTools.taskList,
		managementTools.taskUpdate,
		// 记忆（#12）：员工写自己的经验层，也能检索项目层/公司层。
		managementTools.memorySearch,
		managementTools.memoryWrite,
	]);

	// 注册全部角色能力包（带工具）。底层按名字解析能力包，未注册的取不到。
	if (options.registry !== undefined) {
		// 内置任务必须先注册，否则员工的后台锚点会受阻
		options.registry.install(COMPANY_TASKS_EXTENSION);
		// 圆桌讨论的任务（父任务 + 参与者子任务）同样必须注册：
		// 工具会兜底自愈式注册，但「启动就装好」能避免第一次开会撞上 missing_task。
		options.registry.install(roundtableExtension());
		// 工具搜索随每个角色的能力包一起装（见 src/company/tools/tool-search.ts）：
		// 它必须是**核心**工具，且必须支持中文查询——库里自带的那个只认 [a-z0-9]，
		// 中文查询会被切空（实测「推进项目状态」→ 一个都搜不到）。
		for (const extension of createAllRoleExtensionsWithTools(managementTools)) {
			options.registry.install(extension);
		}
		// 项目负责人能力包：整个公司只有一个 role-leader（职责描述与项目无关），
		// 项目名由会话 instructions 注入。启动时装一次，负责人会话选中它即可。
		const leaderExtension = createProjectLeaderExtension(managementTools);
		options.registry.install(leaderExtension);
		// 已终止项目的负责人切到只读能力包：重启后 repairLeaderAgents 也会按状态选它
		options.registry.install(createProjectLeaderReadOnlyExtension(managementTools));
		LEADER_TOOLSETS.set(runtime, managementTools);
	}

	// 幂等：已初始化则直接返回。
	//
	// 注意顺序：注册必须在这之前完成。registry 是内存态、不持久化，
	// 每次启动都要重新装能力包；若在早退之后注册，重启后所有角色都会
	// 失去工具（表现为「管理层什么都做不了」）。
	const existing = await runtime.harness.snapshot(CompanyDoc, context);
	if (existing !== undefined && existing.company.name !== "") {
		const roleConversations = toRoleRecord(existing.roles);
		// 路径迁移与装配层无关，必须最先做：老库里的相对 cwd 会让所有会话的
		// bash 全部报「目录不存在」（连 echo 都跑不了），这是独立于角色配置的 bug。
		await migrateWorkspacePaths(runtime, context);
		// 工作空间根是**运行参数**（这次用 --workspace 启动就以这次为准），
		// 但只在建库时写过一次。换了启动目录后不刷新，就会与项目记录对不上：
		// project_delete 的路径校验拿它当基准，会以「不在工作空间内」为由拒绝删除。
		await refreshWorkspaceRoot(runtime, options.workspaceRoot ?? process.cwd(), context);
		// 模型引用收敛：老库里的 `pi.agent.model` 是**持久化值**，不跟代码默认值走。
		// 换了默认模型却没迁移老库，所有会话就指向一个没注册进 provider 的 id，
		// 运行时表现为 `Model commandcode/<旧id> is not available`，
		// 整个公司发不出话（2026-10-27 事故）。这一步必须在上面修复之后、
		// 任何投递之前跑。
		await repairModelRefs(runtime, options, existing, context);
		if (options.registry !== undefined) {
			// 能力包已注册；这里确保已存在的会话仍指向新装的对象
			await ensureRoleAgents(runtime, roleConversations, context);
			// 员工同理：早期版本可能因能力包名冲突而丢失工具
			await ensureStaffAgents(runtime, existing, options.registry, context);
			// 负责人同理：早期版本立项时没给负责人装任何能力包，他只能空转
			await repairLeaderAgents(runtime, { taskset: managementTools, registry: options.registry }, context);
			// 上级引用收敛：指向已删除项目/未知岗位的引用回落到本项目负责人
			await repairStaffManagers(runtime, existing, context);
		}
		return {
			ownerConversationId: roleConversations.ceo,
			roleConversations,
			created: false,
			...(watchdogOption === false ? {} : { stopWatchdog: startCompanyWatchdog(runtime, watchdogOption) }),
		};
	}

	const catalog = options.modelCatalog ?? DEFAULT_MODEL_CATALOG;
	// 清单为空时用调用方给的默认模型兜底（生产由 setupModels 提供）
	const defaultModel = options.defaultModel ?? firstModel(catalog);
	const roleModels = options.roleModels ?? {};

	// 1) 老板 ↔ CEO 的通道（根会话）
	//
	// 必须显式指定能力包：底层默认选中全部已注册能力包，
	// 不指定的话 CEO 会拿到 CHRO 的招聘、CPO 的立项等所有工具（ADR-009）。
	const owner = await runtime.harness.root(context, {
		agent: {
			model: options.ownerModel ?? defaultModel,
			extensions: [createRoleExtensionWithTools("ceo", managementTools)],
			instructions: "你是这家公司的 CEO，直接向老板汇报。回答要短，给出决定而不是罗列可能性。",
		},
	});

	// 2) 六个管理层岗位（CEO 复用根会话）
	const roleConversations = {} as Record<ManagementRole, number>;
	roleConversations.ceo = Number(owner.id);

	for (const role of MANAGEMENT_ROLES) {
		if (role === "ceo") continue;
		const conversation = await runtime.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: roleModels[role] ?? defaultModel,
					extensions: [createRoleExtension(role)],
				},
			},
			context,
		);
		roleConversations[role] = Number(conversation.id);
	}

	// 3) 写公司索引与会话档案（一次提交）
	await runtime.harness.commit(async (tx) => {
		const state = await tx.doc(CompanyDoc);
		state.company.name = options.companyName;
		state.company.createdAt = Date.now();
		state.defaultModel = defaultModel;
		state.modelCatalog = [...catalog];
		state.workspaceRoot = resolveProfileWorkspace(options.workspaceRoot ?? process.cwd());
		for (const role of MANAGEMENT_ROLES) {
			state.roles[role] = roleConversations[role];
		}

		const ownerProfile = await tx.doc(ProfileDoc, owner.id);
		ownerProfile.title = "CEO";
		ownerProfile.kind = "role";
		ownerProfile.role = "ceo";

		for (const role of MANAGEMENT_ROLES) {
			if (role === "ceo") continue;
			const profile = await tx.doc(ProfileDoc, roleConversations[role] as never);
			profile.title = ROLE_LABELS[role];
			profile.kind = "role";
			profile.role = role;
		}
	}, context);

	return {
		ownerConversationId: Number(owner.id),
		roleConversations,
		created: true,
		...(watchdogOption === false ? {} : { stopWatchdog: startCompanyWatchdog(runtime, watchdogOption) }),
	};
}

/**
 * 启动看门狗（契约 §5.2）。
 *
 * 必须传**getter**而不是 runtime 实例：崩溃自愈（`watchForFailure`）会重开运行时，
 * 传实例会让看门狗盯着一个已关闭的对象，巡检全部报错、等于没有看门狗。
 *
 * 这里是「装配」而不是「实现」：阈值、收尾策略都在 `watchdog.ts`。
 *
 * @param options `true` 用默认阈值；对象则自定义；`false` 不启动
 * @returns 停止函数（幂等）；不启动时返回空操作
 */
export function startCompanyWatchdog(
	source: CompanyRuntime | (() => CompanyRuntime),
	options: boolean | WatchdogOptions = true,
): () => void {
	if (options === false) return () => undefined;
	// 必须接受 getter：崩溃自愈（watchForFailure）会 openCompany() 出一个**新对象**，
	// 把实例钉死会让看门狗自愈后每轮都对已关闭的 runtime 巡检 → 抛错 → 被吞掉 →
	// 看门狗从此静默失效，界面又开始「永远正在忙」。
	const current = typeof source === "function" ? source : () => source;
	return startWatchdog(current, options === true ? {} : options);
}

/** 项目创建选项。 */
export type CreateProjectOptions = {
	/** 项目显示名，可以是任意语言。 */
	readonly name: string;
	/**
	 * 目录标识（英文 slug）。不传则由 name 推导，但 name 含非拉丁字符时会失败。
	 * 推荐总是显式传入。
	 */
	readonly slug?: string;
	/** 需求摘要。 */
	readonly brief: string;
	/** 验收标准。 */
	readonly acceptance?: string;
	/** 工作空间根目录。 */
	readonly workspaceRoot: string;
	/** 项目负责人的模型。 */
	readonly leaderModel?: ModelRef;
	/** 项目负责人的人格描述。 */
	readonly leaderInstructions?: string;
	/** 项目负责人的名字（不传则用「负责人」）。 */
	readonly leaderName?: string;
	/**
	 * 项目负责人可用的管理工具集合。
	 *
	 * 一般不传：`bootstrapCompany` 装配时会把工具集登记到 runtime 上
	 * （见 `LEADER_TOOLSETS`），这里只给「绕过 bootstrap 直接建项目」的场景兜底。
	 * 两个来源都拿不到时，负责人不会被装能力包——那会让他没有工具、只能空转。
	 */
	readonly leaderTaskset?: ManagementToolset;
};

/** 项目创建结果。 */
export type CreateProjectResult = {
	readonly project: ProjectEntry;
};

/**
 * 创建项目：建目录、写立项文档、建项目负责人会话、登记索引。
 *
 * 失败时不留残留（目录建失败则不登记索引；索引提交失败则目录会被清理）。
 */
export async function createProject(
	runtime: CompanyRuntime,
	options: CreateProjectOptions,
	context: Context = BACKGROUND_CONTEXT,
): Promise<CreateProjectResult> {
	const { mkdir, writeFile, rm } = await import("node:fs/promises");
	const { join, resolve } = await import("node:path");
	const { projectSlug } = await import("../runtime/ids.ts");

	const slug = projectSlug(options.slug ?? options.name);
	// 必须是绝对路径：会话的 cwd 会原样交给执行环境，而执行环境会把相对 cwd
	// 与进程目录再拼一次（NodeExecutionEnv.exec 的 resolvePath），
	// 结果是 `<进程目录>/<相对 cwd>/<相对 cwd>` —— 目录不存在，bash 全部报
	// 「Working directory does not exist」，员工连 echo 都跑不了。
	const workspace = resolve(options.workspaceRoot, slug);

	// 1) 建目录（已存在则复用）
	await mkdir(workspace, { recursive: true });

	// 2) 写立项文档
	const briefPath = join(workspace, "PROJECT.md");
	await writeFile(briefPath, renderProjectBrief(options), "utf8");

	// 3) 建项目负责人会话 + 登记索引（一次提交）
	try {
		const state = await runtime.harness.snapshot(CompanyDoc, context);
		const leaderModel = options.leaderModel ?? state?.defaultModel ?? firstModel(DEFAULT_MODEL_CATALOG);
		// 负责人能力包：优先用调用方显式给的，否则用装配时登记的全局工具集。
		const taskset = options.leaderTaskset ?? LEADER_TOOLSETS.get(runtime);
		const leaderExtension = taskset === undefined ? undefined : createProjectLeaderExtension(taskset);

		const leader = await runtime.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: leaderModel,
					instructions: options.leaderInstructions ?? projectLeaderCharter(options.name),
					// 负责人必须有管理能力，否则他无法派活、无法上报、无法写计划，
					// 项目实际就由管理层越级直管了（见 createProjectLeaderExtension）。
					...(leaderExtension === undefined ? {} : { extensions: [leaderExtension] }),
					cwd: workspace,
				},
			},
			context,
		);

		const project: ProjectEntry = {
			slug,
			name: options.name,
			workspace,
			leader: Number(leader.id),
			leaderName: options.leaderName ?? "负责人",
			status: "planning",
			// `brief` 在类型上是必填的 string：**不能写成 `brief: options.brief`**——
			// 调用方不传时值是 `undefined`，chord 的 `copyJson` 会抛
			// `Value contains a non-JSON undefined; expected strict JSON`，整个立项
			// 在最后一步提交时失败，而目录和会话已经建好了（留下孤儿）。
			brief: options.brief ?? "",
			createdAt: Date.now(),
		};

		await runtime.harness.commit(async (tx) => {
			const company = await tx.doc(CompanyDoc);
			company.projects[slug] = project;

			const profile = await tx.doc(ProfileDoc, leader.id);
			profile.title = options.leaderName ?? options.name;
			profile.kind = "project";
			profile.project = slug;
			profile.workspace = workspace;
		}, context);

		// 新项目立刻建项目群并让负责人就位（同 hireStaff：不能等下次发消息才自愈）
		try {
			const { ensureAllChannels } = await import("./channels.ts");
			await ensureAllChannels(runtime, context);
		} catch (error) {
			console.warn(`[createProject] 项目群建立失败（下次启动会自愈）：${String(error)}`);
		}

		return { project };
	} catch (error) {
		// 索引提交失败：清理刚建的目录，避免留下孤儿工作空间
		await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

/** 项目负责人的管理工具集：由装配层传入，也可在运行时按项目临时解析。 */
export type ProjectLeaderTaskset = import("./tools.ts").ManagementToolset;

/**
 * 给已存在的项目负责人补装管理能力包。
 *
 * 老版本立项时没有给负责人装任何能力包，他没有任何工具，只能空转
 * （真实事故里负责人全程 0 token，活全被管理层越过他直接派给员工）。
 * 这里按项目名重建 `role-leader` 能力包并让负责人会话选中它，幂等。
 *
 * 路径问题由 `migrateWorkspacePaths` 处理，与本函数无关。
 *
 * @returns 补装能力包的负责人会话数
 */
export async function repairLeaderAgents(
	runtime: CompanyRuntime,
	options: { readonly taskset?: ProjectLeaderTaskset; readonly registry?: Registry } = {},
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	if (options.taskset === undefined) return 0;

	const state = await runtime.harness.snapshot(CompanyDoc, context);
	if (state === undefined) return 0;

	let repaired = 0;
	for (const project of Object.values(state.projects)) {
		const conversation = await runtime.harness.conversation(project.leader as never, context);
		if (conversation === undefined) continue;

		// 负责人能力包是全局唯一的：active 用 role-leader，terminated 用只读版。
		// 只读版必须在启动修复时也生效，否则重启一次就把终止项目的执行权限还回去了。
		const terminated = project.status === "terminated";
		const extension = terminated
			? createProjectLeaderReadOnlyExtension(options.taskset)
			: createProjectLeaderExtension(options.taskset);
		const agent = await conversation.agent(context);

		// 注意不能只判「列表里有 role-leader」：负责人会话过去没显式选过能力包，
		// 底层的默认语义是「选中全部已注册能力包」，那样列表里也有 role-leader，
		// 但他同时还带着 CHRO 的招聘、CPO 的立项——看起来修好了，其实越权还在。
		const selectedOnly = agent.extensions.length === 1 && agent.extensions[0]?.name === extension.name;
		const expectedInstructions = terminated
			? [`你是「${project.name}」项目的负责人（项目已终止）。`, PROJECT_LEADER_READONLY_CHARTER].join("\n")
			: projectLeaderCharter(project.name);
		const instructionsStale = agent.instructions !== expectedInstructions;
		if (selectedOnly && !instructionsStale) continue;

		await conversation.configure(
			{
				extensions: [extension],
				instructions: expectedInstructions,
			},
			context,
		);
		repaired += 1;
	}
	return repaired;
}

/**
 * 把已存在会话的工作目录从相对路径迁移成绝对路径。
 *
 * 与 `repairLeaderAgents` 分开：这个不需要装配层（不需要工具集），
 * 只要库里有项目就能跑，所以任何入口（网页、终端、测试）都可以调。
 * 不修的话，历史项目里的负责人和员工 bash 全部报「目录不存在」。
 *
 * @returns 迁移的会话数
 */
export async function migrateWorkspacePaths(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	if (state === undefined) return 0;

	const workspaceOf = new Map<string, string>();
	for (const project of Object.values(state.projects)) {
		workspaceOf.set(project.slug, resolveProfileWorkspace(project.workspace));
	}
	if (workspaceOf.size === 0) return 0;

	// ① 索引：相对路径写回绝对路径
	const dirty = Object.values(state.projects).some((project) => !isAbsolute(project.workspace));
	if (dirty) {
		await runtime.harness.commit(async (tx) => {
			const company = await tx.doc(CompanyDoc);
			for (const [slug, workspace] of workspaceOf) {
				const entry = company.projects[slug];
				if (entry === undefined || isAbsolute(entry.workspace)) continue;
				company.projects[slug] = { ...entry, workspace };
			}
		}, context);
	}

	const targets: number[] = [];
	for (const project of Object.values(state.projects)) targets.push(project.leader);
	// 归档员工也要修：项目恢复时他们还会被启用，留着相对路径就是留一颗雷。
	for (const person of Object.values(state.staff)) targets.push(person.conversationId);

	let migrated = 0;
	for (const id of new Set(targets)) {
		const conversation = await runtime.harness.conversation(id as never, context);
		if (conversation === undefined) continue;
		const agent = await conversation.agent(context);
		const cwd = agent.cwd;
		if (cwd === undefined || isAbsolute(cwd)) continue;
		await conversation.configure({ cwd: resolveProfileWorkspace(cwd) }, context);
		migrated += 1;
	}
	return migrated;
}

/** 招聘选项。 */
export type HireStaffOptions = {
	readonly project: string;
	/** 员工可用的执行类工具；默认空（最严格）。 */
	readonly employeeTools?: readonly ReturnType<typeof defineTool>[];
	/** 能力注册表。传入后会把员工能力包注册进去，否则员工拿不到工具。 */
	readonly registry?: Registry;
	readonly name: string;
	/** 员工角色（产品 / 设计 / 开发 / 测试 …）。名册上的标签，不决定能力。 */
	readonly role: string;
	/** 要授予的原子工具名（read / write / edit / bash）。不传则不授予执行工具。 */
	readonly tools?: readonly string[];
	/** 职责：一段自由文本，拼进员工提示词。不传则只有通用纪律。 */
	readonly duty?: string;
	/** 指定模型；不传则用公司默认模型。 */
	readonly model?: ModelRef;
	/** 直属上级：管理层岗位，或 `leader:<本项目slug>`。不传默认本项目负责人。 */
	readonly manager?: string;
	/** 额外职责描述，追加到职责描述之后。 */
	readonly instructions?: string;
};

/** 招聘结果。 */
export type HireStaffResult = {
	readonly staff: StaffEntry;
	readonly conversationId: number;
};

/**
 * 招聘项目员工。
 *
 * 关键点：员工的归属是一个 `background: true` 的后台任务（ADR-005），
 * 这样老板中断管理层时不会波及员工。员工的职责描述由角色模板预设（问题 3 的答案）。
 */
export async function hireStaff(
	runtime: CompanyRuntime,
	options: HireStaffOptions,
	context: Context = BACKGROUND_CONTEXT,
): Promise<HireStaffResult> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	if (state === undefined) throw new Error("公司尚未初始化");

	const project = state.projects[options.project];
	if (project === undefined) throw new Error(`项目不存在：${options.project}`);

	const key = `${options.project}/${options.name}`;
	const existing = state.staff[key];
	if (existing !== undefined) {
		return { staff: existing, conversationId: existing.conversationId };
	}

	// 模型必须来自公司清单：给一个不在清单里的模型会导致 no_model
	const model = options.model ?? state.defaultModel;
	if (state.modelCatalog.length > 0) {
		const known = state.modelCatalog.some(
			(option) => option.provider === model.provider && option.modelId === model.modelId,
		);
		if (!known) {
			throw new Error(
				`模型 ${model.provider}/${model.modelId} 不在公司模型清单里。可用的有：${state.modelCatalog.map((option) => option.id).join(", ")}`,
			);
		}
	}

	// 建后台锚点任务 + 员工会话 + 登记名册，全部在一次提交内完成。
	// 会话级提交必须绑定一个会话，这里绑定到项目负责人（锚点任务也归它所属）。
	const leader = await runtime.harness.conversation(project.leader as never, context);
	if (leader === undefined) throw new Error(`项目负责人会话不存在：${project.leader}`);

	// 直属上级：默认本项目负责人。校验放在写库之前，避免留下半个非法名册。
	const manager = (options.manager ?? `${LEADER_REF_PREFIX}${options.project}`) as ManagerRef;
	if (!isValidManagerRef(state, manager, options.project)) {
		throw new Error(
			`非法直属上级：${manager}。只能是管理层岗位（${MANAGEMENT_ROLES.join(" / ")}）或本项目负责人 leader:${options.project}`,
		);
	}

	// 能力由显式声明的 tools 决定；角色名不再参与推断——按角色查表正是
	// 「招个『前端』拿到只读员工、不报错不日志」那个 bug 的来源。
	// 同时追加「向直属上级上报」的能力——没有它，员工只能干等。
	const toolNames = options.tools ?? [];
	const employeeTools = options.employeeTools ?? employeeToolsFor(runtime, toolNames);

	const employeeExtension = createEmployeeExtension(
		`${options.project}/${options.name}`,
		employeeTools,
		employeeUniversalTools(runtime),
	);

	// 能力包必须注册进 registry：底层按名字存选择，未注册的解析不到，
	// 表现为「员工没有任何工具」（这正是 ADR-009 的另一个侧面）。
	options.registry?.install(employeeExtension);
	// 锚点任务同样要注册，否则新建的员工会立刻受阻
	options.registry?.install(COMPANY_TASKS_EXTENSION);

	const conversationId = await leader.commit(async (tx) => {
		const anchor = await tx.createTask(AnchorTask, null, {
			ownership: { kind: "conversation" },
			background: true,
			conversationId: project.leader as never,
		});

		const conversation = await tx.createConversation({
			ownership: { kind: "task", taskId: anchor },
		});

		// 必须显式指定能力包：底层默认选中全部已注册能力包，
		// 那样员工会拿到管理工具，等于越级（ADR-004）。
		await configure(tx, conversation.id, { extensions: [employeeExtension] });

		// 上级关系只存一处：CompanyDoc 的 staff.manager。
		// ProfileDoc 以前也写过一份 parent，但它没有任何读取者，只会制造第二真相源。
		const profile = await tx.doc(ProfileDoc, conversation.id);
		profile.title = options.name;
		profile.kind = "staff";
		profile.project = options.project;
		profile.workspace = project.workspace;
		profile.role = options.role;

		const company = await tx.doc(CompanyDoc);
		company.staff[key] = {
			name: options.name,
			role: options.role,
			duty: options.duty ?? "",
			tools: [...toolNames],
			conversationId: Number(conversation.id),
			project: options.project,
			manager,
			model,
			hiredAt: Date.now(),
			archived: false,
		};

		return Number(conversation.id);
	}, context);

	// 提交后再配置 agent（configure 自己会开一次提交，不能在 commit 回调里调）
	await runtime.harness
		.conversation(conversationId as never, context)
		.then((conversation) =>
			conversation?.configure(
				{
					model,
					instructions: buildStaffInstructions(state, options, manager),
					// 老库里的 workspace 可能是相对路径，统一解析成绝对路径再下发
					cwd: resolveProfileWorkspace(project.workspace),
				},
				context,
			),
		);

	const latest = await runtime.harness.snapshot(CompanyDoc, context);
	const staff = latest?.staff[key];
	if (staff === undefined) throw new Error(`招聘后未能读回员工记录：${key}`);

	// 就地入群。**不能等「下次有人发消息时自愈」**：新员工加入之前，任何
	// `@新员工` 都会在 `parseMentions` 里被「只保留频道成员」过滤掉，一个人都
	// 不唤醒，而界面上看不出异常（真实事故见 `shouldBeIn()` 的注释）。
	// 这里是幂等的：已存在的成员不会重复加。
	try {
		const { ensureAllChannels } = await import("./channels.ts");
		await ensureAllChannels(runtime, context);
	} catch (error) {
		// 入群失败不能让招聘本身失败：员工已经建好了，下次启动还会自愈。
		console.warn(`[hireStaff] 员工 ${key} 入群失败（下次启动会自愈）：${String(error)}`);
	}

	return { staff, conversationId };
}

/** 归档员工（软删）。 */
export async function archiveStaff(
	runtime: CompanyRuntime,
	project: string,
	name: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<boolean> {
	const key = `${project}/${name}`;
	return runtime.harness.commit(async (tx) => {
		const company = await tx.doc(CompanyDoc);
		const staff = company.staff[key];
		if (staff === undefined) return false;
		company.staff[key] = { ...staff, archived: true };
		company.archived.push(staff.conversationId);
		return true;
	}, context);
}

// ── 员工上级变更 / 项目状态 / 迁移 ──────────────────────────────────────────

/** 上级变更结果。 */
export type ReassignStaffResult = { readonly ok: boolean; readonly message: string };

/**
 * 变更已招员工的直属上级。
 *
 * 两件事必须一起做，否则会出现「索引改了、提示词没改」：
 * 1. 改公司索引里的 staff.manager（唯一真相源）；
 * 2. 重新渲染该员工的职责描述（提示词里写着「直属上级是 XXX」）。
 *
 * 索引写是单事务；提示词重渲染是第二段，失败时下次启动由 repairStaffInstructions 收敛。
 */
export async function reassignStaff(
	runtime: CompanyRuntime,
	input: {
		readonly project: string;
		readonly name: string;
		readonly manager: string;
		readonly by: string;
		readonly fromConversationId: number;
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<ReassignStaffResult> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	if (state === undefined) return { ok: false, message: "公司尚未初始化。" };

	const key = `${input.project}/${input.name}`;
	const person = state.staff[key];
	if (person === undefined) {
		return { ok: false, message: `项目 ${input.project} 里没有名为「${input.name}」的员工。` };
	}
	if (person.archived) {
		return { ok: false, message: `员工「${input.name}」已归档，不能再改直属上级。` };
	}

	const manager = input.manager.trim();
	if (!isValidManagerRef(state, manager, input.project)) {
		return {
			ok: false,
			message: `非法直属上级：${manager}。只能是管理层岗位（${MANAGEMENT_ROLES.join(" / ")}）或本项目负责人 ${LEADER_REF_PREFIX}${input.project}。`,
		};
	}
	if (person.manager === manager) {
		return { ok: true, message: `${input.name} 的直属上级已经是 ${managerLabelOf(state, person.manager)}，未做改动。` };
	}

	const before = managerLabelOf(state, person.manager);
	const after = managerLabelOf(state, manager as ManagerRef);
	const actor = labelOfConversation(state, input.fromConversationId) ?? input.by;

	await runtime.harness.commit(async (tx) => {
		const company = await tx.doc(CompanyDoc);
		const entry = company.staff[key];
		if (entry === undefined) return;
		company.staff[key] = { ...entry, manager: manager as ManagerRef };

		const audit = await tx.doc(AuditDoc, input.fromConversationId as never);
		audit.events.push({
			at: Date.now(),
			type: "staff-manager-change",
			from: before,
			to: after,
			note: `${input.name}（${input.project}）的直属上级：${before} → ${after}；执行者：${actor}`.slice(0, 200),
			ref: `staff:${key}`,
		});
	}, context);

	await syncStaffInstructions(runtime, key, context);

	return { ok: true, message: `已把 ${input.name} 的直属上级改为 ${after}（原：${before}）。` };
}

// ── 员工改名 ────────────────────────────────────────────────────────────────

/** 改名结果。 */
export type RenameStaffResult = { readonly ok: boolean; readonly message: string };

/** 员工名允许的最大长度（中文名按字符算，卡片与名册都要放得下）。 */
const STAFF_NAME_MAX_CHARS = 32;

/**
 * 给在职员工改名。
 *
 * 名字在这个系统里**不是展示字段，是身份的一部分**：
 * - 名册键 `${project}/${name}`（`CompanyDoc.staff`）
 * - 员工能力包名 `role-employee:${project}/${name}`（底层注册表按名字解析）
 * - `ProfileDoc.title`（界面与职工档案显示名）
 *
 * 所以必须三处一起改，并重建能力包。只改名册会造成「能力包按旧名字解析不到」，
 * 员工下一轮就没有任何工具——这就是 ADR-009 记录过的老坑（员工能力包重名/丢失）。
 *
 * 历史对话、审计记录里的旧名字一律保留：那是当时的事实，改了才是伪造。
 */
export async function renameStaff(
	runtime: CompanyRuntime,
	input: {
		readonly project: string;
		readonly name: string;
		readonly newName: string;
		/** 执行者名字（审计用；取不到时落会话标识）。 */
		readonly by: string;
		/** 发起改名的会话：审计写进它的审计文档。 */
		readonly fromConversationId: number;
		/** 能力注册表：传入才能把重建后的员工能力包装进去。 */
		readonly registry?: Registry;
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<RenameStaffResult> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	if (state === undefined) return { ok: false, message: "公司尚未初始化。" };

	const project = state.projects[input.project];
	if (project === undefined) return { ok: false, message: `项目不存在：${input.project}` };

	const oldName = input.name.trim();
	const newName = input.newName.trim();
	const key = `${input.project}/${oldName}`;
	const person = state.staff[key];
	if (person === undefined) {
		const names = Object.values(state.staff)
			.filter((entry) => entry.project === input.project && !entry.archived)
			.map((entry) => entry.name);
		return {
			ok: false,
			message: `项目 ${input.project} 里没有名为「${oldName}」的员工。${names.length === 0 ? "" : `现有员工：${names.join("、")}`}`,
		};
	}
	if (person.archived) return { ok: false, message: `员工「${oldName}」已归档，不能改名。` };

	// 名字要拼进名册键，带 / 会把键拆错；空白与控制字符会弄乱提示词与卡片。
	if (newName === "") return { ok: false, message: "新名字不能为空。" };
	if (/[/\\\s\u0000-\u001f]/.test(newName)) {
		return { ok: false, message: `新名字「${newName}」不合法：不能包含 / 、反斜杠、空白或控制字符。` };
	}
	if ([...newName].length > STAFF_NAME_MAX_CHARS) {
		return { ok: false, message: `新名字太长（最多 ${STAFF_NAME_MAX_CHARS} 个字符）。` };
	}
	if (newName === oldName) return { ok: true, message: `员工已经叫「${oldName}」，未做改动。` };

	const newKey = `${input.project}/${newName}`;
	if (state.staff[newKey] !== undefined) {
		return {
			ok: false,
			message: `项目 ${input.project} 里已经有叫「${newName}」的员工（含已归档），换一个名字。`,
		};
	}

	const actor = labelOfConversation(state, input.fromConversationId) ?? input.by;

	// 第一段：名册键 + 档案标题 + 审计，单事务。
	await runtime.harness.commit(async (tx) => {
		const company = await tx.doc(CompanyDoc);
		const entry = company.staff[key];
		if (entry === undefined) return;
		delete company.staff[key];
		company.staff[newKey] = { ...entry, name: newName };

		const profile = await tx.doc(ProfileDoc, entry.conversationId as never);
		profile.title = newName;

		const audit = await tx.doc(AuditDoc, input.fromConversationId as never);
		audit.events.push({
			at: Date.now(),
			type: "staff-rename",
			from: oldName,
			to: newName,
			note: `${oldName} → ${newName}（${input.project}）；执行者：${actor}`.slice(0, 200),
			ref: `staff:${newKey}`,
		});
	}, context);

	// 第二段：重建能力包并让会话选中它。
	// 失败不回滚名册（名册是真相源），下次启动由 ensureStaffAgents 按新名字重建。
	const conversation = await runtime.harness.conversation(person.conversationId as never, context);
	if (conversation !== undefined) {
		const extension = createEmployeeExtension(
			newKey,
			// 旧记录可能没有 tools 字段（本次改动之前招的人），按「不授予执行工具」处理。
			employeeToolsFor(runtime, person.tools ?? []),
			employeeUniversalTools(runtime),
		);
		input.registry?.install(extension);
		await conversation.configure({ extensions: [extension] }, context);
	}

	return {
		ok: true,
		message: `已把 ${oldName} 改名为 ${newName}（项目 ${project.name}）。名册、职工档案与工具能力包已同步，历史记录保留原名。`,
	};
}

/** 项目状态的合法迁移边。终止走 terminateProject，不在这里。 */
const PROJECT_STATUS_EDGES: Record<ProjectStatus, readonly ProjectStatus[]> = {
	planning: ["active"],
	active: ["paused", "done"],
	paused: ["active", "done"],
	done: [],
	terminated: [],
	archived: [],
};

/**
 * 推进项目状态（planning → active → paused/done）。
 *
 * 幂等：目标与当前相同直接成功、不写事件。
 * 越权：只有本项目负责人可以推进自己项目，管理层可推进任意项目；其他会话一律拒绝。
 * 终止是单独的两步流程（terminateProject），这里不接受 terminated。
 */
export async function setProjectStatus(
	runtime: CompanyRuntime,
	input: {
		readonly project: string;
		readonly to: string;
		readonly by: string;
		readonly fromConversationId: number;
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ ok: boolean; message: string; error?: string }> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	if (state === undefined) return { ok: false, error: "E_NOT_READY", message: "公司尚未初始化。" };

	const project = state.projects[input.project];
	if (project === undefined) {
		return { ok: false, error: "E_NOT_FOUND", message: `项目不存在：${input.project}` };
	}

	const to = input.to as ProjectStatus;
	if (to === "terminated") {
		return { ok: false, error: "E_USE_TERMINATE", message: "终止项目请用 project_terminate（它还会停活在跑的任务、归档员工）。" };
	}
	if (!(to in PROJECT_STATUS_EDGES)) {
		return { ok: false, error: "E_INVALID_TRANSITION", message: `未知项目状态：${input.to}` };
	}
	if (project.status === to) {
		return { ok: true, message: `项目「${project.name}」已经是 ${to}，未做改动。` };
	}

	const allowed = PROJECT_STATUS_EDGES[project.status] ?? [];
	if (!allowed.includes(to)) {
		return {
			ok: false,
			error: "E_INVALID_TRANSITION",
			message: `不允许的状态迁移：${project.status} → ${to}。允许：${allowed.length === 0 ? "（终态，不能变更）" : allowed.join(" / ")}`,
		};
	}

	const managementIds = Object.values(state.roles).map(Number);
	const isLeader = project.leader === input.fromConversationId;
	const isManagement = managementIds.includes(input.fromConversationId);
	if (!isLeader && !isManagement) {
		return {
			ok: false,
			error: "E_FORBIDDEN",
			message: "只有本项目负责人或管理层能把项目推进到该状态。",
		};
	}

	const before = project.status;
	await runtime.harness.commit(async (tx) => {
		const company = await tx.doc(CompanyDoc);
		const current = company.projects[input.project];
		if (current === undefined) return;
		company.projects[input.project] = { ...current, status: to };

		const audit = await tx.doc(AuditDoc, input.fromConversationId as never);
		audit.events.push({
			at: Date.now(),
			type: "project-status",
			from: before,
			to,
			note: `项目「${current.name}」状态：${before} → ${to}`,
			ref: `project:${input.project}`,
		});
	}, context);

	return { ok: true, message: `项目「${project.name}」状态已从 ${before} 改为 ${to}。` };
}

/**
 * 把指定项目里「上级还是岗位」的员工迁到「本项目负责人」名下。
 *
 * 迁移不升 CompanyDoc 版本（形状仍是字符串），可重复执行：已经是负责人引用的
 * 员工会被跳过，第二次返回 migrated = 0。dry-run 只报告、不写库。
 */
export async function migrateStaffManagers(
	runtime: CompanyRuntime,
	options: {
		readonly project: string;
		/** 只迁这些员工；不传则迁该项目全部未归档员工。 */
		readonly staff?: readonly string[];
		readonly dryRun?: boolean;
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ migrated: number; skipped: number; details: string[] }> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	if (state === undefined) throw new Error("公司尚未初始化。");
	const project = state.projects[options.project];
	if (project === undefined) throw new Error(`项目不存在：${options.project}`);

	const wanted = options.staff === undefined ? undefined : new Set(options.staff);
	const details: string[] = [];
	const targets: { key: string; name: string; from: string }[] = [];

	for (const [key, person] of Object.entries(state.staff)) {
		if (person.project !== options.project) continue;
		if (person.archived) continue;
		if (wanted !== undefined && !wanted.has(person.name)) continue;
		if (isLeaderManagerRef(person.manager)) continue;
		targets.push({ key, name: person.name, from: person.manager });
	}

	const target: ManagerRef = `${LEADER_REF_PREFIX}${options.project}`;
	for (const item of targets) {
		details.push(`${item.name}：${item.from} → ${target}`);
	}

	if (options.dryRun === true) {
		return { migrated: 0, skipped: targets.length, details };
	}

	if (targets.length > 0) {
		await runtime.harness.commit(async (tx) => {
			const company = await tx.doc(CompanyDoc);
			for (const item of targets) {
				const entry = company.staff[item.key];
				if (entry === undefined) continue;
				company.staff[item.key] = { ...entry, manager: target };
			}
		}, context);
		for (const item of targets) await syncStaffInstructions(runtime, item.key, context);
	}

	return { migrated: targets.length, skipped: 0, details };
}

/** 重渲染某个员工的职责描述（上级变了以后必须做）。 */
export async function syncStaffInstructions(
	runtime: CompanyRuntime,
	staffKey: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<boolean> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	const person = state?.staff[staffKey];
	if (state === undefined || person === undefined) return false;

	const conversation = await runtime.harness.conversation(person.conversationId as never, context);
	if (conversation === undefined) return false;

	await conversation.configure(
		{
			instructions: staffInstructionsFor(state, {
				duty: person.duty ?? "",
				projectName: person.project,
				manager: person.manager,
			}),
		},
		context,
	);
	return true;
}

/**
 * 启动时的收敛修复：上级引用失效（指向已删除项目、未知岗位）的员工，
 * 回落到本项目负责人（项目不存在则回落 CEO），并留审计。
 *
 * 只修补「非法引用」，不改变合法的人工配置——迁移是显式动作，不在启动时偷偷做。
 */
async function repairStaffManagers(
	runtime: CompanyRuntime,
	state: CompanyState,
	context: Context,
): Promise<number> {
	const broken = Object.entries(state.staff).filter(
		([, person]) => !person.archived && !isValidManagerRef(state, person.manager, person.project),
	);
	if (broken.length === 0) return 0;

	const fallbackOf = (projectSlug: string): ManagerRef => {
		const project = state.projects[projectSlug];
		return project === undefined ? "ceo" : `${LEADER_REF_PREFIX}${projectSlug}`;
	};

	await runtime.harness.commit(async (tx) => {
		const company = await tx.doc(CompanyDoc);
		for (const [key, person] of broken) {
			const entry = company.staff[key];
			if (entry === undefined) continue;
			company.staff[key] = { ...entry, manager: fallbackOf(entry.project) };
		}
	}, context);

	for (const [key, person] of broken) {
		await syncStaffInstructions(runtime, key, context);
		void person;
	}
	return broken.length;
}

/**
 * 终止项目。
 *
 * 做四件事：
 * 1. 中断项目负责人与全部员工正在跑的活（穿透后台边界）
 * 2. 项目状态改为 terminated，记录谁、为什么、什么时候
 * 3. 员工全部归档
 * 4. 写审计与沟通留痕
 *
 * 数据不删：会话、对话历史、产出文件都保留，只是不再推进。
 */
export async function terminateProject(
	runtime: CompanyRuntime,
	input: {
		readonly project: string;
		readonly reason: string;
		readonly by: string;
		/** 谁发起终止的会话，用于留痕。 */
		readonly fromConversationId: number;
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ ok: boolean; stoppedConversations: number; archivedStaff: number; message: string }> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	const project = state?.projects[input.project];

	if (project === undefined) {
		return { ok: false, stoppedConversations: 0, archivedStaff: 0, message: `项目不存在：${input.project}` };
	}
	if (project.status === "terminated") {
		return { ok: false, stoppedConversations: 0, archivedStaff: 0, message: `项目已经终止过了：${project.name}` };
	}

	// 1) 先停活：负责人 + 全部员工，穿透后台边界（员工挂在后台任务上）
	const staff = Object.values(state?.staff ?? {}).filter(
		(person) => person.project === input.project && !person.archived,
	);
	const targets = [project.leader, ...staff.map((person) => person.conversationId)];

	let stopped = 0;
	for (const conversationId of targets) {
		const conversation = await runtime.harness.conversation(conversationId as never, context);
		if (conversation === undefined) continue;
		try {
			await conversation.abort(context, { background: true });
			stopped += 1;
		} catch {
			// 单个会话停不下来不阻塞终止流程
		}
	}

	// 2) 改状态 + 归档员工 + 留痕，一次提交
	await runtime.harness.commit(async (tx) => {
		const company = await tx.doc(CompanyDoc);
		const current = company.projects[input.project];
		if (current !== undefined) {
			company.projects[input.project] = {
				...current,
				status: "terminated",
				terminated: { at: Date.now(), by: input.by, reason: input.reason },
			};
		}

		for (const person of staff) {
			const key = `${person.project}/${person.name}`;
			const entry = company.staff[key];
			if (entry !== undefined) company.staff[key] = { ...entry, archived: true };
			if (!company.archived.includes(person.conversationId)) {
				company.archived.push(person.conversationId);
			}
		}

		// 审计：记在发起方会话上
		const audit = await tx.doc(AuditDoc, input.fromConversationId as never);
		audit.events.push({
			at: Date.now(),
			type: "archive",
			from: input.by,
			to: input.project,
			note: `终止项目：${input.reason}`.slice(0, 200),
			ref: `terminate:${input.project}`,
		});

		// 沟通留痕
		const trail = await tx.doc(TrailDoc);
		trail.edges.push({
			at: Date.now(),
			kind: "archive",
			fromConversation: input.fromConversationId,
			toConversation: project.leader,
			from: input.by,
			to: project.name,
			ref: `terminate:${input.project}`,
			project: input.project,
		});

		// 清掉该项目挂着的待决问题：项目都没了，不该再有它的待办
		const { PendingDoc } = await import("./escalation.ts");
		const pending = await tx.doc(PendingDoc);
		for (let index = 0; index < pending.items.length; index += 1) {
			const item = pending.items[index];
			if (item === undefined) continue;
			if (item.project !== input.project || item.answer !== undefined) continue;
			pending.items[index] = {
				...item,
				answer: "项目已终止，本条待办自动关闭",
				answeredBy: "system",
			};
		}
	}, context);

	// 权限随状态回收：终止后负责人换成只读能力包，只剩「看与上报」。
	// 只靠提示词约束不可靠（ADR-004/010：权限=工具在不在），所以换能力包。
	const taskset = LEADER_TOOLSETS.get(runtime);
	const leaderConversation = await runtime.harness.conversation(project.leader as never, context);
	if (taskset !== undefined && leaderConversation !== undefined) {
		await leaderConversation
			.configure(
				{
					extensions: [createProjectLeaderReadOnlyExtension(taskset)],
					instructions: [
						`你是「${project.name}」项目的负责人（项目已终止）。`,
						PROJECT_LEADER_READONLY_CHARTER,
					].join("\n"),
				},
				context,
			)
			.catch(() => undefined);
	}

	return {
		ok: true,
		stoppedConversations: stopped,
		archivedStaff: staff.length,
		message: `项目「${project.name}」已终止：停了 ${stopped} 个会话，归档 ${staff.length} 名员工。原因：${input.reason}`,
	};
}

/**
 * 彻底删除项目：项目记录、员工名册、工作空间里的全部产物。
 *
 * 前提：项目必须已经是「已终止」。这是有意的两步设计——
 * 先终止（可回看的软停），老板明确同意后再删除（不可逆）。
 *
 * 能删的：项目索引、员工名册、磁盘上的工作空间目录、相关待办。
 * 不能删的：会话与对话历史——底层库没有删除 API。它们保留在存储里，
 * 但从组织视图与名册中移除后不再可见。
 */
export async function deleteProject(
	runtime: CompanyRuntime,
	input: {
		readonly project: string;
		readonly by: string;
		readonly fromConversationId: number;
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<{
	ok: boolean;
	removedStaff: number;
	removedFiles: number;
	workspace: string;
	message: string;
}> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	const project = state?.projects[input.project];

	if (project === undefined) {
		return { ok: false, removedStaff: 0, removedFiles: 0, workspace: "", message: `项目不存在：${input.project}` };
	}
	// 必须先终止再删除：避免一句话就把正在跑的项目连根拔掉
	if (project.status !== "terminated") {
		return {
			ok: false,
			removedStaff: 0,
			removedFiles: 0,
			workspace: project.workspace,
			message: `项目「${project.name}」还没终止。请先终止，确认后再删除。`,
		};
	}

	// 1) 删磁盘产物——必须先校验路径
	//
	// 这里是 rm -rf，目标来自数据库。若数据库里的路径被改错、或者项目被搬到
	// 别处，盲目删除可能删掉无关目录。所以要求：
	//   a. 路径必须落在公司的工作空间根目录下
	//   b. 目录名必须等于项目 slug
	// 两条任一不满足就不删文件，并明确告知老板。
	const { rm, readdir } = await import("node:fs/promises");
	const { resolve, basename, sep } = await import("node:path");

	const workspacePath = resolve(project.workspace);
	const rootPath = resolve(state?.workspaceRoot ?? "");
	const insideRoot = rootPath !== "" && workspacePath.startsWith(rootPath + sep);
	const nameMatches = basename(workspacePath) === project.slug;

	if (!insideRoot || !nameMatches) {
		return {
			ok: false,
			removedStaff: 0,
			removedFiles: 0,
			workspace: project.workspace,
			message: [
				`拒绝删除：项目工作空间路径校验未通过。`,
				`  记录路径：${project.workspace}`,
				`  工作空间根：${state?.workspaceRoot ?? "(未记录)"}`,
				`  目录名应为：${project.slug}`,
				`文件没有动。请人工确认后处理。`,
			].join("\n"),
		};
	}

	let removedFiles = 0;
	try {
		removedFiles = await countFiles(workspacePath, readdir);
		await rm(workspacePath, { recursive: true, force: true });
	} catch {
		// 目录本就不在也不算失败
	}


	// 2) 删索引与名册
	const staff = Object.values(state?.staff ?? {}).filter((person) => person.project === input.project);

	await runtime.harness.commit(async (tx) => {
		const company = await tx.doc(CompanyDoc);
		delete company.projects[input.project];
		for (const person of staff) {
			delete company.staff[`${person.project}/${person.name}`];
		}

		// 审计：删除这件事本身要留痕
		const audit = await tx.doc(AuditDoc, input.fromConversationId as never);
		audit.events.push({
			at: Date.now(),
			type: "archive",
			from: input.by,
			to: input.project,
			note: `彻底删除项目「${project.name}」（${staff.length} 名员工，${removedFiles} 个文件）`.slice(0, 200),
			ref: `delete:${input.project}`,
		});

		const trail = await tx.doc(TrailDoc);
		trail.edges.push({
			at: Date.now(),
			kind: "archive",
			fromConversation: input.fromConversationId,
			toConversation: project.leader,
			from: input.by,
			to: project.name,
			ref: `delete:${input.project}`,
			project: input.project,
		});
	}, context);

	return {
		ok: true,
		removedStaff: staff.length,
		removedFiles,
		workspace: project.workspace,
		message: `项目「${project.name}」已彻底删除：移除 ${staff.length} 名员工、删除 ${removedFiles} 个产物文件。会话历史按底层限制保留在存储中，但已不再显示。`,
	};
}

/** 数一个目录下的文件数（递归），用于告诉老板删掉了多少东西。 */
/**
 * 用本次启动的工作空间根刷新公司索引。
 *
 * 根目录是运行参数：同一份库可以从不同 `--workspace` 启动。老实现只在
 * 建库时写一次，之后换目录启动就会与项目记录脱节——`project_delete` 用
 * 这条根做「目录必须在我管辖范围内」的校验，于是永久拒绝删除，只能人工处理。
 * 只刷新根，不动已有项目记录（它们各自记录自己的绝对路径）。
 */
async function refreshWorkspaceRoot(
	runtime: CompanyRuntime,
	workspaceRoot: string,
	context: Context,
): Promise<boolean> {
	const next = resolveProfileWorkspace(workspaceRoot);
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	if (state === undefined) return false;
	if (state.workspaceRoot === next) return false;

	await runtime.harness.commit(async (tx) => {
		const company = await tx.doc(CompanyDoc);
		company.workspaceRoot = next;
	}, context);
	return true;
}

/**
 * 把登记表里的工作空间路径规整成绝对路径。
 *
 * 必须做：执行环境拿到相对路径会再拼一次进程目录（见 runtime/env.ts 的说明），
 * 结果是目录不存在、员工所有命令报错。历史数据里确实存过相对路径。
 */
function resolveProfileWorkspace(workspace: string): string {
	if (workspace === "") return workspace;
	return isAbsolute(workspace) ? workspace : resolvePath(process.cwd(), workspace);
}

async function countFiles(
	directory: string,
	readdir: (path: string, options: { withFileTypes: true }) => Promise<{ isDirectory(): boolean; name: string }[]>,
): Promise<number> {
	let total = 0;
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			const { join } = await import("node:path");
			total += await countFiles(join(directory, entry.name), readdir);
		} else {
			total += 1;
		}
	}
	return total;
}

/** 按项目列出未归档的员工。 */
export async function listStaff(
	runtime: CompanyRuntime,
	project: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<StaffEntry[]> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	if (state === undefined) return [];
	return Object.values(state.staff).filter((staff) => staff.project === project && !staff.archived);
}

/** 列出全部未归档员工。 */
export async function listAllStaff(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<StaffEntry[]> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	if (state === undefined) return [];
	return Object.values(state.staff).filter((staff) => !staff.archived);
}

/** 读公司索引。 */
export async function readCompany(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<CompanyState | undefined> {
	return runtime.harness.snapshot(CompanyDoc, context);
}

/** 查可分配模型清单。 */
export async function listModels(
	runtime: CompanyRuntime,
	context: Context = BACKGROUND_CONTEXT,
): Promise<ModelOption[]> {
	const state = await runtime.harness.snapshot(CompanyDoc, context);
	return state === undefined ? [] : [...state.modelCatalog];
}

/** 修改公司默认模型（只影响后续招聘）。 */
export async function setDefaultModel(
	runtime: CompanyRuntime,
	model: ModelRef,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	await runtime.harness.commit(async (tx) => {
		const company = await tx.doc(CompanyDoc);
		company.defaultModel = model;
	}, context);
}

// ── 内部 ────────────────────────────────────────────────────────────────────

/**
 * 升级序号：**必须跨重启唯一**。
 *
 * 旧实现是模块级内存自增（`let escalationSeq = 0`），进程重启后归零，
 * 于是重启后的第一条上报会拿到和重启前相同的编号 `esc:<conv>:1`。
 * 后果（实测复现）：
 * 1. `ensurePending` 发现同 `key`+`level` 已存在 → 直接 return，**新问题不会建待办**；
 * 2. `readOutcome` 读到**旧的已答复条目** → 升级任务把旧答复当成新问题的决定交付；
 * 3. 结果：老板看不到新问题，提问方收到一条答非所问的「拍板结果」，且全程不报错。
 *
 * 修法：用时间戳。升级本来就不要求幂等（每次上报都是新事件，见 ADR-006 的
 * 「请求标识由业务语义推导」——这里语义就是「一次新的上报」）。
 * 同一毫秒内连续两次上报的极端情况用进程内计数器兜底，保证严格单调。
 *
 * 契约由 `test/unit/escalation-seq.test.ts` 锁住：编号量级必须与时间戳同阶，
 * 改回小整数自增会让测试失败。
 */
let escalationStamp = 0;
/** 当前这一「时间刻度」内已用掉多少个后缀。 */
let escalationTick = 0;

export function nextEscalationSeq(): number {
	const now = Date.now();
	if (now > escalationStamp) {
		escalationStamp = now;
		escalationTick = 0;
	} else {
		escalationTick += 1;
	}
	// 同一刻度内用完 1000 个后缀：把刻度往后借一格，**不取模回绕**。
	// 旧实现是 `escalationStamp * 1000 + (escalationSeq % 1000)`——进程内计数器
	// 一旦超过 1000 就开始回绕，同一毫秒内第 1001 次上报会拿到比第 1 次更小的编号，
	// 「严格单调」这条契约只在 1000 次以内成立。升级项的排序依赖它单调。
	if (escalationTick >= 1000) {
		escalationStamp += 1;
		escalationTick = 0;
	}
	return escalationStamp * 1000 + escalationTick;
}

/**
 * 会话标识 → 可读名字。
 *
 * 以前所有上报的 from 都写死成 "manager"，老板只看到「来自 manager」，
 * 分不清是 CTO 还是某个项目负责人在问。这里按公司索引反查真实岗位/姓名。
 */
/**
 * 权限位（owner / 岗位名 / leader:<slug>）的显示名。
 *
 * ADR-027：一切身份展示走 `managerLabelOf`，不要自己切 `leader:` 前缀或用
 * `ROLE_LABELS[key] ?? key` 的写法（后者遇到未知键会得到原样字符串，误导人）。
 */
function labelOfLevel(state: CompanyState | undefined, level: string): string {
	if (level === "owner") return "老板";
	if (level === "") return "（未指定）";
	return managerLabelOf(state, level as ManagerRef);
}

function labelOfConversation(state: CompanyState | undefined, conversationId: number): string | undefined {
	if (state === undefined) return undefined;

	for (const [role, id] of Object.entries(state.roles ?? {})) {
		if (id === conversationId) return ROLE_LABELS[role as ManagementRole] ?? role.toUpperCase();
	}
	for (const project of Object.values(state.projects ?? {})) {
		if (project.leader === conversationId) return project.leaderName ?? project.name;
	}
	for (const person of Object.values(state.staff ?? {})) {
		if (person.conversationId === conversationId) return person.name;
	}
	return undefined;
}

/**
 * 没有升级任务定义时的退路：直接写一条待决问题。
 *
 * 保证上报不会静默丢失——宁可退化也不能吞掉管理层的请假。
 */
async function recordPendingDirectly(
	runtime: CompanyRuntime,
	input: { readonly question: string; readonly from: string; readonly conversationId: number },
	context: Context,
): Promise<void> {
	const { PendingDoc } = await import("./escalation.ts");
	// 没有升级任务时，问题只能落在 CEO 这一级——老板永远不是兜底接收人。
	await runtime.harness.commit(async (tx) => {
		const pending = await tx.doc(PendingDoc);
		pending.items.push({
			key: escalationId(input.conversationId, nextEscalationSeq()),
			question: input.question,
			level: "ceo",
			from: input.from,
			fromConversationId: input.conversationId,
			askedAt: Date.now(),
		});
	}, context);
}

/** 员工的后台锚点任务：创建后立即结束，只用来给员工会话一个「后台归属」。 */const AnchorTask = defineTask<null, { phase: "done" }, null>({
	name: "app.anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: async (_task, runtime, context) => {
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
				context,
			);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

/**
 * 公司内置任务的能力包。
 *
 * 必须注册进 registry：底层的任务按名字解析定义，未注册的任务会
 * 被判为 `missing_task` 而受阻——员工会「在岗但不动」。
 */
export const COMPANY_TASKS_EXTENSION = defineExtension({
	name: "company-tasks",
	tasks: [AnchorTask],
});

/**
 * 确保已存在的管理层会话选中正确的能力包。
 *
 * 老数据可能因为早期版本的默认选择而带上了错误的能力包（例如 CEO 拿到
 * 全部工具）。这里按岗位定义重设一次，使升级后旧库也能被修正。
 */
async function ensureRoleAgents(
	runtime: CompanyRuntime,
	roles: Record<ManagementRole, number>,
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	for (const role of MANAGEMENT_ROLES) {
		const conversation = await runtime.harness.conversation(roles[role] as never, context);
		if (conversation === undefined) continue;

		const agent = await conversation.agent(context);
		const expected = ROLE_DEFINITIONS[role].extensionName;
		const actual = agent.extensions.map((extension) => extension.name);
		const correct = actual.length === 1 && actual[0] === expected;
		if (correct) continue;

		await conversation.configure({ extensions: [createRoleExtension(role)] }, context);
	}
}

/**
 * 把失效的会话模型引用拉回当前清单里的默认模型。
 *
 * **为什么需要这一步**：`pi.agent.model` 是持久化的，`bootstrapCompany` 的幂等
 * 早退分支过去只修能力包 / cwd / 上级，从不校验模型。而代码里的默认模型换过多次
 * （`apigoto/deepseek-flash` → `auto/deepseek-v4.1-flash` → `workbuddy-ai/...`），
 * 老库一旦指向旧 id，provider 里没这个模型，每一轮生成都以
 * `Model <provider>/<id> is not available` 失败——消息投递全部成功、但对端
 * 一句话也说不出来，界面表现为「@ 了但没人理」。
 *
 * 同时刷新 `CompanyDoc.modelCatalog` / `defaultModel`：清单是持久化快照，
 * 新加的模型（老板在设置页里加的）不刷新的话，`staff_hire` 按旧清单校验会拒掉。
 *
 * 只修**认不出**的引用：认得出的保留老板自己给某个员工指定的模型。
 *
 * @returns 修掉的会话数
 */
async function repairModelRefs(
	runtime: CompanyRuntime,
	options: BootstrapOptions,
	state: CompanyState,
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	const catalog = options.modelCatalog ?? [];
	if (catalog.length === 0) return 0;
	const fallback = options.defaultModel ?? firstModel(catalog);

	// 会话清单：管理层 + 员工 + 项目负责人（负责人可能已不由 staff 记录持有）。
	const conversations = new Set<number>();
	for (const role of MANAGEMENT_ROLES) {
		const id = state.roles[role];
		if (id !== undefined) conversations.add(id);
	}
	for (const staff of Object.values(state.staff)) conversations.add(staff.conversationId);
	for (const project of Object.values(state.projects)) {
		const leader = Number(project.leader);
		if (Number.isFinite(leader)) conversations.add(leader);
	}

	let repaired = 0;
	for (const id of conversations) {
		if (!Number.isFinite(id) || id <= 0) continue;
		const conversation = await runtime.harness.conversation(id as never, context);
		if (conversation === undefined) continue;

		const agent = await conversation.agent(context);
		const model = agent.model;
		if (model === undefined) continue;
		// 用 `provider/modelId` 整串去认：`resolveModelOption` 会先按 id 精确匹配，
		// 再按首个斜杠拆开找 provider+modelId（`modelId` 自身可以再含斜杠）。
		const known = catalog.some(
			(item) => item.provider === model.provider && item.modelId === model.modelId,
		);
		if (known) continue;

		await conversation.configure({ model: fallback }, context);
		repaired += 1;
	}

	// 清单与默认值也要跟着代码走：它们是持久化快照，不刷新的话设置页新加的模型
	// 进不了 `state.modelCatalog`，`staff_hire` 会以「模型不在清单里」拒掉。
	const catalogStale =
		state.modelCatalog.length !== catalog.length ||
		state.modelCatalog.some((item, index) => {
			const next = catalog[index];
			return next === undefined || item.id !== next.id || item.provider !== next.provider;
		});
	const defaultStale =
		state.defaultModel.provider !== fallback.provider || state.defaultModel.modelId !== fallback.modelId;
	if (catalogStale || defaultStale) {
		await runtime.harness.commit(async (tx) => {
			const doc = await tx.doc(CompanyDoc);
			doc.modelCatalog = [...catalog];
			doc.defaultModel = fallback;
		}, context);
	}

	return repaired;
}

/**
 * 确保已存在的员工会话选中自己的（唯一命名的）能力包。
 *
 * 早期版本所有员工共用 `role-employee` 一个名字，后招聘的会覆盖前面的，
 * 导致部分员工没有任何工具。这里按员工名重建能力包并重设选择。
 */
async function ensureStaffAgents(
	runtime: CompanyRuntime,
	state: CompanyState,
	registry: Registry,
	context: Context,
): Promise<void> {
	for (const staff of Object.values(state.staff)) {
		if (staff.archived) continue;

		const conversation = await runtime.harness.conversation(staff.conversationId as never, context);
		if (conversation === undefined) continue;

		const agent = await conversation.agent(context);
		if (agent.tools.length > 0) continue;

		// 没有工具 → 重建能力包并重设
		const extension = createEmployeeExtension(
			`${staff.project}/${staff.name}`,
			employeeToolsFor(runtime, staff.tools ?? []),
			employeeUniversalTools(runtime),
		);
		registry.install(extension);
		await conversation.configure({ extensions: [extension] }, context);
	}
}

/**
 * 负责人的会话级职责描述 / 立项文档 / 员工职责描述。
 *
 * 实现搬到 `company/prompts.ts`（纯文案，与装配逻辑分离）。这里原样再导出，
 * 是为了不动既有调用点与 `test/` 里的导入路径——那些地方 import 的是
 * `company/org.ts`，而它们要的确实就是「组织操作附带的提示词」。
 */
export { projectLeaderCharter, renderProjectBrief, staffCharterOf, staffInstructionsFor } from "./prompts.ts";
import {
	projectLeaderCharter,
	renderProjectBrief,
	staffInstructionsFor,
} from "./prompts.ts";

/** 生成员工职责描述。 */
function buildStaffInstructions(
	state: CompanyState | undefined,
	options: HireStaffOptions,
	manager: ManagerRef,
): string {
	return staffInstructionsFor(state, {
		duty: options.duty ?? "",
		projectName: options.project,
		manager,
		...(options.instructions === undefined ? {} : { extra: options.instructions }),
	});
}

/** 取清单第一项作为默认模型。 */
function firstModel(catalog: readonly ModelOption[]): ModelRef {
	const first = catalog[0];
	if (first === undefined) throw new Error("模型清单为空，无法确定默认模型");
	return { provider: first.provider, modelId: first.modelId };
}

/** 把 Record<string, number> 收窄为按岗位的完整记录。 */
function toRoleRecord(roles: Record<string, number>): Record<ManagementRole, number> {
	const result = {} as Record<ManagementRole, number>;
	for (const role of MANAGEMENT_ROLES) {
		const id = roles[role];
		if (id === undefined) throw new Error(`公司索引缺少岗位：${role}`);
		result[role] = id;
	}
	return result;
}

// ── 上报（escalate）：唯一入口 ─────────────────────────────────────────────

/** 一次上报的结构化输入（工具参数之外，还要有「谁在问」这个事实）。 */
export type EscalationRequest = {
	readonly question: string;
	/** 发起人自称（显示用；真实身份由 conversationId 反查，见下）。 */
	readonly from: string;
	readonly conversationId: number;
	/** 调用方声明的项目；缺省时从员工记录取（一手事实优先）。 */
	readonly project?: string;
	/** 事项类别（ADR-026 决策 2）。不传按 unclassified 处理。 */
	readonly topic?: DecisionTopic;
};

/**
 * 上报并路由到该拍板的人（ADR-026 决策 2，落地第 3 步）。
 *
 * 为什么单独导出：原先这段逻辑包在 `bootstrapCompany` 的闭包里，
 * 只能通过模型调工具才走得到——「项目内事项归项目负责人」这条被漏接线
 * （工具从来不传 project）也就没法用测试钉住。抽成函数后：
 * 工具层与直调 API 走同一份实现，测试可以直接喂真实的公司结构。
 *
 * 路由的权威实现是 `startEscalation`（唯一入口）；这里算一遍只为了两件事：
 * ① 决定回复文案；② 拦住「自己上报给自己」这种会永远没人答的待办。
 */
export async function escalateUp(
	runtime: CompanyRuntime,
	input: EscalationRequest,
	escalationTask: BootstrapOptions["escalationTask"],
	context: Context = BACKGROUND_CONTEXT,
): Promise<string> {
	// 升级链需要任务定义；没有注册时退化为「直接记一条待决问题」，
	// 保证上报不会静默丢失。
	if (escalationTask === undefined) {
		await recordPendingDirectly(runtime, input, context);
		return "已记录上报，等待上层答复。";
	}

	const company = await runtime.harness.snapshot(CompanyDoc, context);
	const isCeo = company?.roles.ceo === input.conversationId;

	// 员工按自己的直属上级走：岗位 → 对应管理层，leader:<slug> → 本项目负责人。
	// 管理层/负责人自己没有 staff 记录，仍从 CEO 开始（他们本来就向 CEO 汇报）。
	const staffOfCaller = Object.values(company?.staff ?? {}).find(
		(person) => person.conversationId === input.conversationId && !person.archived,
	);
	const manager = staffOfCaller?.manager;

	// 发起人层级与所在项目同样是路由的输入：
	// - `project` 让「项目内事项」能落到本项目负责人（不再是只有直调 API 才走得到）；
	// - `fromLevel` 让没有直属上级的发起人（例如管理层自己）按自己的层级兜底。
	// 员工记录里的 project 是一手事实；负责人自己是 `project.leader`，没有 staff 记录，
	// 所以还要按 projects 索引反查——否则负责人声明「项目内事项」会被算成 CEO。
	const callerLevel = levelOfConversation(company, input.conversationId);
	const leadProjectSlug = Object.entries(company?.projects ?? {}).find(
		([, entry]) => entry.leader === input.conversationId,
	)?.[0];
	const callerProject = staffOfCaller?.project ?? leadProjectSlug ?? input.project;

	// 与 startEscalation 用同一个决定（同一个 decideOwner、同一份结构信息），
	// 否则「算给谁」和「落在谁那儿」会给出两个答案，回复文案就骗人。
	const decisionOwner = isCeo
		? ({ kind: "owner" } as const)
		: decideOwner(company, input.topic ?? "unclassified", {
				...(manager === undefined ? {} : { manager }),
				...(callerProject === undefined ? {} : { project: callerProject }),
				...(callerLevel === undefined ? {} : { fromLevel: callerLevel }),
			});
	const ownerLevel = levelOfTarget(decisionOwner);

	// 自己上报给自己（项目负责人声明「项目内事项」）不该生成一条自己等自己的任务，
	// 否则这条待办会一直挂在他名下、没人来答。直接告诉他「你就能定」。
	if (!isCeo && callerLevel !== undefined && ownerLevel === callerLevel) {
		return `这条按权限矩阵归你自己（${labelOfLevel(company, ownerLevel)}），直接定即可，不必上报。`;
	}

	const key = escalationId(input.conversationId, nextEscalationSeq());
	const taskId = await startEscalation(
		runtime,
		escalationTask,
		{
			question: input.question,
			// CEO 直接问老板时，发起人就是 CEO 本人；
			// 其他人用真实岗位/姓名，而不是写死的「manager」
			from: isCeo ? "CEO" : (labelOfConversation(company, input.conversationId) ?? input.from),
			fromConversationId: input.conversationId,
			...(callerProject === undefined ? {} : { project: callerProject }),
			...(manager === undefined ? {} : { manager }),
			...(input.topic === undefined ? {} : { topic: input.topic }),
			// CEO 显式问老板（startAtOwner）优先于 topic：这是 CEO 对
			// 「这个问题只能老板定」的主动判断，不能被默认 unclassified 推翻。
			...(isCeo ? { startAtOwner: true } : {}),
			escalationKey: key,
		},
		context,
	);
	if (isCeo && ownerLevel === "owner") {
		return `已上报老板（编号 ${key}，任务 ${taskId}），等待老板拍板。`;
	}
	const ownerLabel = labelOfLevel(company, ownerLevel);
	if (ownerLevel === "owner") {
		// Defect B：非 CEO 声明 company-level 不再直达老板，回复文案必须同步改，
		// 否则文案还在骗人（说「已上报老板」，实际停在 CEO 复核）。
		return `已上报 CEO（编号 ${key}，任务 ${taskId}）——你声明为公司级事项，需 CEO 复核是否真的只能老板定；CEO 确认后才会转给老板。`;
	}
	return `已上报 ${ownerLabel}（编号 ${key}，任务 ${taskId}），等它答复；它解决不了会继续往上走。`;
}
