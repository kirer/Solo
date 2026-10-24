/**
 * 管理层工具的**实现**。
 *
 * 这些函数需要访问公司运行时与组织操作，所以在装配时注入，
 * 工具定义本身保持纯粹（只有参数与调用逻辑）。
 */
import { BACKGROUND_CONTEXT, defineTool, Type, type CompanyRuntime, type Context } from "../runtime/index.ts";
import { MANAGEMENT_ROLES, ROLE_LABELS, type ManagementRole, type ModelRef } from "./docs.ts";
import {
	archiveStaff,
	createProject,
	hireStaff,
	listModels,
	listStaff,
	readCompany,
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
	/** 转交给另一位管理层。 */
	readonly delegateToRole?: (input: {
		readonly role: string;
		readonly task: string;
		/** 发起转交的会话，用于请求标识去重。 */
		readonly fromConversationId: number;
		readonly context: Context;
	}) => Promise<string>;
};

/** 构造全部管理层工具。 */
export function createManagementTools(deps: ToolDependencies) {
	const { runtime } = deps;

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
				lines.push(`  ${project.name} [${project.status}] 负责人会话 ${project.leader}`);
				for (const person of staff) {
					lines.push(`    - ${person.name}（${person.role}，${person.model.modelId}）`);
				}
			}
			return text(lines.join("\n"));
		},
	});

	const escalate = defineTool({
		name: "escalate",
		description: "把超出你授权范围的问题向上转交（转给 CEO，必要时由 CEO 转给老板）。",
		parameters: Type.Object({
			question: Type.String({ description: "要上报的问题，包含必要背景" }),
			reason: Type.Optional(Type.String({ description: "为什么你无法自行决断" })),
		}),
		execute: async (args, api, context) => {
			if (deps.escalate === undefined) {
				return text("升级通道未启用。");
			}
			const answer = await deps.escalate({
				question: args.reason === undefined ? args.question : `${args.question}\n\n（无法自行决断的原因：${args.reason}）`,
				from: "manager",
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
			"授权范围内能定的，直接给决定；确实只有老板能定的，把 escalate 设为 true，它会转成给老板的问题。",
			"不要滥用 escalate：每多问老板一次，就多占一次老板的注意力。",
		].join(""),
		parameters: Type.Object({
			key: Type.String({ description: "待决问题编号，如 esc:7:2" }),
			decision: Type.String({ description: "你的决定或结论" }),
			escalate: Type.Optional(
				Type.Boolean({ description: "你拍不了、必须老板定时才设为 true（会升级为老板待办）" }),
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

	const projectCreate = defineTool({
		name: "project_create",
		description: "立项：创建工作空间目录、写立项文档、建立项目负责人。",
		parameters: Type.Object({
			name: Type.String({ description: "项目显示名，可以是中文" }),
			slug: Type.String({
				description: "目录标识，必须是小写英文字母/数字/连字符，例如 tank-battle",
			}),
			brief: Type.String({ description: "需求摘要：要做什么、给谁用" }),
			acceptance: Type.Optional(Type.String({ description: "验收标准" })),
			leaderName: Type.Optional(
				Type.String({ description: "项目负责人的名字，起一个具体的人名比「负责人」更好辨认" }),
			),
		}),
		execute: async (args) => {
			// 幂等：同名项目已存在时复用，不重复建目录、不重新立项
			const existing = await readCompany(runtime, BACKGROUND_CONTEXT);
			const already = existing?.projects[args.slug];
			if (already !== undefined) {
				return text(
					[
						`项目已存在，无需重复立项：${already.name}（slug: ${already.slug}）`,
						`目录：${already.workspace}`,
						`项目负责人会话：${already.leader}`,
						"下一步：让 CHRO 用这个 slug 为项目配置员工。",
					].join("\n"),
				);
			}

			// 负责人能力包由 createProject 从装配层登记的工具集里解析，
			// 这里不需要传（见 org.ts 的 LEADER_TOOLSETS）。
			const { project } = await createProject(
				runtime,
				{
					name: args.name,
					slug: args.slug,
					brief: args.brief,
					workspaceRoot: deps.workspaceRoot,
					...(args.acceptance === undefined ? {} : { acceptance: args.acceptance }),
					...(args.leaderName === undefined ? {} : { leaderName: args.leaderName }),
				},
				BACKGROUND_CONTEXT,
			);
			return text(
				[
					`项目已立项：${project.name}`,
					`slug：${project.slug}（请让 CHRO 用这个值招人）`,
					`目录：${project.workspace}`,
					`项目负责人会话：${project.leader}`,
					"下一步：让 CHRO 为项目配置员工；之后所有派活都交给项目负责人，",
					"管理层不要直接指挥项目内员工（那是负责人的事）。",
				].join("\n"),
			);
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
		description: "为项目招聘一名员工，可指定模型。",
		parameters: Type.Object({
			project: Type.String({ description: "项目 slug" }),
			name: Type.String({ description: "员工名（项目内唯一）" }),
			role: Type.String({ description: "员工角色：产品 / 设计 / 开发 / 测试 / 运营" }),
			manager: Type.Optional(
				Type.String({ description: "直属上级岗位（ceo/cto/cfo/cpo/coo/cmo/chro），默认 cto" }),
			),
			modelId: Type.Optional(Type.String({ description: "指定模型；不传用公司默认模型" })),
		}),
		execute: async (args) => {
			const catalog = await listModels(runtime, BACKGROUND_CONTEXT);
			let model: ModelRef | undefined;
			if (args.modelId !== undefined) {
				const option = catalog.find((item) => item.id === args.modelId || item.modelId === args.modelId);
				if (option === undefined) {
					return text(`未知模型：${args.modelId}。可选：${catalog.map((item) => item.id).join(" / ")}`);
				}
				model = { provider: option.provider, modelId: option.modelId };
			}

			const manager = (args.manager ?? "cto") as ManagementRole;
			if (!MANAGEMENT_ROLES.includes(manager)) return text(`未知岗位：${manager}`);

			const hired = await hireStaff(
				runtime,
				{
					project: args.project,
					name: args.name,
					role: args.role,
					manager,
					...(model === undefined ? {} : { model }),
					...(deps.registry === undefined ? {} : { registry: deps.registry }),
					...(deps.employeeTools === undefined ? {} : { employeeTools: deps.employeeTools }),
				},
				BACKGROUND_CONTEXT,
			);

			return text(
				[
					`已招聘：${hired.staff.name}（${hired.staff.role}）`,
					`会话：${hired.conversationId}`,
					`模型：${hired.staff.model.modelId}`,
					`直属上级：${ROLE_LABELS[hired.staff.manager]}`,
				].join("\n"),
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

			const lines = [`项目 ${args.project} 的员工（派活时 employee 参数要原样填「员工名」这一列）：`];
			for (const person of staff) {
				const busy = await isBusy(runtime, person.conversationId);
				lines.push(
					`  - 员工名：${person.name}｜角色：${person.role}｜模型：${person.model.modelId}｜状态：${busy ? "忙碌" : "空闲"}｜上级：${ROLE_LABELS[person.manager]}`,
				);
			}
			return text(lines.join("\n"));
		},
	});

	/** 给员工派活（与 delegate_to_staff 等价，但参数命名更直白）。 */
	const staffAssign = defineTool({
		name: "staff_assign",
		description: [
			"给项目的某名员工派一个任务，等它做完并返回结果。employee 必须与 staff_list 里「员工名」完全一致。",
			"管理层注意：项目内员工的日常派活应该交给该项目的负责人，你只在负责人缺位或老板直接要求时亲自下场。",
		].join(""),
		parameters: Type.Object({
			project: Type.String({ description: "项目 slug，与 staff_list 里的项目一致" }),
			employee: Type.String({ description: "员工名，必须与 staff_list 显示的完全一致" }),
			task: Type.String({ description: "要它做的事：越具体越好，说明交付物" }),
		}),
		execute: async (args, api, context) => {
			if (deps.delegate === undefined) return text("派活通道未启用。");

			// 先校验员工存在，给出可操作的错误，避免模型反复试错
			const staff = await listStaff(runtime, args.project, BACKGROUND_CONTEXT);
			if (staff.length === 0) {
				return text(`项目 ${args.project} 里没有任何员工。请先用 staff_list 确认项目 slug，或让 CHRO 配人。`);
			}
			const target = staff.find((person) => person.name === args.employee);
			if (target === undefined) {
				return text(
					[
						`项目 ${args.project} 里没有名为「${args.employee}」的员工。`,
						`现有员工：${staff.map((person) => person.name).join("、")}`,
						"请用上面列出的名字重新派活。",
					].join("\n"),
				);
			}

			return text(
				await deps.delegate({
					project: args.project,
					employee: target.name,
					task: args.task,
					fromConversationId: Number(api.conversationId),
					from: "管理层",
					context,
				}),
			);
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

	/** 给项目内某个员工派活。 */
	const delegateToStaff = defineTool({
		name: "delegate_to_staff",
		description: "给某个项目的员工派一个任务并等它答复。",
		parameters: Type.Object({
			project: Type.String({ description: "项目 slug" }),
			employee: Type.String({ description: "员工名" }),
			task: Type.String({ description: "要它做的事，越具体越好" }),
		}),
		execute: async (args, api, context) => {
			if (deps.delegate === undefined) return text("派活通道未启用。");
			return text(
				await deps.delegate({
					project: args.project,
					employee: args.employee,
					task: args.task,
					fromConversationId: Number(api.conversationId),
					from: "管理层",
					context,
				}),
			);
		},
	});

	/** 给项目负责人下达任务（管理层 → 负责人，负责人再往下派给员工）。 */
	const delegateToLeader = defineTool({
		name: "delegate_to_leader",
		description: [
			"把一项工作下达给某个项目的负责人，等它安排并汇报结果。",
			"**管理层推进项目工作的默认方式**：你给负责人目标与约束，负责人拆任务、派给员工、验收后回报。",
			"不要绕过负责人直接指挥项目内员工——那样负责人会被架空，进度与责任都没人兜。",
		].join(""),
		parameters: Type.Object({
			project: Type.String({ description: "项目 slug，先用 project_list 确认" }),
			task: Type.String({
				description: "要交付什么、验收口径、硬性约束。负责人据此拆活，越具体越少返工",
			}),
		}),
		execute: async (args, api, context) => {
			if (deps.delegateToLeader === undefined) return text("下达通道未启用。");
			return text(
				await deps.delegateToLeader({
					project: args.project,
					task: args.task,
					fromConversationId: Number(api.conversationId),
					context,
				}),
			);
		},
	});

	/** 给另一位管理层同级转交。 */
	const delegateToRole = defineTool({
		name: "delegate_to_role",
		description:
			"把一件事转交给另一位管理层（同级协作，不是上报）。会等它处理完并返回它的回复摘要。有先后依赖时必须一次只转交一个，拿到结果再决定下一步。",
		parameters: Type.Object({
			role: Type.String({ description: "目标岗位：cto/cfo/cpo/coo/cmo/chro" }),
			task: Type.String({ description: "要它做的事" }),
		}),
		execute: async (args, api, context) => {
			if (deps.delegateToRole === undefined) return text("转交通道未启用。");
			return text(
				await deps.delegateToRole({
					role: args.role,
					task: args.task,
					fromConversationId: Number(api.conversationId),
					context,
				}),
			);
		},
	});

	return {
		orgTree,
		escalate,
		pendingList,
		answerPending,
		reviewArchitecture,
		delegateToStaff,
		delegateToLeader,
		delegateToRole,
		decide,
		projectCreate,
		projectPlan,
		projectList,
		projectTerminate,
		projectDelete,
		staffHire,
		staffList,
		staffAssign,
		staffArchive,
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

/** 包成模型可读的文本结果。 */
function text(value: string) {
	return { output: [{ type: "text" as const, text: value }] };
}
