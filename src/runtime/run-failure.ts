/**
 * 让「模型调用失败」这条路径也能落盘。
 *
 * 背景（OPS-20261025-04，真实事故）：
 * 老板发一条消息，模型返回 401 invalid_api_key，`pi.generation` 任务以
 * `state.outcome.status = "failed"` 结束。但 app.log 里**什么都没有**。
 *
 * 因果链（读 `@earendil-works/pi-durable` 源码确认）：
 * - 底层只有 `HarnessOptions.onReport` 一个上报出口；`translate()` 把它翻成我们的
 *   `RuntimeReport`（src/runtime/open.ts）。
 * - 能触发 onReport 的失败类型只有 `task_faulted`（phase 抛错 / 重启次数耗尽）、
 *   `task_error`（任务自己调 `runtime.report()`）、`task_parked` 等。
 * - 而模型调用失败走的是另一条路：`generation.js` 的 `classify()` 判定
 *   `stopReason === "error"` 且不可重试后，**在 commit 里显式返回**
 *   `outcome: { status: "failed", ... }`。按库的类型注释，`failed` 是
 *   「任务实现显式提交的预期失败」，**不是**运行时检测到的契约故障，所以库
 *   不会为它调 onReport。于是 translate() 收不到，[任务出错] 打不出来。
 *
 * ── 为什么不去观测 `Submission`（第一版走过的弯路，审计 R-01）──
 * `Conversation.submit()` 返回的 `Submission` 是**用户消息**的提交，不是生成轮次。
 * `submission.wait()` 的结局回答的是「这条用户消息最终有没有被消费」：
 * - 一轮任务里有多次 `pi.generation`，第一次生成就把 submission 结算成 `done`，
 *   后面真正的模型失败根本轮不到它观测；
 * - 若消息最终没被消费（abort / 会话被关），`wait()` 会注册进底层的 `#waiters`
 *   且**进程活多久挂多久**（`harness.close()` 不结算 `placed` 状态的 submission）。
 * 即观测点选错了，还会留下长寿命悬空 Promise。审计判定为阻断项，已改。
 *
 * ── 现在的做法 ──
 * 模型失败**必然**已经落在 `tasks` 表的 `record.state.outcome` 里
 * （`generation.js:444-451` 的 `endFailedRun(...) + outcome: {status:"failed", ...}`）。
 * 这是同一份数据、已经持久化、重启也不丢。所以这里不去挂任何监听，改为
 * **扫表**：读终态任务里 `outcome.status === "failed"` 的，补一条 `[任务出错]`。
 *
 * 只读、幂等、无长寿命 Promise；上报用的是**真实 taskId**，与
 * `[任务受阻] 1490 (pi.generation)` 等既有告警口径一致，可直接拿去做机器检索。
 */
import type { Context } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import type { RuntimeReport } from "./open.ts";

/** 一次模型失败所需的字段，全部来自 `tasks.record`。 */
export type TaskFailure = {
	readonly taskId: number;
	readonly taskKind: string;
	readonly conversationId: number;
	/** 失败原因文本（`outcome.error.message`）。 */
	readonly message: string;
	/** 结构化原因（`outcome.error.detail.reason`，模型失败时是 `model_error`）。 */
	readonly reason?: string;
	/**
	 * 工具失败的真实原因（`entry.data.diagnostics[].message`）。
	 *
	 * 为什么需要它（D-03/D-04）：工具抛错时底层把 `outcome.error.message` 固定写成
	 * `Tool ${name} threw`（`pi-durable/dist/harness/tool.js:328`），真正的异常文本
	 * 被放进了**工具结果条目**的 diagnostics。实测 task 271 的日志只有
	 * `271: Tool read threw`，而 diagnostics 里明明白白是
	 * `EISDIR: illegal operation on a directory, read`——不把它取出来，日志永远等于没说。
	 */
	readonly diagnostic?: string;
};

/** 单页最多读多少条终态任务。 */
const SCAN_LIMIT = 200;

/**
 * 一次扫描最多翻几页（= 最多看多少条终态任务）。
 *
 * 为什么要有上限：`scanTasks` 是分页的，而**必须从最新的往回翻**——
 * 只看第一页升序的话，终态任务一旦超过 `SCAN_LIMIT` 条，新失败永远落在
 * 后面几页、永远报不出来（真实库里已有 3000+ 条终态任务）。
 * 反过来翻也不会无限翻：到水位就停；万一停机很久积压超上限，
 * 少报中间那批比拖慢每轮巡检更可接受（下一轮会从新高水位继续）。
 */
const SCAN_MAX_PAGES = 5;

/** `scanTasks` 的游标类型（由库定义，这里不另立口径）。 */
type ScanCursor = Parameters<Storage["scanTasks"]>[2];

/** 从一条任务记录里读出「这次是不是失败」，不是就返回 undefined。 */
export function taskFailureOf(record: {
	readonly id: number;
	readonly kind: string;
	readonly conversationId: number;
	readonly state?: { readonly outcome?: unknown };
}): TaskFailure | undefined {
	const state = record.state as { status?: string; outcome?: unknown } | undefined;
	if (state?.status !== "terminal") return undefined;
	const outcome = state.outcome as
		| { status?: string; error?: { message?: unknown; detail?: { reason?: unknown } } }
		| undefined;
	if (outcome?.status !== "failed") return undefined;
	const message =
		typeof outcome.error?.message === "string" && outcome.error.message !== ""
			? outcome.error.message
			: "任务失败（底层未给出原因）";
	const reason = typeof outcome.error?.detail?.reason === "string" ? outcome.error.detail.reason : undefined;
	return {
		taskId: Number(record.id),
		taskKind: record.kind,
		conversationId: Number(record.conversationId),
		message,
		...(reason === undefined ? {} : { reason }),
	};
}

/**
 * 从工具结果条目里抽出第一条 error 级诊断的正文。
 *
 * 条目形状（实测 task 271 → entry 273）：
 * `{ kind: "pi.tool-result", data: { diagnostics: [{ severity, code, message }] } }`。
 * 任何形状不符都返回 undefined（尽力而为，不能因为它把巡检搞挂）。
 */
export function diagnosticOf(entry: unknown): string | undefined {
	const data = (entry as { data?: { diagnostics?: unknown } } | undefined)?.data;
	const diagnostics = data?.diagnostics;
	if (!Array.isArray(diagnostics)) return undefined;
	for (const item of diagnostics) {
		const message = (item as { message?: unknown } | undefined)?.message;
		if (typeof message === "string" && message !== "") return message;
	}
	return undefined;
}

/**
 * 取出一次失败任务的工具诊断正文（仅在任务带 `result.entryId` 时才去读条目）。
 *
 * 为什么单独一步而不是并到 `taskFailureOf` 里：`taskFailureOf` 是**纯函数**、只看 record，
 * 测试好写；而这一步要读另一个表。拆开后纯函数不变，只有需要时才付一次读取代价。
 */
export async function toolDiagnosticOf(
	record: { readonly state?: { readonly outcome?: unknown } },
	read: (entryId: number) => Promise<unknown>,
): Promise<string | undefined> {
	const outcome = (record.state as { outcome?: { status?: string; result?: { entryId?: unknown } } } | undefined)?.outcome;
	if (outcome?.status !== "failed") return undefined;
	const entryId = outcome.result?.entryId;
	if (typeof entryId !== "number") return undefined;
	try {
		return diagnosticOf(await read(entryId));
	} catch {
		return undefined;
	}
}

/** 把一次任务失败翻成落盘报告。用真实 taskId，与既有 `[任务出错] <id>: <err>` 口径一致。 */
export function reportForTaskFailure(failure: TaskFailure): RuntimeReport {
	// 有工具诊断时拼在后面：`Tool read threw` 本身不含任何可行动信息，
	// `EISDIR: illegal operation on a directory, read` 才是要修的。
	const error =
		failure.diagnostic === undefined || failure.diagnostic === failure.message
			? failure.message
			: `${failure.message}（原因：${failure.diagnostic}）`;
	return {
		kind: "task-failed",
		taskId: String(failure.taskId),
		taskKind: failure.taskKind,
		error,
	};
}

/** 失败任务扫描器：无长寿命 Promise，只维护一个「已报到哪」的水位。 */
export type FailureScanner = {
	/** 扫一轮，把还没报过的终态失败任务报给 onReport。返回本轮新报的条数。 */
	scan(context: Context): Promise<number>;
};

/**
 * 建一个失败扫描器。
 *
 * 去重：按 taskId 单调推进水位（库保证 id 递增即创建顺序），水位以内一律跳过；
 * 同一次扫描里按 id 升序处理，保证水位只前进不后退。
 * 水位只在内存里——重启后会从最新往回翻，但**只报真失败的**，且重启本身
 * 就是一次「该重新看一眼」的时机，重复报一条比漏报更可接受。
 *
 * 为什么不用 `harness.inspect()`：它只列**活任务**，任务一终结就从里面消失，
 * 正好漏掉我们要的终态 failed。所以走 `Storage.scanTasks`。
 */
export function createFailureScanner(
	// `entry` 可选：只有需要取工具诊断时才读条目（见 toolDiagnosticOf）。
	storage: Pick<Storage, "scanTasks" | "entry">,
	onReport: ((report: RuntimeReport) => void) | undefined,
): FailureScanner {
	let watermark = 0;

	return {
		async scan(context: Context): Promise<number> {
			if (onReport === undefined) return 0;
			let reported = 0;
			try {
				// 从**最新**的终态任务往回翻（descending）：只翻第一页会漏掉新失败，
				// 因为终态任务量早已超过一页（真实库 3000+ 条）。
				const collected: { readonly id: number; readonly record: unknown }[] = [];
				let cursor: ScanCursor;
				for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
					const result = await storage.scanTasks(
						{ status: "terminal", order: "descending" },
						SCAN_LIMIT,
						cursor,
						context,
					);
					const items = result.items as readonly { readonly id: number }[];
					if (items.length === 0) break;
					for (const item of items) collected.push({ id: Number(item.id), record: item });
					// 这一页最老的 id 已经在水位以内 → 再往前翻都是报过的，停。
					const oldest = Math.min(...items.map((item) => Number(item.id)));
					if (!Number.isFinite(oldest) || oldest <= watermark) break;
					cursor = result.next;
					if (cursor === undefined) break;
				}

				// 按 id 升序处理：水位单调前进，中途抛错也不会卡在中间。
				collected.sort((left, right) => left.id - right.id);
				for (const entry of collected) {
					if (entry.id <= watermark) continue;
					const failure = taskFailureOf(entry.record as never);
					if (failure !== undefined) {
						// 尽力补一条工具诊断（真实原因），失败就当没有，不影响上报。
						const diagnostic = await toolDiagnosticOf(entry.record as never, async (entryId) => {
							// storage 没有 entry（老 fake / 未来接口变动）时当作取不到，不抛。
							if (typeof storage.entry !== "function") return undefined;
							const found = await storage.entry(entryId as never, context);
							return found?.entry;
						});
						onReport(reportForTaskFailure({ ...failure, ...(diagnostic === undefined ? {} : { diagnostic }) }));
						reported += 1;
					}
					// 不是失败也要推进水位：否则每轮都会重扫同一批终态任务。
					watermark = entry.id;
				}
			} catch {
				// 扫表失败不影响业务：这只是一条「该有的日志」，不能让巡检因此挂掉。
			}
			return reported;
		},
	};
}
