/**
 * 全部工具：**只有一套，人人都有。**
 *
 * 这里没有「助理专用工具」和「成员工具」的分层。按身份发工具包来实现
 * 「成员不能越级」，代价是：调一个身份就要改代码重新部署，而「谁能做什么」
 * 本来该写在身份里。
 *
 * 八个工具，按「做一件事」划分，不按「谁配用」划分。同一件事的几种做法用一个
 * 工具的 `action` 枚举，而**不是**几个近义的工具名 —— 名字越多，模型选错的概率越高。
 *
 * | 工具 | 用途 |
 * |---|---|
 * | `say` | 在频道说一句；带 `mention` 就是提问并叫醒对方 |
 * | `chats` | `list` 列我在的会话和未读；`read` 读历史消息；`create` 拉一个群 |
 * | `read_history` | `scope=channel` 翻自己的对话（含压缩掉的）；`scope=memory` 翻记忆 |
 * | `remember` | 记一条经验（个人 / 团队） |
 * | `hire` | 新建一个 agent（写文件夹） |
 * | `route` | 助理把一条消息在后台交给该看的人（频道里不显示转交） |
 * | `run` | 执行命令 |
 * | `file` | `read` / `write` 工作区里的一个文件 |
 *
 * 每一个工具返回**自然语言**，不是结构化数据 —— 工具的输出是给模型读的。
 */
import type { ToolRegistration } from "../../runtime/index.ts";
import { createChatsTool } from "./chats.ts";
import { createFileTool } from "./file.ts";
import { createHireTool } from "./hire.ts";
import { createHistoryTool } from "./history.ts";
import { createRememberTool } from "./remember.ts";
import { createRouteTool } from "./route.ts";
import { createRunTool } from "./run.ts";
import { createSayTool } from "./say.ts";
import type { CoreToolDeps } from "./context.ts";
import {
	traced,
	traceChats,
	traceFile,
	traceHire,
	traceHistory,
	traceRemember,
	traceRoute,
	traceRun,
	traceSay,
	tracesOf,
	type ToolTrace,
} from "./presentation.ts";

export type { CoreToolDeps } from "./context.ts";
export { clip, isPass, monologueOpener, resolveInWorkspace } from "./guards.ts";
export type { ToolTrace } from "./presentation.ts";

/**
 * 建工具。返回一个扩展，装进所有 agent 的会话里。
 *
 * 每个工具在**注册这一行**登记它在轨迹里怎么画（`presentation.ts`）：投影层按名字查，
 * 不认识任何具体工具。
 */
export function createCoreTools(deps: CoreToolDeps) {
	return [
		traced(createSayTool(deps), traceSay),
		traced(createChatsTool(deps), traceChats),
		traced(createHistoryTool(deps), traceHistory),
		traced(createRememberTool(deps), traceRemember),
		traced(createHireTool(deps), traceHire),
		traced(createRouteTool(deps), traceRoute),
		traced(createRunTool(deps), traceRun),
		traced(createFileTool(deps), traceFile),
	] as readonly ToolRegistration[];
}

/** 核心工具的轨迹表。投影层拿它当默认值（生产走注册表，插件工具也能带上）。 */
export function coreToolTraces(): ReadonlyMap<string, ToolTrace> {
	return tracesOf(createCoreTools({} as never));
}

/**
 * 工具名。插件装载时拿它当保留字：插件工具和核心工具同名，就等于把 `say` 换成了
 * 别人写的一个同名函数，而模型分不出来。
 *
 * 直接问建出来的那八个，不维护第二份名单 —— 加一个工具时不会漏。
 */
export function coreToolNames(): readonly string[] {
	return createCoreTools({} as never).map((tool) => (tool as { name: string }).name);
}
