/**
 * 职工「工作记录」流水（UX-7 的数据源）。
 *
 * 老板的口径（第三次，最终版，原话）：
 * > 「不是只是工具调用，**还是他思考过程**啊。你可以参考之前组织中点开的聊天内显示的内容。
 * >   懒加载，像正常的聊天软件一样，往上翻看历史逐步加载。」
 *
 * ── 核心取舍：**不自己解析 entries，直接复用 `readFeed`** ──
 *
 * `readFeed`（`src/server/feed.ts`）已经把底层条目加工成前端直接消费的形态，并且做了
 * 本文件重做一遍会漏掉的事：
 *
 * 1. **把 `pi.assistant` 的 `toolCall` 与 `pi.tool-result` 按 `callId` 合并成一条 `tool` 条目**
 *    （`feed.ts:563-575` + `:596-608`）。自己写就会得到「参数一条、输出另一条」的碎片。
 * 2. **区分 `thinking` / `assistant` / `tool` / `note` / `alert`**，正是老板说的「思考过程」。
 * 3. **`args` 用 `summarize()` 压成一行**（`feed.ts:742`），正是前端 `argsSummary()` 期望的输入。
 *
 * **这一条是踩过方向错误后改的**：第一版本文件自己遍历 `entries` 只取 `pi.tool-result`，
 * 结果（a）丢掉思考过程、（b）把工具参数与输出拆成两条、（c）和 `fe.readFeed` 两套解析逻辑并存，
 * 将来任一侧改动就会漂移。**接口应该迁就已有消费方，而不是平行造第二套。**
 *
 * ── 三个仍然必要的加工 ──
 *
 * 即使复用 `readFeed`，本文件仍要做三件 `feed` 不做的事：
 * - **过滤**：只要 `thinking` / `assistant` / `tool`，不要 `user`（老板自己的话已在私聊里）、
 *   不要 `note` / `alert`（系统留痕，老板说的是「他的输出」）。
 * - **截断**：`feed` 返回完整文本；实测工具输出平均 870 字、最长 23912 字，
 *   一次 30 条最坏能到几百 KB。这里给 `outputSummary`（≤300 字）。
 * - **分页**：`feed` 一次给 400 条；老板要「往上翻逐步加载」，所以要按 `id` 倒序游标切页。
 */
import { BACKGROUND_CONTEXT, type CompanyRuntime, type Context } from "../runtime/index.ts";
import { readFeed, type FeedItem } from "./feed.ts";

/** 摘要上限（字符）。 */
const SUMMARY_LIMIT = 300;

/** 默认每页条数。 */
const DEFAULT_LIMIT = 30;

/** 单页上限（防止 `?limit=100000` 把整个会话拉出来）。 */
const MAX_LIMIT = 200;

/**
 * 每条 entry 内 item 序号的「位宽」。
 *
 * 实测一个 entry 最多产出 5 条 item（1 assistant + 4 toolCall），
 * 取 1000 有 200 倍余量；同时保证 `entryId * 1000` 不会与相邻 entry 的段交叠
 * （entry id 是整数且单调递增）。
 *
 * 若将来某个 provider 单条 entry 产出超过 1000 条 item，这里的 seq 会与下一条 entry 交叠——
 * 那时用例 `每个 entry 的多条 item 都能逐条取到` 会变红，是一个**会报警**的边界，不是静默失效。
 */
export const ITEM_SEQ_STRIDE = 1000;

/** 允许出现在「工作记录」里的条目种类。 */
const KEEP_KINDS = new Set(["thinking", "assistant", "tool"]);

/** 每次向 `readFeed` 要多少条（400 是 `readFeed` 自身的默认上限）。 */
const FEED_WINDOW = 400;

/** 最多往前翻几窗（`8 × 400 = 3200` 条），防止一次请求把整库翻一遍。 */
const MAX_WINDOWS = 8;

/**
 * 工作记录的稳定分页游标。
 *
 * ── 为什么不能直接用 entry `id`（T-26 的真缺陷）──
 * 一个 entry 会产出**多条** item：实测一个 `pi.assistant` 最多产出 5 条
 * （1 条 assistant + 4 条 toolCall），而它们**共用同一个 entry id**。
 * 若游标只按 entry id 切分，跨页时「同一个 entry 内还没返回的那几条」会被整批跳过。
 *
 * 实测症状（重启后的服务）：`before=210` 返回 5 条 item，**id 全是 198**，
 * 而 `hasMore=false` —— 198 之前那些 item 再也取不到。
 *
 * ── 解法：`seq = entryId * ITEM_SEQ_STRIDE + 该 entry 内的产出序号` ──
 * 1. `buildItems` 是**确定顺序**的（按 entries 顺序、每条 entry 内按 content 数组顺序），
 *    所以「entry 内第几条」是稳定的；
 * 2. 乘一个足够大的 stride（{@link ITEM_SEQ_STRIDE}），保证同一 entry 内的多条 item
 *    的 seq 互不相同、且**严格递增**，而不同 entry 的 seq 段不会交叠；
 * 3. `seq` 单调 ⇒ 可以直接当分页游标，语义与原来的 `before`（严格早于）一致。
 *
 * 对外仍保留 `id`（= entry id）供前端展示/排查，但**分页用 `seq`**。
 */
export type ActivityItem = {
	/** entry id（保留给前端展示与排查；**不再用于分页**）。 */
	readonly id: number;
	/**
	 * 稳定分页游标：`entryId * ITEM_SEQ_STRIDE + 该 entry 内的产出序号`。
	 * 该 entry 内序号从 0 开始，严格递增。
	 */
	readonly seq: number;
} & (
	| {
			readonly kind: "thinking";
			/** 思考正文（可能被截断）。 */
			readonly text: string;
			readonly truncated: boolean;
			readonly fullLength: number;
			/** 毫秒时间戳。 */
			readonly at: number;
	  }
	| {
			readonly kind: "assistant";
			readonly text: string;
			readonly truncated: boolean;
			readonly fullLength: number;
			readonly at: number;
	  }
	| {
			readonly kind: "tool";
			/**
			 * 工具名。
			 *
			 * **同时给 `toolName` 与 `name`**：前者是负责人契约里的字段名，
			 * 后者是前端 `feed-render.js` 的 `renderTool(item)` / `argsSummary(item)`
			 * 实际读取的字段（实测 `ui/js/feed-render.js:48`：`toolMeta(item.name, item.args)`）。
			 * 两套都发，前端**零转换**即可渲染；任一侧以后统一字段名都不会破。
			 */
			readonly toolName: string;
			readonly name: string;
			/** 参数摘要（一行，≤160 字；来自 `feed` 的 `args`）。 */
			readonly argsSummary: string;
			/** 参数原文（前端 `prettyArgs(item.args)` 自己格式化，见 `feed-render.js:76`）。 */
			readonly args: string;
			/** 输出摘要（≤300 字）。 */
			readonly outputSummary: string;
			/** 输出摘要的别名：前端 `String(item.output ?? "")` 直接读它（`feed-render.js:78`）。 */
			readonly output: string;
			readonly truncated: boolean;
			/** 输出全文长度（未截断时等于 `outputSummary.length`）。 */
			readonly fullLength: number;
			readonly isError: boolean;
			/** 耗时（毫秒）；`feed` 不提供时为 `null`。 */
			readonly durationMs: number | null;
			/** `feed` 的执行态：`ok` / `error` / `running` / `interrupted`。 */
			readonly state: "running" | "ok" | "error" | "interrupted";
			readonly at: number;
	  }
);

/** 分页结果。 */
export type ActivityPage = {
	/** 时间正序（老的在前），与聊天软件一致：新消息追加在底部，往上翻加载更早的。 */
	readonly items: readonly ActivityItem[];
	/**
	 * 还有更早的、并且**确实还能继续取**（用 `items[0].id` 作为下一次的 `before`）。
	 *
	 * ⚠️ `hasMore: false` 只在两种情况下出现：真的到底了，或已触到翻页上限
	 * （后者会同时给 `truncated: true`）。**不允许出现「hasMore=true 但再翻也拿不到东西」**
	 * ——那会让前端无限滚动却永远加载不出来。
	 */
	readonly hasMore: boolean;
	/**
	 * 是否因触到翻页上限而提前停止（更早的记录**未被加载**）。
	 *
	 * 为 `true` 时前端应当显示「更早的记录未加载」，而不是继续触发加载更多。
	 * 触发条件：往前翻超过 {@link MAX_WINDOWS} 窗。真实最大会话约 830 条，
	 * 上限 3200 条有 4 倍余量，所以正常不会出现——但它必须是**显式**的，
	 * 不能像「静默到顶」那样让用户以为历史就这些。
	 */
	readonly truncated: boolean;
};

/** 截断一段文本。 */
function clip(text: string): { text: string; truncated: boolean; fullLength: number } {
	const full = text ?? "";
	const truncated = full.length > SUMMARY_LIMIT;
	return {
		text: truncated ? full.slice(0, SUMMARY_LIMIT) : full,
		truncated,
		fullLength: full.length,
	};
}

/**
 * 把 feed 条目转成工作记录项；不保留的返回 undefined。
 *
 * @param item          feed 条目
 * @param indexInEntry  这条 item 是**同一个 entry 内**的第几条（从 0 起）。
 *                      由调用方按 `feed.items` 的顺序累加，保证稳定。
 *                      例：一个 `pi.assistant` 产出 [assistant, tool, tool]
 *                      → indexInEntry 分别是 0 / 1 / 2。
 */
export function toActivityItem(item: FeedItem, indexInEntry = 0): ActivityItem | undefined {
	if (!KEEP_KINDS.has(item.kind)) return undefined;
	const seq = item.id * ITEM_SEQ_STRIDE + indexInEntry;
	switch (item.kind) {
		case "thinking": {
			const body = clip(item.text);
			return { id: item.id, seq, kind: "thinking", text: body.text, truncated: body.truncated, fullLength: body.fullLength, at: item.at };
		}
		case "assistant": {
			const body = clip(item.text);
			return { id: item.id, seq, kind: "assistant", text: body.text, truncated: body.truncated, fullLength: body.fullLength, at: item.at };
		}
		case "tool": {
			const body = clip(item.output ?? "");
			return {
				id: item.id,
				seq,
				kind: "tool",
				toolName: item.name,
				name: item.name,
				argsSummary: item.args ?? "",
				args: item.args ?? "",
				outputSummary: body.text,
				output: body.text,
				truncated: body.truncated,
				fullLength: body.fullLength,
				isError: item.state === "error",
				durationMs: null,
				state: item.state,
				at: item.at,
			};
		}
		default:
			return undefined;
	}
}

/**
 * 读某职工的工作记录（含思考 / 回复 / 工具调用），时间正序 + 向上翻页。
 *
 * ── 分页为什么不能只靠 `readFeed` 的默认窗口 ──
 *
 * `readFeed` 一次只取**最新 400 条 entries**。实测线上四个真实会话的 entries 数：
 * 1905=628、149=547、161=689、89=816 —— **全部超过 400**。
 * 如果只拿这一窗，`before` 翻到第 400 条之前就再也取不到东西，
 * 而 `hasMore` 会算成 `false`：**用户以为「历史就这些」，其实还有**。
 * 这正是老板第 3 条（「往上翻看历史逐步加载」）要防的静默失效。
 *
 * ⇒ 所以按游标**往前多取几窗**，直到攒够 limit 条或真的到头。
 *
 * @param options.limit  每页条数（默认 30，上限 200）。
 * @param options.before 游标：只返回 `id` **小于**它的条目（「往上翻更早的」）。
 */
export async function readStaffActivity(
	runtime: CompanyRuntime,
	conversationId: number,
	options: { readonly limit?: number; readonly before?: number } = {},
	context: Context = BACKGROUND_CONTEXT,
): Promise<ActivityPage | undefined> {
	const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);

	// 收集顺序：始终「从新往旧」。最后再翻转成正序返回。
	const desc: ActivityItem[] = [];
	let cursor = options.before;
	let reachedEnd = false;
	let hitWindowLimit = false;

	const before = options.before;
	// `before` 是 **item seq**（不是 entry id）。要把它换算成「底层应从哪个 entry 开始往前取」：
	// seq = entryId * STRIDE + index，所以 entryId = floor(seq / STRIDE)。
	// 取 `entryId + 1` 作为底层上界，是为了**不丢掉同一 entry 里 seq 更小的那些 item**
	// （例如 before 指向某个 entry 的第 3 条，该 entry 的第 0~2 条仍应被返回）。
	let entryCeiling: number | undefined =
		before === undefined ? undefined : Math.floor(before / ITEM_SEQ_STRIDE) + 1;

	for (let round = 0; round < MAX_WINDOWS; round += 1) {
		const feed = await readFeed(
			runtime,
			conversationId,
			{ limit: FEED_WINDOW, ...(entryCeiling === undefined ? {} : { before: entryCeiling }) },
			context,
		);
		if (feed === undefined) {
			if (round === 0) return undefined;
			break;
		}

		// ⚠️ 关键：同一条 entry 会产出多条 item，`indexInEntry` 必须按 feed.items 的顺序
		// **按 entry 累加**，才能得到稳定的 seq。
		const windowItems: ActivityItem[] = [];
		let previousId: number | undefined;
		let indexInEntry = 0;
		for (const item of feed.items) {
			if (item.id !== previousId) {
				previousId = item.id;
				indexInEntry = 0;
			}
			const mapped = toActivityItem(item, indexInEntry);
			// 只有真正被保留的 item 才占一个序号？——不：序号必须只由「在 entry 内的位置」决定，
			// 与被保留与否无关，否则过滤规则一变（比如以后不再丢弃某类）就会让历史游标错位。
			indexInEntry += 1;
			if (mapped === undefined) continue;
			windowItems.push(mapped);
		}

		if (windowItems.length === 0) {
			reachedEnd = true;
			break;
		}

		let addedInWindow = 0;
		for (let index = windowItems.length - 1; index >= 0; index -= 1) {
			const item = windowItems[index];
			if (item === undefined) continue;
			// 用 **seq** 过滤（严格早于）。同一个 entry 内 seq 较小的那些不会被误跳。
			if (cursor !== undefined && item.seq >= cursor) continue;
			desc.push(item);
			addedInWindow += 1;
			if (desc.length > limit) break;
		}

		// 游标取「本页实际返回的最旧一条」的 seq。
		const oldestPushed = desc[desc.length - 1]?.seq;
		if (addedInWindow === 0 || oldestPushed === undefined) {
			reachedEnd = true;
			break;
		}
		// 到头判据：这一窗要了 `FEED_WINDOW` 条却只回来更少 ⇒ 底层没有再早的了。
		if (feed.items.length < FEED_WINDOW) {
			reachedEnd = true;
			break;
		}
		if (desc.length > limit) break;

		cursor = oldestPushed;
		// 下一窗的 entry 上界：从当前最旧 item 所属 entry 再往前一点。
		entryCeiling = Math.floor(oldestPushed / ITEM_SEQ_STRIDE) + 1;
	}

	// 攒够了就返回（正常路径）。
	if (desc.length > limit) {
		return { items: [...desc.slice(0, limit)].reverse(), hasMore: true, truncated: false };
	}
	// 没攒够但也没走到头 ⇒ 是撞上了 MAX_WINDOWS 这个上限。
	// 这里**不能**报 hasMore=true ——那会让前端无限滚动却永远加载不出来（「假 hasMore」）。
	hitWindowLimit = !reachedEnd;
	return { items: [...desc].reverse(), hasMore: false, truncated: hitWindowLimit };
}
