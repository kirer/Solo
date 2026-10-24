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
