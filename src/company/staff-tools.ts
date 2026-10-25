/**
 * 员工按角色分配的执行工具。
 *
 * 原则：能力最小化。测试不该改产品代码，产品不该跑 shell。
 * 这不是靠提示词约束，是靠工具不存在（ADR-004）。
 */
import { createBashTool, createEditTool, createReadTool, createWriteTool, defineTool } from "../runtime/index.ts";

/** 一个角色能用哪些执行工具。 */
export type StaffToolset = {
	/** 能读文件。 */
	readonly read: boolean;
	/** 能写/改文件。 */
	readonly write: boolean;
	/** 能执行命令。 */
	readonly bash: boolean;
};

/** 各角色的工具集。 */
export const STAFF_TOOLSETS: Record<string, StaffToolset> = {
	产品: { read: true, write: true, bash: false },
	设计: { read: true, write: true, bash: false },
	开发: { read: true, write: true, bash: true },
	测试: { read: true, write: true, bash: true },
	运营: { read: true, write: false, bash: false },
};

/** 未知角色的默认值：只能读，最保守。 */
const DEFAULT_TOOLSET: StaffToolset = { read: true, write: false, bash: false };

/**
 * 按角色构造执行工具列表。
 *
 * 测试角色的 write 是给它写测试文件用的；产品代码它不该改，
 * 但做不到在文件级别隔离，所以改成「只允许写 test/ 下的文件」太难，
 * 这里退一步给 write，靠职责描述约束（记录在 ADR-014）。
 */
export function toolsForRole(role: string): ReturnType<typeof defineTool>[] {
	const toolset = STAFF_TOOLSETS[role] ?? DEFAULT_TOOLSET;
	const tools: ReturnType<typeof defineTool>[] = [];

	// 返回类型以前标成 `ReturnType<typeof createReadTool>[]`，然后每个元素 `as never`
	// 硬塞进去——类型标注在撒谎，`tsc` 完全拦不住「给测试角色塞了 bash」这类错误。
	// 现在如实标成工具注册表的类型。
	if (toolset.read) tools.push(createReadTool());
	if (toolset.write) {
		tools.push(createWriteTool());
		tools.push(createEditTool());
	}
	if (toolset.bash) tools.push(createBashTool());

	return tools;
}

/**
 * 供诊断：某角色的工具名列表。
 *
 * **从 `toolsForRole()` 推导**，不再自己写一份 if 链。
 * 以前这里是第二份映射表，改一处忘另一处时，「诊断说他有 bash」与
 * 「实际给了他什么」会静默分叉。
 */
export function toolNamesForRole(role: string): readonly string[] {
	return toolsForRole(role).map((tool) => tool.name);
}
