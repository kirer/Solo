/**
 * 员工的**原子执行工具表**（能力目录里的 exec 层）。
 *
 * 原则：能力最小化。测试不该改产品代码，产品不该跑 shell。
 * 这不是靠提示词约束，是靠工具不存在（ADR-004）。
 *
 * ── 为什么不按角色查表 ──
 *
 * 这里以前是 `STAFF_TOOLSETS`（5 个角色 → read/write/bash 三个布尔）
 * 加一个 `?? DEFAULT_TOOLSET` 的静默兜底。那套东西有两个毛病，同一天暴露：
 *
 * 1. 角色名是自由字符串（`staff_hire` 的 `role` 从来没有 enum），
 *    于是「前端」「backend」「Rust工程师」全部静默落进默认值 → 只读员工、
 *    不报错、不打日志。老板以为招到了一个能干活的开发。
 * 2. 能力被锁死在 5 个预设上，而老板要的是「为每个 agent 动态创建能力」。
 *
 * 现在只剩「原子工具名 → 工厂」这一张表：**给哪些工具是招聘时显式写下来的**，
 * 不再由角色名推断。
 */
import { createBashTool, createEditTool, createReadTool, createWriteTool, defineTool } from "../runtime/index.ts";
import { capabilityOf } from "./capabilities.ts";

/** 员工可能被授予的原子工具：工具名 → 工厂。 */
const STAFF_ATOMIC_TOOLS: Record<string, () => ReturnType<typeof defineTool>> = {
	read: createReadTool,
	write: createWriteTool,
	edit: createEditTool,
	bash: createBashTool,
};

/** 可授予的原子工具名（用于错误文案与档案展示）。 */
export const STAFF_ATOMIC_TOOL_NAMES: readonly string[] = Object.keys(STAFF_ATOMIC_TOOLS);

/**
 * 员工层级能吃下的能力层。
 *
 * 高于 staff 的层（leader / management / ceo）不能授予员工——那不是「配置」，
 * 是越权。校验放在这里而不是提示词里，是因为**工具不给就是不存在**（ADR-004）。
 */
const STAFF_LAYERS: ReadonlySet<string> = new Set(["universal", "exec", "staff"]);

/**
 * 校验一个工具名能不能授予员工。
 *
 * 两类失败分开报：目录里存在但层级太高（`staff_hire` 之类），与压根不存在。
 * 分开报是因为上级要据此做不同的事——前者是「你不该给」，后者是「你写错了」。
 */
function assertGrantable(name: string): void {
	const capability = capabilityOf(name);
	if (capability !== undefined && !STAFF_LAYERS.has(capability.layer)) {
		throw new Error(
			`不能授予 ${name}：它属于「${capability.layer}」层，员工只吃 universal / exec / staff 层（ADR-004：权限靠工具不存在，不靠提示词）。`,
		);
	}
	if (STAFF_ATOMIC_TOOLS[name] === undefined) {
		throw new Error(
			`未知工具：${name}。可授予的原子工具：${STAFF_ATOMIC_TOOL_NAMES.join(" / ")}。`,
		);
	}
}

/** 校验一批工具名（空数组合法：那是「不给执行工具」，不是错误）。 */
export function assertGrantableTools(names: readonly string[]): void {
	for (const name of names) assertGrantable(name);
}

/**
 * 招聘入口的显式性检查：`tools` 必须真的写了。
 *
 * 为什么必须报错而不是兜底：静默兜底就是原来的 bug 本身。少给一个工具的
 * 代价，老板要等到员工干不了活、任务卡住才发现；报错当场就能改。
 */
export function assertToolsRequested(names: readonly string[] | undefined): void {
	if (names === undefined || names.length === 0) {
		throw new Error(
			'未指定 tools。请显式列出要授予的原子工具，例如 ["read","write","edit"]。可用工具见 my_capabilities。',
		);
	}
}

/**
 * 按工具名构造执行工具列表。
 *
 * 顺序即入参顺序，重复名只保留一次——重复授予不该让同一个工具装两遍。
 */
export function toolsForNames(names: readonly string[]): ReturnType<typeof defineTool>[] {
	const tools: ReturnType<typeof defineTool>[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) continue;
		assertGrantable(name);
		seen.add(name);
		const factory = STAFF_ATOMIC_TOOLS[name];
		if (factory === undefined) continue;
		tools.push(factory());
	}
	return tools;
}
