/**
 * 能力注册表。
 *
 * 底层库打开时校验注册表是否含三个内置任务，缺一即抛错，所以必须用底层提供的
 * 工厂创建，不能自造。同名能力包重复注册表现为「替换」，不是追加——这是热更新
 * 角色定义的基础。
 */
import {
	createRegistry as createDurableRegistry,
	defineExtension,
	type Extension,
	type Registry,
} from "@earendil-works/pi-durable";

export type { Extension, Registry };

/** 创建一个空的注册表。 */
export function createRegistry(): Registry {
	return createDurableRegistry();
}

/** 空的占位能力包，用于注册表初始化时占位。 */
export const PLACEHOLDER_EXTENSION: Extension = defineExtension({ name: "placeholder" });

/** 注册一组能力包，返回注册表本身以便链式调用。 */
export function installAll(registry: Registry, extensions: readonly Extension[]): Registry {
	for (const extension of extensions) registry.install(extension);
	return registry;
}

/** 当前注册表中已安装的能力包名称，用于诊断。 */
export function installedNames(registry: Registry): readonly string[] {
	return registry.snapshot().installed().map((extension) => extension.name);
}

// ── 供业务层构造能力包与文档用的构造器 ──────────────────────────────────
// 业务层不能直接导入底层库（ADR-001），所以这里把构造器转发出去。
export {
	defineDoc,
	defineEntry,
	defineExtension,
	defineTask,
	defineTool,
	hook,
	section,
	wrapSection,
	wrapTool,
} from "@earendil-works/pi-durable";

// `configure` 在提交内改会话的 agent 配置；招聘员工时需要与创建同批完成。
export { configure } from "@earendil-works/pi-durable";

// TypeBox 构造器：工具参数 schema 需要，业务层通过这里取，不直接依赖 pi-ai。
export { Type } from "@earendil-works/pi-ai";

// Context：工具执行时由底层传入；业务层偶尔需要构造一个后台 context。
export { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";

// 任务类型：业务层需要声明任务句柄的类型。
export type { Task, TaskDefinition, TaskRuntime } from "@earendil-works/pi-durable";
