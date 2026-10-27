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

/** 上级没写职责时的一句兜底：不编造业务内容，只交代纪律。 */
const EMPTY_DUTY = "只做被指派的工作，遇到不确定的事上报。";

/**
 * 员工实际收到的职责描述（职责自由文本 + 汇报关系）。
 *
 * 这里以前按 `role` 查一张 5 条的模板表，配一个 `?? 你是${role}…` 的兜底。
 * 现在职责是**招聘时上级写下来的一段话**（`staff_hire` 的 `duty`），
 * 角色名只是名册上的标签，不再决定提示词内容——否则「前端」这类
 * 表里没有的角色名会静默拿到一句通用模板，谁也不知道它是干什么的。
 *
 * 单独导出：职工档案接口（`GET /api/profile/:conversationId`）要如实展示
 * 「这位员工被交代了什么」，不能自己去拼一份文案——拼出来的文案和真实
 * 提示词一不一致，老板看到的档案就是假的。
 */
export function staffCharterOf(input: {
	readonly duty: string;
	readonly projectName: string;
	readonly managerLabel: string;
}): string {
	const base = input.duty.trim() === "" ? EMPTY_DUTY : input.duty.trim();
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
		readonly duty: string;
		readonly projectName: string;
		readonly manager: ManagerRef;
		readonly extra?: string;
	},
): string {
	const lines = [
		staffCharterOf({
			duty: input.duty,
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
