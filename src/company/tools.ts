/**
 * 管理层的能力工具。
 *
 * 这些工具**只装在管理层与项目负责人的能力包里**，员工的能力包里一个都没有——
 * 这是「员工无法越级」的结构性保证（ADR-004）。
 *
 * 每个工具都只做一件事，并且返回值是给模型看的自然语言（output），
 * 不是给程序用的结构化数据。
 */
import { defineExtension, defineTool, Type, type Extension } from "../runtime/index.ts";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "../runtime/index.ts";
import type { ManagementRole } from "./docs.ts";
import { COMMON_GUIDE, ROLE_DEFINITIONS } from "./roles.ts";
import { splitCore } from "./capabilities.ts";
import { createToolSearchTool } from "./tools/tool-search.ts";

/**
 * 把非核心工具标成 `deferred: true`。
 *
 * 延迟工具**不直接出现在模型面前**，模型需要时用 `tool_search` 找到它
 * （BM25 检索 → `control.addTools` → 从下一次请求起就长在会话上）。
 *
 * 为什么要做：CEO 现在有 25 个工具，每轮真正用的只有 5–6 个。
 * 工具越多，选错概率越高。分层后核心 12 个、其余按需加载。
 *
 * 注意 `deferred` 是**注册属性**，不是在能力包里过滤：
 * 过滤掉就真的没了，deferred 则「看不见但找得到」。
 */
function deferNonCore(tools: readonly ReturnType<typeof defineTool>[]): ReturnType<typeof defineTool>[] {
	const names = tools.map((tool) => tool.name);
	const { core } = splitCore(names);
	const coreSet = new Set(core);
	const mapped = tools.map((tool) =>
		coreSet.has(tool.name) ? tool : ({ ...tool, deferred: true } as ReturnType<typeof defineTool>),
	);
	// tool_search 必须是核心：没有它，deferred 的工具模型永远拿不到。
	// 只在确实有延迟工具时才加（否则是个永远搜不到东西的空工具）。
	if (mapped.some((tool) => tool.deferred === true) && !mapped.some((tool) => tool.name === "tool_search")) {
		mapped.push(createToolSearchTool() as ReturnType<typeof defineTool>);
	}
	return mapped;
}

/**
 * 项目负责人的执行类工具：让负责人能真正动手（读写项目文件、在项目目录跑命令）。
 *
 * 与员工的执行工具同源（runtime/capabilities），区别只是负责人永远用它、
 * 员工按角色裁剪。负责人拿到这些工具后，「项目全部资源面」才有实际所指。
 */
export const LEADER_EXECUTION_TOOLS: readonly ReturnType<typeof defineTool>[] = [
	createReadTool(),
	createWriteTool(),
	createEditTool(),
	createBashTool(),
];

/** 工具集合：由装配层注入实际实现，避免业务模块之间循环依赖。 */
export type ManagementToolset = {
	// ── 通用（每个 agent 都有，见 tools/universal.ts）──
	/** 我是谁。 */
	readonly whoami: ReturnType<typeof defineTool>;
	/** 频道发言（不 @）。 */
	readonly say: ReturnType<typeof defineTool>;
	/** 频道提问（@ 某人）。 */
	readonly ask: ReturnType<typeof defineTool>;
	/** 读频道历史。 */
	readonly readChannel: ReturnType<typeof defineTool>;
	/** 未读汇总。 */
	readonly inbox: ReturnType<typeof defineTool>;
	/** 我的任务。 */
	readonly taskList: ReturnType<typeof defineTool>;
	/** 更新任务状态 / 记进度。 */
	readonly taskUpdate: ReturnType<typeof defineTool>;
	/** 创建任务（必须有验收标准）。 */
	readonly taskCreate: ReturnType<typeof defineTool>;
	/** 查看组织架构。 */
	readonly orgTree: ReturnType<typeof defineTool>;
	/** 查看本会话真实可用的工具清单。 */
	readonly myCapabilities: ReturnType<typeof defineTool>;
	/** 向上转一个问题。 */
	readonly escalate: ReturnType<typeof defineTool>;
	/** 列出等着自己拍板的问题。 */
	readonly pendingList: ReturnType<typeof defineTool>;
	/** 回答一条等自己拍板的问题。 */
	readonly answerPending: ReturnType<typeof defineTool>;
	/** 处置一条待办：驳回 / 标记已解决（ADR-026 缺陷 A）。 */
	readonly disposePending: ReturnType<typeof defineTool>;
	/** CEO 把老板级待办接管回自己层（ADR-026 缺陷 B）。 */
	readonly takeOverPending: ReturnType<typeof defineTool>;
	/** 自己拍板。 */
	readonly decide: ReturnType<typeof defineTool>;
	/** 立项。 */
	readonly projectCreate: ReturnType<typeof defineTool>;
	/** 写项目计划。 */
	readonly projectPlan: ReturnType<typeof defineTool>;
	/** 列出项目。 */
	readonly projectList: ReturnType<typeof defineTool>;
	/** 终止项目。 */
	readonly projectTerminate: ReturnType<typeof defineTool>;
	/** 变更项目状态（planning → active → paused/done）。 */
	readonly projectStatusSet: ReturnType<typeof defineTool>;
	/** 彻底删除项目。 */
	readonly projectDelete: ReturnType<typeof defineTool>;
	/** 招聘员工。 */
	readonly staffHire: ReturnType<typeof defineTool>;
	/** 变更员工直属上级。 */
	readonly staffReassign: ReturnType<typeof defineTool>;
	/** 列出员工。 */
	readonly staffList: ReturnType<typeof defineTool>;
	/** 建任务并派出去（异步，不等结果）。 */
	readonly assignTask: ReturnType<typeof defineTool>;
	/** 归档员工。 */
	readonly staffArchive: ReturnType<typeof defineTool>;
	/** 给员工改名。 */
	readonly staffRename: ReturnType<typeof defineTool>;
	/** 查预算。 */
	readonly budgetCheck: ReturnType<typeof defineTool>;
	/** 成本报告。 */
	readonly costReport: ReturnType<typeof defineTool>;
	/** 技术评审。 */
	readonly reviewArchitecture: ReturnType<typeof defineTool>;
	/** 找某人问一句（异步，不等结果）。 */
	readonly askRole: ReturnType<typeof defineTool>;
	/** 开一次圆桌讨论。 */
	readonly roundtable: ReturnType<typeof defineTool>;
	/** 查圆桌讨论纪要。 */
	readonly roundtableMinutes: ReturnType<typeof defineTool>;
};

/** 工具名 → 工具实例。 */
export type ToolName = keyof ManagementToolset;

/** 把角色声明里的能力名映射到实际工具。 */
const CAPABILITY_TO_TOOL: Record<string, ToolName> = {
	// 通用能力（每个 agent 都该有）
	whoami: "whoami",
	say: "say",
	ask: "ask",
	read_channel: "readChannel",
	inbox: "inbox",
	task_list: "taskList",
	task_update: "taskUpdate",
	task_create: "taskCreate",
	org_tree: "orgTree",
	my_capabilities: "myCapabilities",
	escalate: "escalate",
	pending_list: "pendingList",
	answer_pending: "answerPending",
	dispose_pending: "disposePending",
	take_over_pending: "takeOverPending",
	decide: "decide",
	review_architecture: "reviewArchitecture",
	assign_task: "assignTask",
	ask_role: "askRole",
	project_create: "projectCreate",
	project_plan: "projectPlan",
	project_list: "projectList",
	project_terminate: "projectTerminate",
	project_delete: "projectDelete",
	project_status: "projectStatusSet",
	staff_hire: "staffHire",
	staff_reassign: "staffReassign",
	staff_list: "staffList",
	staff_archive: "staffArchive",
	staff_rename: "staffRename",
	budget_check: "budgetCheck",
	cost_report: "costReport",
	roundtable: "roundtable",
	roundtable_minutes: "roundtableMinutes",
};

/**
 * 为某个岗位创建能力包，注入它的工具集合。
 *
 * 只装该岗位声明里列出的工具，其余一律不装。
 */
export function createRoleExtensionWithTools(role: ManagementRole, tools: ManagementToolset): Extension {
	const definition = ROLE_DEFINITIONS[role];
	if (definition === undefined) throw new Error(`未知岗位：${role}`);

	const selected = definition.capabilityNames
		.map((name) => CAPABILITY_TO_TOOL[name])
		.filter((name): name is ToolName => name !== undefined)
		.map((name) => tools[name]);

	return defineExtension({
		name: definition.extensionName,
		sections: [
			// 纯函数：不含时间戳（ADR-007）
			(() => {
				const charter = definition.charter;
				return { key: "role", tag: false, render: () => charter };
			})(),
			(() => {
				const guide = COMMON_GUIDE;
				return { key: "guide", tag: false, render: () => guide };
			})(),
		],
		tools: selected,
	});
}

/**
 * 项目负责人的职责描述（纯函数，ADR-007）。
 *
 * 负责人是「项目这一层的管理者」：他向下派活给项目内员工，向上找对应的管理层，
 * **绝不越级**——需求找 CPO、技术找 CTO、成本找 CFO、排期找 COO、招人找 CHRO。
 * 具体项目名由会话的 instructions 注入，能力包本身保持与项目无关（纯函数），
 * 这样整个公司只需要注册一个 `role-leader`，不必按项目重建。
 */
export const PROJECT_LEADER_CHARTER = [
	"你是某个项目的负责人，处在一个有实权的岗位上：对项目内的人、文件、运行环境负责。",
	"你的职责：把项目目标拆成可执行的任务，派给项目内员工，跟踪进度，向上汇报；需要时自己动手改文件、跑命令验证。",
	"你能直接读写本项目工作空间里的文件，并在项目目录执行命令（read / write / edit / bash）——项目里的实际工作与验收证据由你自己确认。",
	"派活用 assign_task（必须先 staff_list 看名册）；写计划用 project_plan；决定要留痕用 decide。",
	"项目状态用 project_status 推进：立项后由你把 planning 改成 active；暂停/恢复用 paused/active；做完改 done。终止项目不归你，要上报。",
	"员工上报给你的问题会出现在 pending_list 里，用 answer_pending 在授权范围内直接拍板；确实超出项目的再 escalate。",
	"你只与你的上级和项目内员工沟通，不越级：",
	"- 需求不明确、验收标准有争议 → escalate，或 ask_role 找 cpo",
	"- 技术选型、架构、执行环境/工具链故障 → escalate，或 ask_role 找 cto",
	"- 成本与预算 → escalate，或 ask_role 找 cfo",
	"- 排期与跨项目协调 → ask_role 找 coo",
	"- 缺人、要调配人手 → ask_role 找 chro",
	"你不替管理层做公司级决定：立项、终止项目、招聘、改别人项目都不在你手上。",
	"回答「我能不能改代码 / 能不能执行命令」这类问题之前，先调用 my_capabilities 看真实工具清单，或实际试一次；不要凭记忆或旧台账下结论，工具可能已经变了。",
	"不要启动、停止或重启平台服务，也不要另起一个平台实例：平台是单进程单库，第二个实例会与正在跑的服务抢同一个库并把服务弄崩。要验证执行能力，用项目内的无害命令（不要碰平台进程与端口）。",
	"权限只到本项目：不要写项目目录之外的文件，不要动其他项目与平台源码。",
	"员工交付后由你验收：看不到证据就退回重做，不要替员工宣称「已验证」。",
].join("\n");

/** 项目负责人能力包的名字。 */
export const PROJECT_LEADER_EXTENSION_NAME = "role-leader";

/**
 * 项目负责人的能力包。
 *
 * 旧版本立项时没有给负责人装任何能力包，导致他连 assign_task 都没有，
 * 只能空转、被管理层绕过——这是「负责人不参与」的结构性原因。
 *
 * 现在他同时拿两类能力：
 * - 管理类：派活、写计划、看名册、接员工上报、推进项目状态；
 * - 执行类：读写项目文件、在项目目录跑命令（由 executionTools 注入）。
 *
 * 公司级的立项/终止/招聘仍然不给——权限只到项目边界。
 */
export function createProjectLeaderExtension(
	tools: ManagementToolset,
	executionTools: readonly ReturnType<typeof defineTool>[] = LEADER_EXECUTION_TOOLS,
): Extension {
	const capabilityNames = [
		// 通用通信能力：负责人要在项目群里统筹、@ 人、看任务
		"whoami",
		"say",
		"ask",
		"read_channel",
		"inbox",
		"task_list",
		"task_update",
		"task_create",
		"org_tree",
		"my_capabilities",
		"escalate",
		"decide",
		"pending_list",
		"answer_pending",
		"dispose_pending",
		"assign_task",
		"ask_role",
		"project_plan",
		"project_list",
		"project_status",
		"staff_list",

	];

	const selected = capabilityNames
		.map((name) => CAPABILITY_TO_TOOL[name])
		.filter((name): name is ToolName => name !== undefined)
		.map((name) => tools[name]);

	return defineExtension({
		name: PROJECT_LEADER_EXTENSION_NAME,
		sections: [
			(() => {
				const charter = PROJECT_LEADER_CHARTER;
				return { key: "role", tag: false, render: () => charter };
			})(),
			(() => {
				const guide = COMMON_GUIDE;
				return { key: "guide", tag: false, render: () => guide };
			})(),
		],
		tools: deferNonCore([...selected, ...executionTools]),
	});
}

/** 创建全部岗位的能力包（带工具）。 */
export function createAllRoleExtensionsWithTools(tools: ManagementToolset): Extension[] {
	return (Object.keys(ROLE_DEFINITIONS) as ManagementRole[]).map((role) =>
		createRoleExtensionWithTools(role, tools),
	);
}

/** 已终止项目的负责人能力包名：只读，不能派活、不能执行。 */
export const PROJECT_LEADER_READONLY_EXTENSION_NAME = "role-leader-readonly";

/** 终止后的负责人职责描述（纯函数）。 */
export const PROJECT_LEADER_READONLY_CHARTER = [
	"你负责的项目已经终止，你不再推进任何工作。",
	"你只能查看项目名册与历史、向上汇报；不能派活、不能写文件、不能执行命令。",
	"如果老板要求恢复项目，请上报 CEO——恢复项目不归你决定。",
].join("\n");

/**
 * 已终止项目负责人的能力包：只读。
 *
 * 终止时用它替换 role-leader，让「权限随状态回收」成为结构事实，
 * 而不是只写在提示词里（ADR-004 / ADR-010：工具不在即无权限）。
 */
export function createProjectLeaderReadOnlyExtension(tools: ManagementToolset): Extension {
	const capabilityNames = [
		"org_tree",
		"my_capabilities",
		"escalate",
		"decide",
		"pending_list",
		"answer_pending",
		"dispose_pending",
		"project_list",
		"staff_list",
	];
	const selected = capabilityNames
		.map((name) => CAPABILITY_TO_TOOL[name])
		.filter((name): name is ToolName => name !== undefined)
		.map((name) => tools[name]);

	return defineExtension({
		name: PROJECT_LEADER_READONLY_EXTENSION_NAME,
		sections: [
			(() => {
				const charter = PROJECT_LEADER_READONLY_CHARTER;
				return { key: "role", tag: false, render: () => charter };
			})(),
			(() => {
				const guide = COMMON_GUIDE;
				return { key: "guide", tag: false, render: () => guide };
			})(),
		],
		tools: deferNonCore(selected),
	});
}

/**
 * 员工能力包：只有执行类工具，没有任何管理能力。
 *
 * **名字必须唯一**（用员工名派生）。底层按名字存会话的能力包选择，
 * 所有员工共用一个名字会导致后招聘的覆盖前面的——表现是某些员工
 * 莫名其妙没有任何工具。
 *
 * @param employeeId 员工标识（项目内唯一），用于生成能力包名
 * @param employeeTools 该员工的执行类工具
 */
export function createEmployeeExtension(
	employeeId: string,
	employeeTools: readonly ReturnType<typeof defineTool>[],
	universalTools: readonly ReturnType<typeof defineTool>[] = [],
): Extension {
	return defineExtension({
		name: `role-employee:${employeeId}`,
		sections: [
			{
				key: "employee",
				tag: false,
				render: () =>
					[
						"你是项目员工。只做被指派的工作。",
						"",
						"## 沟通（重要）",
						"你在项目群里工作：项目负责人和同事都在群里。",
						"- 有问题就在项目群里 ask（会 @ 到人并唤醒它），**不要自己猜**。",
						"- 需求没说清、字段名/格式/边界不确定、要别人拍板、你不确定自己有没有权限 —— 一律先 ask。",
						"- 猜错的代价由你承担；问一句的代价只是等几分钟。",
						"- 做完一件事在群里 say 一句结论，让负责人知道。",
						"- 有任务时用 task_update 报进度；报 done 必须带 evidence（文件路径/测试输出/提交号）。",
						"",
						"## 边界（逐级上升，不许跳级）",
						"你只对项目负责人负责。项目内的事找负责人；负责人拍不了，它会交给管理层，管理层再交给 CEO，CEO 再交给老板。",
						"**不要直接找老板**：老板级待办只能由 CEO 递上去。你越级找老板，问题反而会被退回来。",
						"确实超出项目范围的用 escalate（它沿汇报线逐级上升，不会跳过任何人）。",
						"回答「我能不能做某事」之前，先用 my_capabilities 看真实工具清单，或实际调用一次；不要凭记忆。",
						"不要启动、停止或重启平台服务，也不要另起平台实例（单进程单库，会弄崩正在跑的服务）。",
					].join("\n"),
			},
		],
		tools: deferNonCore([...universalTools, ...employeeTools]),
	});
}

/** 供测试与诊断：某个岗位声明了哪些能力名。 */
export function capabilitiesOf(role: ManagementRole): readonly string[] {
	return ROLE_DEFINITIONS[role].capabilityNames;
}
