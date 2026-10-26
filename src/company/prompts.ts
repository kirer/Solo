/**
 * 职责描述（提示词）的唯一生成入口。
 *
 * 为什么单独一个文件：`org.ts` 有两千多行，其中最容易被单独审查、也最容易被
 * 别处误抄一份的就是这几段文案。把它们集中在这里，好处有两条：
 *
 * 1. **档案页与真实提示词同源**。`GET /api/profile/:conversationId` 要如实展示
 *    「这位员工被交代了什么」。以前它在 `server/profile.ts` 里自己拼一份文案，
 *    拼出来的和真正 configure 进去的一不一致，老板看到的档案就是假的。
 * 2. **改文案不改逻辑**。招聘、变更上级、迁移、启动修复四处都调这里，
 *    动这几段字不需要碰装配代码，也不容易顺手改坏别的东西。
 *
 * 本文件是纯函数集合，不依赖 `org.ts`（否则 org → prompts → org 会成环）。
 */
import { PROJECT_LEADER_CHARTER } from "./tools.ts";
import { type ManagerRef, managerLabelOf, type CompanyState } from "./docs.ts";

/** 角色模板：员工的职责描述（由 CHRO 招聘时预设）。 */
const STAFF_ROLE_TEMPLATES: Record<string, string> = {
	产品: "你是产品经理。负责需求分析、撰写 PRD、定义验收标准。不要写代码。遇到需求冲突上报 CPO。",
	设计: "你是 UI/UX 设计师。负责交互方案与视觉方向。输出设计说明与原型描述。遇到技术限制上报 CTO。",
	开发: "你是开发工程师。负责编码实现与单元测试。遇到技术选型问题上报 CTO。不要改动需求定义。",
	测试: "你是测试工程师。负责用例设计、执行验证、编写缺陷报告。不要修改产品代码。遇到标准不清上报 CPO。",
	运营: "你是运营。负责推进节奏与交付跟进。遇到排期冲突上报 COO。",
};

/**
 * 员工实际收到的职责描述（角色模板 + 汇报关系）。
 *
 * 单独导出：职工档案接口（`GET /api/profile/:conversationId`）要如实展示
 * 「这位员工被交代了什么」，不能自己去拼一份文案——拼出来的文案和真实
 * 提示词一不一致，老板看到的档案就是假的。
 */
export function staffCharterOf(input: {
	readonly role: string;
	readonly projectName: string;
	readonly managerLabel: string;
}): string {
	const base =
		STAFF_ROLE_TEMPLATES[input.role] ?? `你是${input.role}。只做被指派的工作，遇到不确定的事上报。`;
	return [
		base,
		`你隶属于「${input.projectName}」项目，直属上级是 ${input.managerLabel}。`,
		"你只与你的直属上级沟通，不越级。",
	].join("\n");
}

/**
 * 员工职责描述的唯一生成入口。
 *
 * 招聘、变更上级、迁移三处都走这里：提示词里写着「直属上级是 XXX」，
 * 只改索引不改提示词，员工会继续以为自己在向旧上级汇报。
 */
export function staffInstructionsFor(
	state: CompanyState | undefined,
	input: {
		readonly role: string;
		readonly projectName: string;
		readonly manager: ManagerRef;
		readonly extra?: string;
	},
): string {
	const lines = [
		staffCharterOf({
			role: input.role,
			projectName: input.projectName,
			managerLabel: managerLabelOf(state, input.manager),
		}),
	];
	if (input.extra !== undefined && input.extra !== "") lines.push(input.extra);
	return lines.join("\n");
}

/**
 * 负责人的会话级职责描述：在通用负责人章程前面加一行项目名。
 *
 * 项目名放 instructions 而不是能力包，是为了让能力包保持全局唯一、纯函数，
 * 不必按项目重建（重建会牵动注册表与会话选择，容易漏）。
 */
export function projectLeaderCharter(projectName: string): string {
	return [`你是「${projectName}」项目的负责人。`, PROJECT_LEADER_CHARTER].join("\n");
}

/**
 * 立项文档内容。
 *
 * 入参刻意用结构类型而不是 `CreateProjectOptions`：那个类型定义在 `org.ts`，
 * 引进来会让 org ↔ prompts 成环。
 */
export function renderProjectBrief(options: {
	readonly name: string;
	readonly brief: string;
	readonly acceptance?: string;
}): string {
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
