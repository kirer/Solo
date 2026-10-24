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
	awaitWithContext,
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
	type ManagementRole,
	MANAGEMENT_ROLES,
	type ModelOption,
	type ModelRef,
	type ProjectEntry,
	ProfileDoc,
	ROLE_LABELS,
	type StaffEntry,
} from "./docs.ts";
import { createRoleExtension, ROLE_DEFINITIONS } from "./roles.ts";
import { PendingDoc, listPending, answerPendingAsCeo } from "./escalation.ts";
import {
	PROJECT_LEADER_CHARTER,
	createProjectLeaderExtension,
	createRoleExtensionWithTools,
	type ManagementToolset,
} from "./tools.ts";
import { delegate } from "./delegation.ts";
import { beginLiveTrail, recordMessage } from "./trail.ts";
import { DelegationCycleError, enterDelegation } from "./delegation-guard.ts";
import {
	type EscalationInput,
	type EscalationResult,
	type EscalationState,
	startEscalation,
} from "./escalation.ts";
import { escalationId, messageRequestId } from "../runtime/ids.ts";
import { toolsForRole } from "./staff-tools.ts";
import { createManagementTools } from "./management-tools.ts";
import { createAllRoleExtensionsWithTools, createEmployeeExtension } from "./tools.ts";
import { isAbsolute, resolve as resolvePath } from "node:path";

/**
 * 每个运行时对应的管理层工具集。
 *
 * `bootstrapCompany` 在装配时登记，`createProject` 立项时取用——这样
 * 「谁都能建项目，但负责人一定有工具」不依赖调用方是否记得传参数。
 */
const LEADER_TOOLSETS = new WeakMap<CompanyRuntime, ManagementToolset>();

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
};

/** 初始化结果。 */
export type BootstrapResult = {
	/** 老板与 CEO 的对话通道。 */
	readonly ownerConversationId: number;
	/** 各管理层岗位的会话标识。 */
	readonly roleConversations: Record<ManagementRole, number>;
	readonly created: boolean;
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
	// 管理层工具集合：由公司运行时闭包而成。
	// 派活与转交给需要先有会话标识，所以用惰性引用（阶段二再解析）。
		const managementTools = createManagementTools({
		runtime,
		workspaceRoot: options.workspaceRoot ?? process.cwd(),
		...(options.registry === undefined ? {} : { registry: options.registry }),
		...(options.costReport === undefined ? {} : { costReport: options.costReport }),
		...(options.employeeTools === undefined ? {} : { employeeTools: options.employeeTools }),
		delegate: async (input) => {
			const toolContext = input.context ?? BACKGROUND_CONTEXT;
			const state = await runtime.harness.snapshot(CompanyDoc, toolContext);
			const result = await delegate(
				runtime,
				{
					project: input.project,
					employee: input.employee,
					task: input.task,
					fromConversationId: input.fromConversationId,
					// 显示名从会话反查，避免所有派活都记成「管理层」
					from: labelOfConversation(state, input.fromConversationId) ?? input.from,
				},
				toolContext,
			);
			return result.ok ? `员工回复：${result.text}` : `派活失败：${result.text}`;
		},
		escalate: async (input) => {
			// 升级链需要任务定义；没有注册时退化为「直接记一条待决问题」，
			// 保证上报不会静默丢失。
			const task = options.escalationTask;
			if (task === undefined) {
				await recordPendingDirectly(runtime, input, context);
				return "已记录上报，等待上层答复。";
			}
			// 只有 CEO 的问题会落在老板桌上。CEO 发起时直接进入「问老板」，
			// 不再绕一圈问自己；其他人发起的，最高只到 CEO。
			const company = await runtime.harness.snapshot(CompanyDoc, context);
			const isCeo = company?.roles.ceo === input.conversationId;
			const key = escalationId(input.conversationId, nextEscalationSeq());
			const taskId = await startEscalation(
				runtime,
				task,
				{
					question: input.question,
					// CEO 直接问老板时，发起人就是 CEO 本人；
					// 其他人用真实岗位/姓名，而不是写死的「manager」
					from: isCeo ? "CEO" : (labelOfConversation(company, input.conversationId) ?? input.from),
					fromConversationId: input.conversationId,
					...(input.project === undefined ? {} : { project: input.project }),
					escalationKey: key,
					...(isCeo ? { startAtOwner: true } : {}),
				},
				context,
			);
			return isCeo
				? `已上报老板（编号 ${key}，任务 ${taskId}），等待老板拍板。`
				: `已上报 CEO（编号 ${key}，任务 ${taskId}），等 CEO 答复；老板只会收到 CEO 确认过的问题。`;
		},
		pendingList: async (input) => {
			const pending = await listPending(runtime, BACKGROUND_CONTEXT);
			const mine = pending.filter((item) => item.level === "ceo");
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
			if (item.answer !== undefined) return `这条已经答复过了（${item.answeredBy ?? "?"}）。`;
			if (item.level !== "ceo") {
				return `编号 ${input.key} 不是到你这一级的（level=${item.level}），你不能替它拍板。`;
			}
			const ok = await answerPendingAsCeo(
				runtime,
				{
					key: input.key,
					answer: input.answer,
					...(input.escalate === true ? { escalate: true } : {}),
				},
				BACKGROUND_CONTEXT,
			);
			if (!ok) return `答复失败：编号 ${input.key} 可能已被处理。`;
			return input.escalate === true
				? "已转为老板待办，等老板拍板。"
				: "已拍板并记录在案。";
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
		delegateToRole: async (input) => {
			const toolContext = input.context ?? BACKGROUND_CONTEXT;
			const state = await runtime.harness.snapshot(CompanyDoc, toolContext);
			const targetId = state?.roles[input.role];
			if (targetId === undefined) return `没有岗位 ${input.role}。`;
			const target = await runtime.harness.conversation(targetId as never, toolContext);
			if (target === undefined) return `岗位 ${input.role} 的会话不存在。`;

			const caller = input.fromConversationId;
			const guard = tryEnterDelegation(caller, targetId, `岗位 ${input.role}`);
			if (typeof guard === "string") return guard;
			const release = guard;

			try {
				// 目标正忙时直接失败，而不是排队等它——排队会让调用方无限期挂住，
				// 一旦两边互相转交就是死锁（真实事故：CEO/CTO/负责人三方互等）。
				const busy = await busyReason(runtime, targetId, toolContext);
				if (busy !== undefined) return `岗位 ${input.role} ${busy}，本次转交未执行。请稍后再转，或改用上报（escalate）。`;

				// 用请求标识去重：同一条转交重复调用不会让岗位重复干活
				const requestId = messageRequestId(`role-${input.role}`, caller, hashToInt(input.task));
				const submission = await target.submit(
					{
						type: "input",
						content: input.task,
						requestId,
						entry: {
							kind: "app.delegate",
							data: {
								from: labelOfConversation(state, caller) ?? "管理层",
								to: ROLE_LABELS[input.role as ManagementRole] ?? input.role,
								text: input.task.slice(0, 280),
							},
						},
						whenBusy: "reject",
					},
					toolContext,
				);
				const releaseLive = beginLiveTrail({
					kind: "delegate",
					from: labelOfConversation(state, caller) ?? "管理层",
					to: ROLE_LABELS[input.role as ManagementRole] ?? input.role,
					fromConversation: caller,
					toConversation: targetId,
				});
				let settled: Awaited<ReturnType<typeof submission.wait>>;
				try {
					settled = await awaitWithContext(submission.wait(toolContext), toolContext);
				} finally {
					releaseLive();
				}
				if (settled.status !== "done") return `岗位 ${input.role} 未能处理（${settled.status}）。`;

				// 把岗位的答复摘要带回去：调用方据此判断要不要接着安排下一步
				const summary = await readAssistantText(runtime, targetId, toolContext);
				const fromLabel = labelOfConversation(state, caller) ?? "管理层";
				const toLabel = ROLE_LABELS[input.role as ManagementRole] ?? input.role;
				await recordMessage(
					runtime,
					{
						kind: "delegate",
						from: fromLabel,
						to: toLabel,
						fromConversationId: caller,
						toConversationId: targetId,
						ref: requestId,
						text: input.task.slice(0, 280),
					},
					toolContext,
				);
				await recordMessage(
					runtime,
					{
						kind: "report",
						from: toLabel,
						to: fromLabel,
						fromConversationId: targetId,
						toConversationId: caller,
						ref: `${requestId}:report`,
						text: summary.slice(0, 280),
					},
					toolContext,
				);
				return `岗位 ${input.role} 已处理。它的回复摘要：\n${summary}`;
			} catch (error) {
				// 老板点「立即处理」时工具上下文会被 abort；这个错误必须继续往上抛，
				// 否则 abort 永远等不到任务结束。
				if (toolContext.abortSignal?.aborted === true) throw error;
				return `转交给岗位 ${input.role} 失败：${error instanceof Error ? error.message : String(error)}`;
			} finally {
				release();
			}
		},
		delegateToLeader: async (input) => {
			const toolContext = input.context ?? BACKGROUND_CONTEXT;
			const state = await runtime.harness.snapshot(CompanyDoc, toolContext);
			const project = state?.projects[input.project];
			if (project === undefined) {
				const slugs = Object.keys(state?.projects ?? {});
				return `没有项目 ${input.project}。现有项目：${slugs.length === 0 ? "（无）" : slugs.join("、")}`;
			}

			const leader = await runtime.harness.conversation(project.leader as never, toolContext);
			if (leader === undefined) return `项目 ${input.project} 的负责人会话不存在（${project.leader}）。`;

			const caller = input.fromConversationId;
			const guard = tryEnterDelegation(caller, project.leader, `项目负责人 ${project.leaderName}`);
			if (typeof guard === "string") return guard;
			const release = guard;

			try {
				const busy = await busyReason(runtime, project.leader, toolContext);
				if (busy !== undefined) {
					return `项目负责人 ${project.leaderName} ${busy}，本次下达未执行。请稍后再下达，或先看它卡在哪。`;
				}

				// 请求标识按「发起方 + 任务内容」去重：重复下达同一件事不会让负责人重复干活
				const requestId = messageRequestId(
					`leader-${input.project}`,
					caller,
					hashToInt(input.task),
				);
				const submission = await leader.submit(
					{
						type: "input",
						content: input.task,
						requestId,
						entry: {
							kind: "app.delegate",
							data: {
								from: labelOfConversation(state, caller) ?? "管理层",
								to: project.leaderName ?? "项目负责人",
								project: project.slug,
								text: input.task.slice(0, 280),
							},
						},
						whenBusy: "reject",
					},
					toolContext,
				);
				const releaseLive = beginLiveTrail({
					kind: "delegate",
					from: labelOfConversation(state, caller) ?? "管理层",
					to: project.leaderName,
					fromConversation: caller,
					toConversation: project.leader,
					project: project.slug,
				});
				let settled: Awaited<ReturnType<typeof submission.wait>>;
				try {
					settled = await awaitWithContext(submission.wait(toolContext), toolContext);
				} finally {
					releaseLive();
				}
				if (settled.status !== "done") {
					return `项目负责人 ${project.leaderName} 未能处理（${settled.status}）。`;
				}

				const summary = await readAssistantText(runtime, project.leader, toolContext);
				const fromLabel = labelOfConversation(state, caller) ?? "管理层";
				await recordMessage(
					runtime,
					{
						kind: "delegate",
						from: fromLabel,
						to: project.leaderName,
						fromConversationId: caller,
						toConversationId: project.leader,
						ref: requestId,
						project: project.slug,
						text: input.task.slice(0, 280),
					},
					toolContext,
				);
				await recordMessage(
					runtime,
					{
						kind: "report",
						from: project.leaderName,
						to: fromLabel,
						fromConversationId: project.leader,
						toConversationId: caller,
						ref: `${requestId}:report`,
						project: project.slug,
						text: summary.slice(0, 280),
					},
					toolContext,
				);
				return `项目「${project.name}」负责人 ${project.leaderName} 已处理。它的回复摘要：\n${summary}`;
			} catch (error) {
				if (toolContext.abortSignal?.aborted === true) throw error;
				return `下达给项目负责人 ${project.leaderName} 失败：${error instanceof Error ? error.message : String(error)}`;
			} finally {
				release();
			}
		},
	});

	// 注册全部角色能力包（带工具）。底层按名字解析能力包，未注册的取不到。
	if (options.registry !== undefined) {
		// 内置任务必须先注册，否则员工的后台锚点会受阻
		options.registry.install(COMPANY_TASKS_EXTENSION);
		for (const extension of createAllRoleExtensionsWithTools(managementTools)) {
			options.registry.install(extension);
		}
		// 项目负责人能力包：整个公司只有一个 role-leader（职责描述与项目无关），
		// 项目名由会话 instructions 注入。启动时装一次，负责人会话选中它即可。
		const leaderExtension = createProjectLeaderExtension(managementTools);
		options.registry.install(leaderExtension);
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
		if (options.registry !== undefined) {
			// 能力包已注册；这里确保已存在的会话仍指向新装的对象
			await ensureRoleAgents(runtime, roleConversations, context);
			// 员工同理：早期版本可能因能力包名冲突而丢失工具
			await ensureStaffAgents(runtime, existing, options.registry, context);
			// 负责人同理：早期版本立项时没给负责人装任何能力包，他只能空转
			await repairLeaderAgents(runtime, { taskset: managementTools, registry: options.registry }, context);
		}
		return { ownerConversationId: roleConversations.ceo, roleConversations, created: false };
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

	return { ownerConversationId: Number(owner.id), roleConversations, created: true };
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
			brief: options.brief,
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

		// 负责人能力包是全局唯一的一个（role-leader），启动时已注册。
		const extension = createProjectLeaderExtension(options.taskset);
		const agent = await conversation.agent(context);

		// 注意不能只判「列表里有 role-leader」：负责人会话过去没显式选过能力包，
		// 底层的默认语义是「选中全部已注册能力包」，那样列表里也有 role-leader，
		// 但他同时还带着 CHRO 的招聘、CPO 的立项——看起来修好了，其实越权还在。
		const selectedOnly = agent.extensions.length === 1 && agent.extensions[0]?.name === extension.name;
		const expectedInstructions = projectLeaderCharter(project.name);
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
	/** 员工角色（产品 / 设计 / 开发 / 测试 …）。 */
	readonly role: string;
	/** 指定模型；不传则用公司默认模型。 */
	readonly model?: ModelRef;
	/** 直属上级岗位。 */
	readonly manager: ManagementRole;
	/** 额外职责描述，追加到角色模板之后。 */
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

	// 未显式指定时按角色自动分配：员工干不了活往往就是这里给空了
	const employeeTools = options.employeeTools ?? toolsForRole(options.role);

	const employeeExtension = createEmployeeExtension(`${options.project}/${options.name}`, employeeTools);

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

		const profile = await tx.doc(ProfileDoc, conversation.id);
		profile.title = options.name;
		profile.kind = "staff";
		profile.project = options.project;
		profile.parent = project.leader;
		profile.workspace = project.workspace;
		profile.role = options.role;

		const company = await tx.doc(CompanyDoc);
		company.staff[key] = {
			name: options.name,
			role: options.role,
			conversationId: Number(conversation.id),
			project: options.project,
			manager: options.manager,
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
					instructions: buildStaffInstructions(options),
					// 老库里的 workspace 可能是相对路径，统一解析成绝对路径再下发
					cwd: resolveProfileWorkspace(project.workspace),
				},
				context,
			),
		);

	const latest = await runtime.harness.snapshot(CompanyDoc, context);
	const staff = latest?.staff[key];
	if (staff === undefined) throw new Error(`招聘后未能读回员工记录：${key}`);

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

/** 字符串的稳定整数哈希，用于请求标识去重。 */
function hashToInt(text: string): number {
	let hash = 0;
	for (let index = 0; index < text.length; index += 1) {
		hash = (hash * 31 + text.charCodeAt(index)) | 0;
	}
	return Math.abs(hash);
}

/** 读某会话最近一条助手消息的文本。 */
async function readAssistantText(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context,
): Promise<string> {
	const conversation = await runtime.harness.conversation(conversationId as never, context);
	const page = await conversation?.entries({ order: "descending" }, 10, undefined, context);
	const last = page?.items.find((entry) => entry.kind === "pi.assistant");
	const message = last?.model?.[0] as { content?: readonly { type: string; text?: string }[] } | undefined;
	const text = (message?.content ?? [])
		.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
		.join("")
		.trim();
	return text.slice(0, 300);
}

/** 升级序号：用时间戳保证唯一（升级本身不要求幂等，每次上报都是新事件）。 */
let escalationSeq = 0;
function nextEscalationSeq(): number {
	escalationSeq += 1;
	return escalationSeq;
}

/**
 * 会话标识 → 可读名字。
 *
 * 以前所有上报的 from 都写死成 "manager"，老板只看到「来自 manager」，
 * 分不清是 CTO 还是某个项目负责人在问。这里按公司索引反查真实岗位/姓名。
 */
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
 * 登记一次同步转交；发现循环等待时返回给模型看的说明。
 *
 * 为什么要有这道防线：转交工具是同步的（等对方答复）。A 等 B、B 又等 A 时，
 * 两边都会永远等下去，而且 abort 也要等任务结束——老板点「立即处理」也救不回来。
 */
function tryEnterDelegation(
	caller: number,
	target: number,
	label: string,
): (() => void) | string {
	try {
		return enterDelegation(caller, target);
	} catch (error) {
		if (error instanceof DelegationCycleError) {
			return [
				`不能转交给${label}：${error.message}。`,
				"对方正在直接或间接等你这一侧的结果，转过去会互相卡死。",
				"请先把手上的结论处理完并回复它，或用 escalate 让 CEO 协调；不要用同步转交绕圈。",
			].join("");
		}
		throw error;
	}
}

/** 目标会话是否正忙；忙则返回给模型看的原因，避免同步等待挂死。 */
async function busyReason(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context,
): Promise<string | undefined> {
	const inspection = await runtime.harness.inspect(context);
	const hasLiveTask = inspection.tasks.some(
		(task) =>
			Number(task.record.conversationId) === conversationId &&
			(task.state.kind === "running" || task.state.kind === "ready" || task.state.kind === "waiting"),
	);
	if (hasLiveTask) return "正在忙（还有没结束的任务）";

	const hasQueued = inspection.submissions.some(
		(submission) =>
			Number(submission.conversationId) === conversationId &&
			(submission.status === "queued" || submission.status === "placed"),
	);
	if (hasQueued) return "还有排队中的消息没处理";

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

/** 员工的后台锚点任务：创建后立即结束，只用来给员工会话一个「后台归属」。 */
const AnchorTask = defineTask<null, { phase: "done" }, null>({
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

/** 角色模板：员工的职责描述（问题 3 的答案——由 CHRO 招聘时预设）。 */
const STAFF_ROLE_TEMPLATES: Record<string, string> = {
	产品: "你是产品经理。负责需求分析、撰写 PRD、定义验收标准。不要写代码。遇到需求冲突上报 CPO。",
	设计: "你是 UI/UX 设计师。负责交互方案与视觉方向。输出设计说明与原型描述。遇到技术限制上报 CTO。",
	开发: "你是开发工程师。负责编码实现与单元测试。遇到技术选型问题上报 CTO。不要改动需求定义。",
	测试: "你是测试工程师。负责用例设计、执行验证、编写缺陷报告。不要修改产品代码。遇到标准不清上报 CPO。",
	运营: "你是运营。负责推进节奏与交付跟进。遇到排期冲突上报 COO。",
};

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
		const extension = createEmployeeExtension(`${staff.project}/${staff.name}`, toolsForRole(staff.role));
		registry.install(extension);
		await conversation.configure({ extensions: [extension] }, context);
	}
}

/** 生成员工职责描述。 */
function buildStaffInstructions(options: HireStaffOptions): string {
	const base = STAFF_ROLE_TEMPLATES[options.role] ?? `你是${options.role}。只做被指派的工作，遇到不确定的事上报。`;
	const lines = [
		base,
		`你隶属于「${options.project}」项目，直属上级是 ${ROLE_LABELS[options.manager]}。`,
		"你只与你的直属上级沟通，不越级。",
	];
	if (options.instructions !== undefined && options.instructions !== "") lines.push(options.instructions);
	return lines.join("\n");
}

/** 生成立项文档内容。 */
/**
 * 负责人的会话级职责描述：在通用负责人章程前面加一行项目名。
 *
 * 项目名放 instructions 而不是能力包，是为了让能力包保持全局唯一、纯函数，
 * 不必按项目重建（重建会牵动注册表与会话选择，容易漏）。
 */
function projectLeaderCharter(projectName: string): string {
	return [`你是「${projectName}」项目的负责人。`, PROJECT_LEADER_CHARTER].join("\n");
}

function renderProjectBrief(options: CreateProjectOptions): string {
	return [
		`# ${options.name}`,
		"",
		"## 需求摘要",
		"",
		options.brief,
		"",
		"## 验收标准",
		"",
		options.acceptance ?? "待 CPO 补充。",
		"",
	].join("\n");
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
