/**
 * 执行类工具的转发。
 *
 * 业务层不能直接导入底层库（ADR-001），所以读写文件、执行命令这些
 * 内建工具的获取也走这里。
 *
 * 员工干不了活往往只有一个原因：能力包里没有这些工具。
 * 它们由 `bootstrapCompany` 的 `employeeTools` 注入，招聘时写进员工会话。
 */
import { CodingTools, createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

export { CodingTools, createBashTool, createEditTool, createReadTool, createWriteTool };

/**
 * 执行环境（文件系统 + shell）的类型。
 *
 * 底层的内建文件工具**都不接受** scope / root 参数（`createWriteTool()` 签名里
 * 根本没有这个口子），所以「只能写某个目录」必须由业务层自己包装：
 * 在 `execute()` 里用 `env.absolutePath()` 把路径归一化，再做前缀比较（ADR-035）。
 * 那个包装需要这个类型，于是它也属于防腐层要转发的东西。
 */
export type { ExecutionEnv } from "@earendil-works/pi-durable/env";
