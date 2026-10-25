/**
 * 运行时事件落盘。
 *
 * 背景：`src/server/main.ts` 原先所有日志只走 `process.stderr.write`，
 * 进程一退出终端就丢，跨重启不可回溯，导致「定期巡检日志」无从谈起。
 *
 * 设计约束（刻意保持最小）：
 * - 只落**关键事件**，不是所有 stderr：一旦逐帧写盘会拖慢事件循环。
 * - 保留原有 stderr 输出（双写）：不改变开发者现有的终端调试习惯，
 *   落盘失败也不至于让信息彻底消失。
 * - **任何 IO 异常都不允许影响业务流程**：全部 try/catch 吞掉并降级到 stderr。
 * - 按大小简单轮转：超过上限就把当前文件改名为 `.1`（只保留一份历史），
 *   避免无限增长。不做多份滚动，够用即可。
 *
 * 为什么不用第三方日志库：项目 `dependencies` 里没有日志库，
 * 为一件「追加一行文本」的需求引入依赖不值得。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** 轮转阈值：单文件超过 5MB 就滚一份历史。 */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** 错误日志携带的堆栈帧数。3 帧辐到错在哪一行；再多是噪音（且会把单行拉得很长）。 */
const DEFAULT_STACK_FRAMES = 3;

let configuredPath: string | null = null;
let maxBytes = DEFAULT_MAX_BYTES;

/** 配置日志文件位置。未调用时不做落盘（只走 stderr），保持向后兼容。 */
export function configureEventLog(options: { readonly path: string; readonly maxBytes?: number }): void {
	configuredPath = options.path;
	if (options.maxBytes !== undefined) maxBytes = options.maxBytes;
	try {
		mkdirSync(dirname(configuredPath), { recursive: true });
	} catch {
		// 目录建不出来就退化为「不落盘」，不抛。
	}
}

/** 当前日志文件路径（测试与排查用）。 */
export function eventLogPath(): string | null {
	return configuredPath;
}

/**
 * 超过阈值就把 app.log 改名为 app.log.1。
 * 只保留一份历史：巡检关心的是「最近发生了什么」，不是完整审计。
 */
function rotateIfNeeded(path: string): void {
	try {
		if (!existsSync(path)) return;
		const { size } = statSync(path);
		if (size < maxBytes) return;
		renameSync(path, `${path}.1`); // 覆盖旧的 .1，保持单份历史
	} catch {
		// 轮转失败不阻断写入：继续往原文件追加，最多是这次没滚成。
	}
}

/**
 * 追加一条事件。
 *
 * **落盘与 stderr 各管一摊**（D-03）：
 * - 已配置落盘时：只写 app.log（应用事件的正本）。
 * - 未配置落盘时：才写 stderr，保证信息不丢。
 *
 * 为什么不再双写：launchd 的 `StandardErrorPath` 就是 `server.err.log`（见
 * scripts/ai-company-service.sh 的 write_plist）。旧实现把**同一行**又写 app.log
 * 又写 stderr，结果两个文件逐字节相同（实测 md5 都是 70ec0a1d…），
 * 既浪费一倍磁盘，也让「err.log 应该只有异常」这个预期失效——
 * 巡检时无法从 err.log 里分辨哪些是异常、哪些只是普通事件。
 * 现在：app.log = 应用事件，server.err.log = 真正的 stderr（启动讯息、未捕获异常、落盘失败）。
 *
 * @param tag  事件前缀，例如 `[任务受阻]`。保持与 stderr 文案一致，便于比对。
 * @param rest 其余文本（可为空）。
 */
export function writeEvent(tag: string, rest = ""): void {
	const line = `${new Date().toISOString()} ${tag}${rest === "" ? "" : ` ${rest}`}\n`;
	if (configuredPath !== null) {
		const path = configuredPath;
		try {
			rotateIfNeeded(path);
			appendFileSync(path, line, "utf8");
			return; // 已入正本，不再重复写 stderr
		} catch (error) {
			// 落盘失败：事件只能去 stderr（此时它是唯一的出口），并附上失败原因。
			process.stderr.write(line);
			process.stderr.write(`[日志落盘失败] ${formatError(error)}\n`);
			return;
		}
	}
	// 未配置落盘（测试 / 嵌入式使用）：退化为 stderr，保持旧行为。
	process.stderr.write(line);
}


/**
 * 把任意 `error: unknown` 摊成「一行有信息量的文本」。
 *
 * 背景（D-03/D-04）：`String(report.error)` 对 `Error` 只会得到 `"Error: <message>"`，
 * 对**字符串**（`run-failure.ts` 传的就是 `outcome.error.message`）原样回显。
 * 实测 app.log 13 行全是 `[任务出错] 271: Tool read threw`——连真正的失败原因都没有。
 *
 * 真正的原因在库里是**有的**（实测 task 271 的工具结果带
 * `diagnostics[0].message = "EISDIR: illegal operation on a directory, read"`），
 * 只是 `tool.js` 把 `outcome.error.message` 固定写成了 `Tool ${name} threw`。
 * 所以这里：字符串照旧可用，`Error` 带上 message + 前几帧堆栈。
 */
export function formatError(error: unknown, stackFrames = DEFAULT_STACK_FRAMES): string {
	if (error instanceof Error) {
		const head = `${error.name}: ${error.message}`;
		const frames = topStackFrames(error.stack, stackFrames);
		return frames.length === 0 ? head : `${head} @ ${frames.join(" <- ")}`;
	}
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/** 堆栈里 `at ...` 的前 N 帧，压成一行（落盘是单行格式，多行会打乱 grep）。 */
export function topStackFrames(stack: string | undefined, limit = DEFAULT_STACK_FRAMES): string[] {
	if (stack === undefined || stack === "") return [];
	return stack
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("at "))
		.slice(0, limit)
		.map((line) => line.slice(3)); // 去掉 `at ` 前缀，省点宽度
}

/**
 * 把运行时上报翻译成「事件前缀 + 正文」。
 *
 * 抽成纯函数放在这里（而不是写在 main.ts 里），是为了让它可被单元测试
 * 直接覆盖——main.ts 一被 import 就会启动 HTTP 服务，测不了。
 * 返回 `undefined` 表示这类上报不需要落盘（例如 `kind: "other"`）。
 */
export function describeReport(report: {
	readonly kind: string;
	readonly error?: unknown;
	readonly taskId?: string;
	readonly taskKind?: string;
	readonly extension?: string;
}): { readonly tag: string; readonly rest: string } | undefined {
	switch (report.kind) {
		case "runtime-failed":
			return { tag: "[运行时失效]", rest: formatError(report.error) };
		case "task-parked":
			return { tag: "[任务受阻]", rest: `${report.taskId} (${report.taskKind})` };
		case "task-failed":
			// 带上 taskKind：光看 taskId 分不清是模型失败还是工具失败。
			return { tag: "[任务出错]", rest: `${report.taskId} (${report.taskKind}): ${formatError(report.error)}` };
		case "extension-failed":
			return { tag: "[能力包出错]", rest: `${report.extension}: ${formatError(report.error)}` };
		default:
			// other / 未知：原实现就没有输出，这里保持一致——不落盘也不打屏。
			return undefined;
	}
}

/** 默认日志路径：<cwd>/workspace/logs/app.log（与数据库同在工作空间下）。 */
export function defaultEventLogPath(cwd = process.cwd()): string {
	return join(cwd, "workspace", "logs", "app.log");
}
