/**
 * 浏览器自己报上来的卡顿（`ui/app/src/lib/jank.ts`）。
 *
 * 我两次报「agent 在跑的时候页面卡死」，而我在无头 Chrome 里量出来是「长任务 0、
 * 最慢帧 17ms」—— 两边对不上，靠猜猜不完。让浏览器在真卡的时候把「卡了多久、当时
 * 在干什么」写到 `workspace/logs/jank.jsonl`，复现一次就能读。
 *
 * 还有第二份日志：底座的**运行报告**（任务抛异常、重启超限被挂起、storage 让整个
 * Session 关掉……）写 `workspace/logs/runtime.jsonl`。它们以前被底座扔掉了，症状
 * 是「这个人忽然不说话了」，而日志里一个字都没有。最近一条不正常的报告还会跟着
 * `GET /api/diag` 出去，界面上能看见。
 *
 * 诊断是「卡了多久、当时在干什么」，不是数据仓库：单条 4KB、单文件 5MB 封顶，
 * 满了就轮转一次。否则一个循环报错的页面能把工作区写爆。
 */
import { join } from "node:path";
import type { RuntimeReport } from "../runtime/index.ts";
import { appendJsonLine } from "../runtime/io.ts";

/** 诊断日志单文件上限；超过就轮转成 `.1`（只留一代，诊断不需要历史）。 */
const DIAG_FILE_LIMIT = 5 * 1024 * 1024;

/** 诊断条目里 `entries` 的字符上限。 */
const DIAG_ENTRY_LIMIT = 4 * 1024;

/** 运行报告单条上限（`stack` 可能很长，所以先量再写）。 */
const REPORT_ENTRY_LIMIT = 4 * 1024;

/** 报告种类 → 人话。写法与底座 `ReportInfo.type` 一一对应，缺一个就退回原名。 */
const REPORT_LABELS: Record<string, string> = {
	session_failed: "底座的会话失败（storage 等致命错误）",
	task_faulted: "任务抛出异常",
	task_parked: "任务连续重启超限，已挂起",
	migration_failed: "任务状态迁移失败，任务被卡住",
	task_outdated: "任务按旧定义继续跑（定义被卸载或换成不兼容的）",
	task_error: "任务运行时报错",
	extension_error: "扩展代码报错",
	host_error: "宿主回调报错",
	listener_error: "监听器报错",
};

/**
 * 哪些报告算「正常现象」，不该占着界面上的「最近一条」。
 *
 * 只排除 `task_outdated`：它说的是「重启后有人按旧定义继续跑」，`reconcileZombieTasks`
 * 每次启动都会制造这种情况，把它当成故障会让真正的告警永远排在后面。
 */
const BENIGN = new Set<string>(["task_outdated"]);

/** 一条运行报告 → 一行看得懂的话。纯函数：出问题时要把这句话贴给人看。 */
export function formatRuntimeReport(report: RuntimeReport): string {
	const label = REPORT_LABELS[report.type] ?? report.type;
	const where: string[] = [];
	if (report.task !== undefined) where.push(`任务 \`${report.task.kind}\`#${report.task.id}`);
	if (report.conversationId !== undefined) where.push(`会话 ${report.conversationId}`);
	if (report.extension !== undefined) where.push(`扩展 ${report.extension}`);
	if (report.callback !== undefined) where.push(`回调 ${report.callback}`);
	if (report.reason !== undefined) where.push(`原因 ${report.reason}`);
	const head = where.length === 0 ? label : `${label}（${where.join("，")}）`;
	return report.message === undefined || report.message === "" ? head : `${head}：${report.message}`;
}

/** 把诊断的 `entries` 压到 4KB 以内：超了就截断并标记，不要静默丢字段。 */
function clipEntries(entries: unknown): unknown {
	if (entries === undefined) return undefined;
	const text = typeof entries === "string" ? entries : JSON.stringify(entries);
	if (text === undefined) return undefined;
	if (text.length <= DIAG_ENTRY_LIMIT) return entries;
	return `${text.slice(0, DIAG_ENTRY_LIMIT)}…[截断]`;
}

/** 运行报告同样不许超过单条上限；超了就把整条压成一句加原文前缀。 */
function clipReport(report: RuntimeReport): unknown {
	const text = JSON.stringify(report);
	if (text.length <= REPORT_ENTRY_LIMIT) return report;
	return { type: report.type, at: report.at, entries: `${text.slice(0, REPORT_ENTRY_LIMIT)}…[截断]` };
}


export function createDiag(workspaceRoot: string) {
	/** 最近一条「不正常」的运行报告（进程内；落盘的全文在 `logs/runtime.jsonl`）。 */
	let last: { readonly type: string; readonly at: string; readonly text: string } | undefined;

	/** 落一条诊断。写不进去不该影响任何事。 */
	async function record(body: { readonly kind?: string; readonly entries?: unknown }): Promise<{ ok: true }> {
		try {
			const file = join(workspaceRoot, "logs", "jank.jsonl");
			const entry = { ...body, entries: clipEntries(body.entries), at: new Date().toISOString() };
			await appendJsonLine(file, entry, { rotateAt: DIAG_FILE_LIMIT });
		} catch {
			/* 诊断写不进去不该影响任何事 */
		}
		return { ok: true };
	}

	/**
	 * 收一条底座的运行报告：先记在内存（给 `/api/diag` 看），再异步落盘。
	 *
	 * **同步、不抛**：这条路径挂在底座的错误出口上，在这里抛错会把「一次任务失败」
	 * 升级成别的东西。落盘失败只留一句 console.error。
	 */
	function recordRuntimeReport(report: RuntimeReport): void {
		if (!BENIGN.has(report.type)) {
			last = { type: report.type, at: report.at, text: formatRuntimeReport(report) };
		}
		void appendReport(report);
	}

	async function appendReport(report: RuntimeReport): Promise<void> {
		try {
			const file = join(workspaceRoot, "logs", "runtime.jsonl");
			await appendJsonLine(file, clipReport(report), { rotateAt: DIAG_FILE_LIMIT });
		} catch (error) {
			// 报告写不进盘不许影响进程：它已经在 lastReport 里了。
			console.error("[core] 运行报告落盘失败：", (error as Error)?.message);
		}
	}

	/** 最近一条不正常报告（给 `GET /api/diag`）。没有就是 `undefined`。 */
	function lastReport(): { readonly type: string; readonly at: string; readonly text: string } | undefined {
		return last;
	}

	return { record, recordRuntimeReport, lastReport };
}

export type Diag = ReturnType<typeof createDiag>;
