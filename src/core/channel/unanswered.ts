/**
 * 「叫了他，但他这一轮一个字都没说出来」的留痕。
 *
 * 投递本身就是「投了就走」，不等回复（见 `deliver.ts` 的头注释）。但**不等**不等于
 * **不知道**：`submit()` 返回的提交对象能等到它结算，结算是 `unanswered` 就说明
 * 这一轮他什么都没产出。那种时候频道里只剩一条占位「开始处理…」，看起来像系统挂了。
 *
 * 实测两次（都是模型引用失效）：`settings.json` 的 `defaultModel` 指向不存在的模型，
 * 每次生成都在产字之前以 `no_model` 失败，进程 0% CPU、`pi.live` 里没有 `run`、
 * 界面上没有任何错误 —— 只能靠日志猜。所以这条留痕不能不写。
 *
 * 为什么不做成轮询扫描：`harness.inspect()` 只给「还没结算」的提交（`types.d.ts:656`
 * 写的是「queued and placed submissions」），`unanswered` 是已结算状态，扫不到。
 */
import { BACKGROUND_CONTEXT, type Context } from "../runtime/index.ts";
import { fill, type TextCatalog } from "../md/catalog.ts";

/** 一次提交结算时的形态。只关心两件事：成没成（`answer` 是什么）、为什么没成。 */
type SettledLike = {
	readonly status: string;
	readonly reason?: string | undefined;
	readonly answer?: unknown;
};

/** 结算的两种终态。别的状态（例如还在排队的中间态）不会回调。 */
export type Settlement =
	| { readonly status: "done"; readonly answer: unknown }
	| { readonly status: "unanswered"; readonly reason: string | undefined };

/** 一个能等到结算的提交（`conversation.submit()` 的返回值）。 */
type AwaitableSubmission = {
	wait(context: Context): Promise<SettledLike>;
};

/**
 * 把结算原因翻成一句人话。
 *
 * 只翻我们真见过的：翻不出来就把原始原因原样贴出来 —— 编一句「未知错误」等于
 * 把唯一的线索丢掉。
 */
export function reasonText(reason: string | undefined, catalog?: TextCatalog): string {
	if (reason === undefined || reason === "") return fill(catalog, "unanswered.reason.none");
	// 两种原因共用 `no_model`：压根没配（ADR-023）和引用解析不到。提示要能指到去哪儿看。
	const known: Record<string, string> = {
		no_model: "unanswered.reason.no-model",
		aborted: "unanswered.reason.aborted",
		run_failed: "unanswered.reason.run-failed",
		model_error: "unanswered.reason.model-error",
	};
	const key = known[reason];
	return key === undefined ? reason : fill(catalog, key);
}

/** 频道里那一行留痕。`#93 叫了 @知言，但他这一轮没答上来：…` */
export function renderUnanswered(seq: number, label: string, reason: string | undefined, catalog?: TextCatalog): string {
	return fill(catalog, "unanswered.line", { seq, label, reason: reasonText(reason, catalog) });
}

/**
 * 在后台等这次提交结算；`done` 和 `unanswered` 都回调。
 *
 * 三条纪律：
 * 1. **不 await**：调用方是投递循环，等它就变成「发送方等回复」了。
 * 2. **不抛**：等待本身失败（库关了、进程在退出）不该影响任何人。
 * 3. **只回调一次**：`wait()` 的语义就是等一个终态。
 */
export function watchSettled(
	submission: AwaitableSubmission,
	onSettled: (settled: Settlement) => Promise<void>,
	context: Context = BACKGROUND_CONTEXT,
): void {
	// 底层没给可等待的提交就不做（测试替身、或将来换了 harness 都可能是这种情况）：
	// 收尾是附加物，不能因为它让投递变成失败。
	if (typeof submission?.wait !== "function") return;
	void submission
		.wait(context)
		.then(async (record) => {
			if (record.status === "done") {
				await onSettled({ status: "done", answer: record.answer }).catch(() => undefined);
				return;
			}
			if (record.status === "unanswered") {
				await onSettled({ status: "unanswered", reason: record.reason }).catch(() => undefined);
			}
		})
		.catch(() => undefined);
}
