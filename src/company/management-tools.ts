/**
 * 管理层工具的**实现**。
 *
 * 这些函数需要访问公司运行时与组织操作，所以在装配时注入，
 * 工具定义本身保持纯粹（只有参数与调用逻辑）。
 */
import type { DecisionTopic } from "./decision-routing.ts";
import { BACKGROUND_CONTEXT, defineTool, Type, type CompanyRuntime, type Context } from "../runtime/index.ts";
import {
	MANAGEMENT_ROLES,
	ROLE_LABELS,
	managerLabelOf,
	resolveModelOption,
	type ManagementRole,
	type ModelRef,
} from "./docs.ts";
import { createRoundtableTools } from "./roundtable-tools.ts";
import { createUniversalTools } from "./tools/universal.ts";
import { createMemoryTools } from "./memory.ts";
import { createDispatchTools } from "./tools/dispatch.ts";
import {
	archiveStaff,
	createProject,
	hireStaff,
	listModels,
	listStaff,
	readCompany,
	reassignStaff,
	renameStaff,
	setProjectStatus,
	terminateProject,
	deleteProject,
} from "./org.ts";

/** 工具实现所需的依赖。 */
export type ToolDependencies = {
	readonly runtime: CompanyRuntime;
	/** 工作空间根目录。 */
	readonly workspaceRoot: string;
	/** 升级请求的投递函数（由升级链模块提供）。 */
	readonly escalate?: (input: {
		readonly question: string;
		readonly from: string;
		readonly conversationId: number;
		readonly project?: string;
		/** 事项类别（ADR-026 决策 2）：决定该由谁拍，不传则沿汇报线上行。 */
		readonly topic?: DecisionTopic;
	}) => Promise<string>;
	/** 列出等着本会话拍板的问题。 */
	readonly pendingList?: (input: {
		readonly conversationId: number;
	}) => Promise<string>;
	/** 回答一条等本会话拍板的问题（CEO 专用）。 */
	readonly answerPending?: (input: {
		readonly key: string;
		readonly answer: string;
		readonly escalate?: boolean;
		readonly conversationId: number;
	}) => Promise<string>;
	/**
	 * 处置一条等本会话拍板的问题：驳回 / 标记已解决。
	 *
	 * 与 answerPending 并列而不是合并：答复是「给决定、工作继续」，
	 * 处置是「这条到此为止」。合并会让模型分不清「我拍了个板」与「我关掉它」。
	 */
	readonly disposePending?: (input: {
		readonly key: string;
		readonly status: "rejected" | "resolved";
		readonly reason?: string;
		readonly conversationId: number;
	}) => Promise<string>;
	/** CEO 把老板级待办接管回自己层（Defect B 要求 3）。 */
	readonly takeOverPending?: (input: {
		readonly key: string;
		readonly reason?: string;
		readonly conversationId: number;
	}) => Promise<string>;
	/** 拍板记录函数。 */
	readonly decide?: (input: {
		readonly decision: string;
		readonly from: string;
		readonly conversationId: number;
	}) => Promise<void>;
	/** 成本报告函数。 */
	readonly costReport?: (input: { readonly project?: string }) => Promise<string>;
	/** 能力注册表，招聘员工时用于注册员工能力包。 */
	readonly registry?: import("../runtime/index.ts").Registry;
	/** 员工可用的执行类工具。 */
	readonly employeeTools?: readonly ReturnType<typeof defineTool>[];
	/** 给员工派活。 */
	readonly delegate?: (input: {
		readonly project: string;
		readonly employee: string;
		readonly task: string;
		readonly fromConversationId: number;
		readonly from: string;
		/** 工具调用上下文：把 abortSignal 传下去，老板「立即处理」时能中断等待。 */
		readonly context: Context;
	}) => Promise<string>;
	/** 给项目负责人下达任务（管理层推进项目工作的正道）。 */
	readonly delegateToLeader?: (input: {
		readonly project: string;
		readonly task: string;
		readonly fromConversationId: number;
		readonly context: Context;
	}) => Promise<string>;
	/** 圆桌讨论的默认参与者超时（毫秒）；不传用 120s。 */
	readonly roundtableTimeoutMs?: number;
	/** 转交给另一位管理层。 */
	readonly delegateToRole?: (input: {
		readonly role: string;
		readonly task: string;
		/** 发起转交的会话，用于请求标识去重。 */
		readonly fromConversationId: number;
		readonly context: Context;
	}) => Promise<string>;
	/** 变更员工直属上级（由组织操作实现）。 */
	readonly reassignStaff?: (input: {
		readonly project: string;
		readonly name: string;
		readonly manager: string;
		readonly by: string;
		readonly fromConversationId: number;
	}) => Promise<string>;
	/** 推进项目状态（由组织操作实现）。 */
	readonly setProjectStatus?: (input: {
		readonly project: string;
		readonly status: string;
		readonly by: string;
		readonly fromConversationId: number;
	}) => Promise<string>;
};

/** 构造全部管理层工具。 */
export function createManagementTools(deps: ToolDependencies) {
	const { runtime } = deps;

	// 圆桌讨论：机制在 roundtable.ts，这里只取两个工具入口。
	// 装配层不需要额外接线——注册表已在 deps 里，任务能力包首次调用时自动补装。
	const roundtableTools = createRoundtableTools({
		runtime,
		...(deps.registry === undefined ? {} : { registry: deps.registry }),
		...(deps.roundtableTimeoutMs === undefined ? {} : { timeoutMs: deps.roundtableTimeoutMs }),
	});

	// 通用工具（say / ask / read_channel / inbox / task_* / whoami）：
	// 每个 agent 都该有，所以在这里统一构造，随 ManagementToolset 一起下发。
	const universal = createUniversalTools({ runtime });
	// 记忆工具（#12）：写/查分层经验。构造很轻（只包一层 IO）。
	const memoryTools = createMemoryTools(runtime);
	// 派活工具（异步版）：assign_task / ask_role / project_create
	const dispatch = createDispatchTools({ runtime });

	const orgTree = defineTool({
		name: "org_tree",
		description: "查看公司组织架构：管理层岗位、项目清单、各项目员工。",
		parameters: Type.Object({}),
		execute: async () => {
			const state = await readCompany(runtime, BACKGROUND_CONTEXT);
			if (state === undefined) return text("公司尚未初始化。");

			const lines = [`公司：${state.company.name}`, "", "管理层："];
			for (const role of MANAGEMENT_ROLES) {
				lines.push(`  ${ROLE_LABELS[role]}（会话 ${state.roles[role]}）`);
			}
			lines.push("", "项目：");
			const projects = Object.values(state.projects);
			if (projects.length === 0) lines.push("  （暂无）");
			for (const project of projects) {
				const staff = Object.values(state.staff).filter(
					(staff) => staff.project === project.slug && !staff.archived,
				);
				lines.push(
					`  ${project.name} [${project.status}] 负责人 ${project.leaderName}（会话 ${project.leader}，工具：${await toolNamesOf(runtime, project.leader)}）`,
				);
				for (const person of staff) {
					lines.push(
						`    - ${person.name}（${person.role}，${person.model.modelId}，工具：${await toolNamesOf(runtime, person.conversationId)}）`,
					);
				}
			}
			return text(lines.join("\n"));
		},
	});

	/**
	 * 能力自查：返回本会话**真实**的工具清单。
	 *
	 * 为什么必须有：模型对自己「能不能做某件事」的判断经常来自旧记忆或旧台账。
	 * 工具是在会话中途变化的（例如负责人新增了执行工具），只靠 system 增量消息
	 * 不够；给一个能当场查的工具，比反复在提示词里强调更可靠。
	 */
	const myCapabilities = defineTool({
		name: "my_capabilities",
		description:
			"查看你自己当前实际可用的工具清单与工作目录。回答「我能不能做某事 / 有没有权限」之前先调用它，或实际试一次；不要凭记忆或旧台账回答。",
		parameters: Type.Object({}),
		execute: async (_args, api) => {
			const conversation = await runtime.harness.conversation(Number(api.conversationId) as never, BACKGROUND_CONTEXT);
			const agent = await conversation?.agent(BACKGROUND_CONTEXT);
			if (agent === undefined) return text("找不到当前会话的配置。");
			// 直接可用的 + 延迟加载的都要算：延迟工具虽然当前没出现在面前，
			// 但用 tool_search 能找到，属于「能做」。漏掉它们会让模型误报「没有这个能力」。
			const direct = agent.tools.map((tool) => tool.name);
			const deferred = agent.deferred.map((tool) => tool.name);
			const names = [...direct, ...deferred];
			return text(
				[
					`工作目录：${agent.cwd ?? "（无）"}`,
					`可用工具（${names.length} 个）：${names.join("、")}`,
					deferred.length === 0
						? ""
						: `其中 ${deferred.length} 个按需加载（用 tool_search 搜索后即可调用）：${deferred.join("、")}`,
					"判断能否做某件事，以这份清单为准；清单里没有的能力，如实说「没有」并上报，不要猜。",
					"提醒：平台是单进程单库。不要启动第二个平台实例或重启服务，那会让当前服务崩溃。",
				].join("\n"),
			);
		},
	});

	const escalate = defineTool({
		name: "escalate",
		description:
			"把超出你授权范围的问题向上转交：员工转给直属上级（岗位或项目负责人），管理层转给 CEO；确实该老板定的由 CEO 再往上递。",
		parameters: Type.Object({
			question: Type.String({ description: "要上报的问题，包含必要背景" }),
			reason: Type.Optional(Type.String({ description: "为什么你无法自行决断" })),
			topic: Type.Optional(
				Type.Union(
					[
						Type.Literal("company-level"),
						Type.Literal("domain"),
						Type.Literal("project"),
						Type.Literal("unclassified"),
					],
					{
						description: [
							"这条问题属于哪一类（决定该由谁拍，ADR-026 决策 2）。",
							"company-level：立项/砍项目/预算上限/对外承诺/组织架构——只有老板能定。",
							"domain：技术选型/需求优先级/预算内支出与招聘——本领域管理层定。",
							"project：本项目排期/任务拆分/员工间调配/退回不合格产出——项目负责人定。",
							"unclassified：说不清就沿汇报线上行（默认，不要随手用它推到老板）。",
						].join(" "),
					},
				),
			),
		}),
		execute: async (args, api, context) => {
			if (deps.escalate === undefined) {
				return text("升级通道未启用。");
			}
			const answer = await deps.escalate({
				question: args.reason === undefined ? args.question : `${args.question}\n\n（无法自行决断的原因：${args.reason}）`,
				from: "上报",
				...(args.topic === undefined ? {} : { topic: args.topic }),
				conversationId: Number(api.conversationId),
			});
			void context;
			return text(answer);
		},
	});

	/** 老板只该被 CEO 打扰：CEO 的待决队列在这里看、在这里答。 */
	const pendingList = defineTool({
		name: "pending_list",
		description:
			"列出等着你拍板的待决问题（其他管理层与项目负责人上报上来的）。只有在这里的条目才是到你这一级的；老板那级的问题不在这里。",
		parameters: Type.Object({
			includeAnswered: Type.Optional(Type.Boolean({ description: "是否连已答复的一起列出，默认只看未答复" })),
		}),
		execute: async (_args, api) => {
			if (deps.pendingList === undefined) return text("待决队列未启用。");
			return text(await deps.pendingList({ conversationId: Number(api.conversationId) }));
		},
	});

	const answerPending = defineTool({
		name: "answer_pending",
		description: [
			"回答一条待决问题（先用 pending_list 拿 key）。",
			"授权范围内能定的，直接给决定。",
			"确实只有老板能定的，把 escalate 设为 true：它会先沿升级链往上一级交付，不会跳过 CEO 直达老板。",
			"（例外：CEO 本人设为 true 时，就是 CEO 判断「只能老板定」，会直接递老板——这正是 CEO 的职责。）",
			"不要滥用 escalate：每多问老板一次，就多占一次老板的注意力。",
		].join(""),
		parameters: Type.Object({
			key: Type.String({ description: "待决问题编号，如 esc:7:2" }),
			decision: Type.String({ description: "你的决定或结论" }),
			escalate: Type.Optional(
				Type.Boolean({
					description: "你拍不了、必须往上交付时设为 true。会沿升级链上一级，不会跳过 CEO 直达老板",
				}),
			),
		}),
		execute: async (args, api) => {
			if (deps.answerPending === undefined) return text("拍板通道未启用。");
			return text(
				await deps.answerPending({
					key: args.key,
					answer: args.decision,
					...(args.escalate === true ? { escalate: true } : {}),
					conversationId: Number(api.conversationId),
				}),
			);
		},
	});

	const disposePending = defineTool({
		name: "dispose_pending",
		description: [
			"处置一条待决问题：驳回（rejected）或标记已解决（resolved）。",
			"用在这条问题其实已经有结论、或根本不需要你拍的时候——把它从待办列表清掉，别再占着看板。",
			"驳回必须给 reason（为什么不认可它）；标记已解决可省略理由。",
			"不要用它代替 answer_pending：要给决定、让工作继续走，用 answer_pending。",
		].join(""),
		parameters: Type.Object({
			key: Type.String({ description: "待决问题编号，如 esc:7:2（先用 pending_list 拿）" }),
			status: Type.Union([Type.Literal("rejected"), Type.Literal("resolved")], {
				description: "rejected=驳回，resolved=标记已解决",
			}),
			reason: Type.Optional(Type.String({ description: "理由（驳回必填）" })),
		}),
		execute: async (args, api) => {
			if (deps.disposePending === undefined) return text("待办处置通道未启用。");
			return text(
				await deps.disposePending({
					key: args.key,
					status: args.status,
					...(args.reason === undefined ? {} : { reason: args.reason }),
					conversationId: Number(api.conversationId),
				}),
			);
		},
	});

	/**
	 * CEO 专用：把一条老板级待办接管回自己层。
	 *
	 * 用途：上报方声明 company-level，但 CEO 复核认为「这在我授权范围内」
	 * （例如技术选型/排期被误标成公司级）——直接拉回来定，不必等老板。
	 */
	const takeOverPending = defineTool({
		name: "take_over_pending",
		description: [
			"（CEO 专用）把一条老板级待办接管回你这一层，自己定，不必等老板。",
			"用在你复核后认为「这条其实在我授权范围内」的时候——比如技术选型被误标成公司级。",
			"接管后它会从老板的待办里消失、出现在你的待办里；然后你照常 answer_pending 回答。",
			"只对 level=owner 且还没人答过的条目有效。",
		].join(""),
		parameters: Type.Object({
			key: Type.String({ description: "老板级待办的编号（先用 pending_list 拿）" }),
			reason: Type.Optional(Type.String({ description: "为什么你认为该由你定（会写进审计）" })),
		}),
		execute: async (args, api) => {
			if (deps.takeOverPending === undefined) return text("接管通道未启用。");
			return text(
				await deps.takeOverPending({
					key: args.key,
					...(args.reason === undefined ? {} : { reason: args.reason }),
					conversationId: Number(api.conversationId),
				}),
			);
		},
	});

	const decide = defineTool({
		name: "decide",
		description: "在授权范围内自己拍板，并把决定记录在案。",
		parameters: Type.Object({
			decision: Type.String({ description: "你的决定" }),
			basis: Type.Optional(Type.String({ description: "依据" })),
		}),
		execute: async (args, api) => {
			if (deps.decide !== undefined) {
				await deps.decide({
					decision: args.decision,
					from: "manager",
					conversationId: Number(api.conversationId),
				});
			}
			return text(`已决定：${args.decision}`);
		},
	});


	/** 终止项目：停掉全部在跑的活，归档员工，标记项目结束。 */
	const projectTerminate = defineTool({
		name: "project_terminate",
		description:
			"终止一个项目。会立即停掉项目负责人与全部员工正在做的工作，把它们归档，并把项目标记为已终止。数据不删除，产出文件保留。这是不可撤销的操作，执行前应当已经得到老板的明确同意。",
		parameters: Type.Object({
			project: Type.String({ description: "项目 slug，先用 project_list 确认" }),
			reason: Type.String({ description: "终止原因，会记进项目档案与审计" }),
		}),
		execute: async (args, api) => {
			const result = await terminateProject(
				runtime,
				{
					project: args.project,
					reason: args.reason,
					by: "CEO",
					fromConversationId: Number(api.conversationId),
				},
				BACKGROUND_CONTEXT,
			);
			if (!result.ok) return text(result.message);
			return text(
				[
					result.message,
					"",
					"接下来你必须问老板一个问题，不要自己决定：",
					"「项目已停下。要不要彻底删除？删除会解雇全部员工、删掉工作空间里的所有产物，且不可恢复。」",
					"等老板明确回答「删除 / 同意 / 删掉」之后，才能调用 project_delete。老板没说删就到此为止。",
				].join("\n"),
			);
		},
	});

	/**
	 * 彻底删除项目。
	 *
	 * 工具本身会校验：项目必须已终止。这是有意的两步设计——
	 * 一句话不能把正在跑的项目连根拔掉。
	 */
	const projectDelete = defineTool({
		name: "project_delete",
		description:
			"彻底删除一个已终止的项目：移除项目记录与员工名册，删除工作空间里的全部产物文件。不可恢复。只能在项目已终止、且老板在对话中明确同意删除之后调用。",
		parameters: Type.Object({
			project: Type.String({ description: "项目 slug" }),
		}),
		execute: async (args, api) => {
			const result = await deleteProject(
				runtime,
				{
					project: args.project,
					by: "CEO",
					fromConversationId: Number(api.conversationId),
				},
				BACKGROUND_CONTEXT,
			);
			return text(result.message);
		},
	});

	const projectPlan = defineTool({
		name: "project_plan",
		description: "为项目写计划文档（PLAN.md），记录里程碑与分工。",
		parameters: Type.Object({
			project: Type.String({ description: "项目 slug" }),
			plan: Type.String({ description: "计划内容（Markdown）" }),
		}),
		execute: async (args) => {
			const state = await readCompany(runtime, BACKGROUND_CONTEXT);
			const project = state?.projects[args.project];
			if (project === undefined) return text(`项目不存在：${args.project}`);

			const { writeFile } = await import("node:fs/promises");
			const { join } = await import("node:path");
			await writeFile(join(project.workspace, "PLAN.md"), args.plan, "utf8");
			return text(`计划已写入 ${join(project.workspace, "PLAN.md")}`);
		},
	});

	const projectList = defineTool({
		name: "project_list",
		description: "列出全部项目及其状态。",
		parameters: Type.Object({}),
		execute: async () => {
			const state = await readCompany(runtime, BACKGROUND_CONTEXT);
			const projects = Object.values(state?.projects ?? {});
			if (projects.length === 0) return text("暂无项目。");
			return text(
				projects
					.map((project) => `${project.slug} · ${project.name} [${project.status}] · ${project.brief}`)
					.join("\n"),
			);
		},
	});

	const staffHire = defineTool({
		name: "staff_hire",
		description:
			"为项目招聘一名员工，可指定模型与直属上级。不指定上级时，默认归本项目负责人。",
		parameters: Type.Object({
			project: Type.String({ description: "项目 slug" }),
			name: Type.String({ description: "员工名（项目内唯一）" }),
			role: Type.String({ description: "员工角色：产品 / 设计 / 开发 / 测试 / 运营" }),
			manager: Type.Optional(
				Type.String({
					description:
						"直属上级：管理层岗位（ceo/cto/cfo/cpo/coo/cmo/chro），或 leader:<项目slug> 指向项目负责人。默认本项目负责人",
				}),
			),
			modelId: Type.Optional(Type.String({ description: "指定模型；不传用公司默认模型" })),
		}),
		execute: async (args) => {
			const catalog = await listModels(runtime, BACKGROUND_CONTEXT);
			let model: ModelRef | undefined;
			if (args.modelId !== undefined) {
				// 只借「识别能力」，不借「失败语义」：解析交给共享纯函数，
				// 但**认不出时必须显式报错**，绝不静默回退默认模型。
				// 理由：招聘选错模型会让员工起来 no_model 或烧错成本，必须在招聘入口拦住。
				const resolved = resolveModelOption(args.modelId, catalog);
				if (!resolved.ok) {
					return text(`未知模型：${args.modelId}。可选：${catalog.map((item) => item.id).join(" / ")}`);
				}
				model = { provider: resolved.option.provider, modelId: resolved.option.modelId };
			}

			let hired;
			try {
				hired = await hireStaff(
					runtime,
					{
						project: args.project,
						name: args.name,
						role: args.role,
						...(args.manager === undefined ? {} : { manager: args.manager }),
						...(model === undefined ? {} : { model }),
						...(deps.registry === undefined ? {} : { registry: deps.registry }),
						...(deps.employeeTools === undefined ? {} : { employeeTools: deps.employeeTools }),
					},
					BACKGROUND_CONTEXT,
				);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error));
			}

			const state = await readCompany(runtime, BACKGROUND_CONTEXT);
			return text(
				[
					`已招聘：${hired.staff.name}（${hired.staff.role}）`,
					`会话：${hired.conversationId}`,
					`模型：${hired.staff.model.modelId}`,
					`直属上级：${managerLabelOf(state, hired.staff.manager)}`,
				].join("\n"),
			);
		},
	});

	/** 变更已招员工的直属上级（事后调整汇报线）。 */
	const staffReassign = defineTool({
		name: "staff_reassign",
		description:
			"变更一名在职员工的直属上级。manager 填管理层岗位（ceo/cto/.../chro）或 leader:<本项目的slug>（表示项目负责人）。",
		parameters: Type.Object({
			project: Type.String({ description: "员工所属项目 slug" }),
			name: Type.String({ description: "员工名，与 staff_list 显示的一致" }),
			manager: Type.String({
				description: "新上级：岗位名，或 leader:<本项目slug>；不允许指向别的项目的负责人",
			}),
		}),
		execute: async (args, api) => {
			if (deps.reassignStaff === undefined) return text("变更上级通道未启用。");
			return text(
				await deps.reassignStaff({
					project: args.project,
					name: args.name,
					manager: args.manager,
					by: String(api.conversationId),
					fromConversationId: Number(api.conversationId),
				}),
			);
		},
	});

	/** 推进项目状态（planning → active → paused/done）。 */
	const projectStatusSet = defineTool({
		name: "project_status",
		description:
			"推进项目状态。允许：planning→active；active↔paused；active/paused→done。终止项目用 project_terminate，不在这里。",
		parameters: Type.Object({
			project: Type.String({ description: "项目 slug" }),
			status: Type.String({ description: "目标状态：active / paused / done" }),
		}),
		execute: async (args, api) => {
			if (deps.setProjectStatus === undefined) return text("项目状态通道未启用。");
			return text(
				await deps.setProjectStatus({
					project: args.project,
					status: args.status,
					by: String(api.conversationId),
					fromConversationId: Number(api.conversationId),
				}),
			);
		},
	});

	const staffList = defineTool({
		name: "staff_list",
		description: "列出某项目的员工及其角色、模型、状态。",
		parameters: Type.Object({
			project: Type.String({ description: "项目 slug" }),
		}),
		execute: async (args) => {
			const staff = await listStaff(runtime, args.project, BACKGROUND_CONTEXT);
			if (staff.length === 0) return text(`项目 ${args.project} 暂无员工。`);

			const state = await readCompany(runtime, BACKGROUND_CONTEXT);
			const lines = [`项目 ${args.project} 的员工（派活时 employee 参数要原样填「员工名」这一列）：`];
			for (const person of staff) {
				const busy = await isBusy(runtime, person.conversationId);
				lines.push(
					`  - 员工名：${person.name}｜角色：${person.role}｜模型：${person.model.modelId}｜状态：${busy ? "忙碌" : "空闲"}｜上级：${managerLabelOf(state, person.manager)}｜工具：${await toolNamesOf(runtime, person.conversationId)}`,
				);
			}
			return text(lines.join("\n"));
		},
	});


	const staffArchive = defineTool({
		name: "staff_archive",
		description: "归档（软删除）一名员工。",
		parameters: Type.Object({
			project: Type.String({ description: "项目 slug" }),
			name: Type.String({ description: "员工名" }),
		}),
		execute: async (args) => {
			const ok = await archiveStaff(runtime, args.project, args.name, BACKGROUND_CONTEXT);
			return text(ok ? `已归档 ${args.name}。` : `未找到员工 ${args.name}。`);
		},
	});

	/**
	 * 给在职员工改名。
	 *
	 * 不只是显示名：名册键与员工能力包名都由员工名派生，所以工具会同时重建能力包，
	 * 让员工改名后立刻拥有和新名字匹配的工具（否则下一轮会「没有任何工具」）。
	 */
	const staffRename = defineTool({
		name: "staff_rename",
		description:
			"给一名在职员工改名。名字是公司内显示名，也是名册键与能力包名的一部分；改名后该员工的工具、历史对话与汇报关系都保留。",
		parameters: Type.Object({
			project: Type.String({ description: "员工所属项目 slug" }),
			name: Type.String({ description: "现在的名字，与 staff_list 显示的一致" }),
			newName: Type.String({ description: "新名字（项目内唯一，不能含 / 、空格）" }),
		}),
		execute: async (args, api) => {
			const result = await renameStaff(
				runtime,
				{
					project: args.project,
					name: args.name,
					newName: args.newName,
					by: String(api.conversationId),
					fromConversationId: Number(api.conversationId),
					...(deps.registry === undefined ? {} : { registry: deps.registry }),
				},
				BACKGROUND_CONTEXT,
			);
			return text(result.message);
		},
	});

	const budgetCheck = defineTool({
		name: "budget_check",
		description: "查询预算与已花成本。",
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "项目 slug；不传则看全公司" })),
		}),
		execute: async (args) => {
			if (deps.costReport !== undefined) {
				return text(await deps.costReport(args.project === undefined ? {} : { project: args.project }));
			}
			return text("成本统计未启用。");
		},
	});

	const costReport = defineTool({
		name: "cost_report",
		description: "生成成本报告：按项目或按角色拆分 token 与花费。",
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "项目 slug；不传则看全公司" })),
		}),
		execute: async (args) => {
			if (deps.costReport !== undefined) {
				return text(await deps.costReport(args.project === undefined ? {} : { project: args.project }));
			}
			return text("成本统计未启用。");
		},
	});

	/** 技术评审：CTO 用它审方案，不写代码。 */
	const reviewArchitecture = defineTool({
		name: "review_architecture",
		description: "评审一个技术方案，给出结论与风险。只评审，不实现。",
		parameters: Type.Object({
			proposal: Type.String({ description: "待评审的方案描述" }),
			context: Type.Optional(Type.String({ description: "背景：项目、约束、时间" })),
		}),
		execute: async (args) => {
			// 评审本身由模型完成，这里只负责把它记进审计，便于日后追溯
			if (deps.decide !== undefined) {
				await deps.decide({
					decision: `技术评审：${args.proposal.slice(0, 120)}`,
					from: "cto",
					conversationId: 0,
				});
			}
			return text(
				[
					"评审结论已记录。请在下一条回复里给出：",
					"1) 可行 / 需调整 / 不可行",
					"2) 主要风险（最多三条）",
					"3) 建议的技术路线",
				].join("\n"),
			);
		},
	});




	return {
		// 通用
		whoami: universal.whoami,
		say: universal.say,
		ask: universal.ask,
		readChannel: universal.readChannel,
		inbox: universal.inbox,
		taskList: universal.taskList,
		taskUpdate: universal.taskUpdate,
		taskCreate: universal.taskCreate,
		roundtable: roundtableTools.roundtable,
		roundtableMinutes: roundtableTools.roundtableMinutes,
		memoryWrite: memoryTools.memoryWrite,
		memorySearch: memoryTools.memorySearch,
		orgTree,
		myCapabilities,
		escalate,
		pendingList,
		disposePending,
		takeOverPending,
		answerPending,
		reviewArchitecture,
		assignTask: dispatch.assignTask,
		askRole: dispatch.askRole,
		projectCreate: dispatch.projectCreate,
		decide,
		projectPlan,
		projectList,
		projectStatusSet,
		projectTerminate,
		projectDelete,
		staffHire,
		staffReassign,
		staffList,
		staffArchive,
		staffRename,
		budgetCheck,
		costReport,
	};
}

/** 判断某个会话是否正在工作。 */
async function isBusy(runtime: CompanyRuntime, conversationId: number): Promise<boolean> {
	const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
	return inspection.tasks.some(
		(task) => Number(task.record.conversationId) === conversationId && task.state.kind !== "blocked",
	);
}

/** 某个会话当前真实可用的工具名（用 / 连接）。 */
async function toolNamesOf(runtime: CompanyRuntime, conversationId: number): Promise<string> {
	const conversation = await runtime.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
	const agent = await conversation?.agent(BACKGROUND_CONTEXT);
	const names = (agent?.tools ?? []).map((tool) => tool.name);
	return names.length === 0 ? "（无）" : names.join("/");
}

/** 包成模型可读的文本结果。 */
function text(value: string) {
	return { output: [{ type: "text" as const, text: value }] };
}
