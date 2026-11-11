/**
 * 行高的纯函数模型 —— 虚拟滚动的地基（2026-11-11 重做）。
 *
 * 为什么要有这个文件：滚动位置不能在「看一眼 DOM」和「算一个数」之间来回借。
 * 前三轮返工都死在「补完把用户放哪儿」和「补进来多少」混在一处改。这里把
 * **「某一行离内容顶多远」**变成一个可以离线单测的数：输入是行数组与已知行高，
 * 输出是每个 key 的偏移。DOM 只在事后**校正**（`measure()` 吸收真值），不参与判定。
 *
 * 三条来自设计的硬要求：
 * 1. **占位行也是行**（`placeholder`），它必须占位移名额、必须有高度 ——
 *    否则补页时锚点算不准，屏上的字会跳。
 * 2. **`offsetOf(key)` 查模型不查 DOM**：锚点行被回收了也照样算得出 `ΔH`。
 * 3. **误差自愈**：每一行的高度可以是「估的」，量到真值后用 `measure()` 覆盖，
 *    下一次 `offsetOf` 就自动带上真值。误差量级是「每行几像素 × 行数」，远小于一屏。
 */

/** 一屏至少补多少条、至多补多少条（设计 §2.1：一页 = 一屏）。 */
export const PAGE_MIN = 8;
export const PAGE_MAX = 40;

/**
 * 没量过的行按多高估。
 *
 * 一条两行文字的气泡（含头像行与间距）大约这么高；真正的高度由 `measure()` 吸进来。
 * 取值偏大一点比偏小安全：偏小会让内容总高估少，滚到底时差一截（验收第 12 条）。
 */
export const DEFAULT_ROW_HEIGHT = 76;

/** 占位行的高度：与「真行的估算高」同源，页回来换真行时才不会跳（设计 §3.4）。 */
export const PLACEHOLDER_HEIGHT = DEFAULT_ROW_HEIGHT;

/** 一页补多少条：按屏算，夹在 8..40（Solo 已拍：一页按屏）。 */
export function pageSizeFor(viewportHeight: number, averageRowHeight = DEFAULT_ROW_HEIGHT): number {
	const safeViewport = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : DEFAULT_ROW_HEIGHT * PAGE_MIN;
	const safeRow = Number.isFinite(averageRowHeight) && averageRowHeight > 1 ? averageRowHeight : DEFAULT_ROW_HEIGHT;
	const raw = Math.ceil(safeViewport / safeRow);
	return Math.min(PAGE_MAX, Math.max(PAGE_MIN, raw));
}

/** 一行在模型里的身份：真行靠 `seq`（也有 `key`），占位行只有 `key`。 */
export type ModelRow = { readonly key: string; readonly height: number };

export type Heights = {
	/** 全部行（真行 + 占位行），从上到下。 */
	readonly rows: readonly ModelRow[];
	/** 每行高度之和。 */
	readonly total: number;
};

/** 从一串行建模型。高度缺省用 `DEFAULT_ROW_HEIGHT`。 */
export function buildHeights(rows: readonly { key: string; height?: number }[]): Heights {
	const out: ModelRow[] = [];
	let total = 0;
	for (const row of rows) {
		const height = Number.isFinite(row.height) && (row.height as number) > 0 ? (row.height as number) : DEFAULT_ROW_HEIGHT;
		out.push({ key: row.key, height });
		total += height;
	}
	return { rows: out, total };
}

/** 某一行距内容顶多少像素；找不到就是 `undefined`（模型里没有它）。 */
export function offsetOf(model: Heights, key: string): number | undefined {
	let top = 0;
	for (const row of model.rows) {
		if (row.key === key) return top;
		top += row.height;
	}
	return undefined;
}

/** 反过来：某个下沉像素落在哪一行（渲染窗口用）。返回下标；超过总高就是 `rows.length`。 */
export function indexAt(model: Heights, scrollTop: number): number {
	if (scrollTop <= 0) return 0;
	let top = 0;
	for (let index = 0; index < model.rows.length; index += 1) {
		top += model.rows[index]!.height;
		if (top > scrollTop) return index;
	}
	return model.rows.length;
}

/**
 * 量到真值 —— **只覆盖高度，不移动任何行的位置**。
 *
 * 调用方是「渲染出来之后读一次 `getBoundingClientRect().height`」，把结果交给这里。
 * 没量到的行保持原估值，所以模型永远可用；量到了就越用越准。
 */
export function measure(model: Heights, updates: readonly { key: string; height: number }[]): Heights {
	if (updates.length === 0) return model;
	const byKey = new Map<string, number>();
	for (const item of updates) {
		if (Number.isFinite(item.height) && item.height > 0) byKey.set(item.key, item.height);
	}
	if (byKey.size === 0) return model;
	let changed = false;
	let total = 0;
	const rows = model.rows.map((row) => {
		const next = byKey.get(row.key);
		if (next === undefined || next === row.height) {
			total += row.height;
			return row;
		}
		changed = true;
		total += next;
		return { key: row.key, height: next };
	});
	return changed ? { rows, total } : model;
}

/**
 * 锚点补偿的差值：同一个 key 在补页前后「距内容顶」差了多少。
 *
 * 这就是设计 §3.1 / §3.3 的 `ΔH`。**找不到就是 `undefined`** —— 调用方据此走兜底
 * （换一个屏上有的 key 重算），绝不会拿一个猜出来的数去写 `scrollTop`。
 */
export function anchorDelta(model: Heights, key: string, beforeTop: number): number | undefined {
	const now = offsetOf(model, key);
	if (now === undefined) return undefined;
	return now - beforeTop;
}

/** 平均行高：给 `pageSizeFor()` 用，也用来判断「一屏算几条」。 */
export function averageHeight(model: Heights): number {
	if (model.rows.length === 0) return DEFAULT_ROW_HEIGHT;
	return model.total / model.rows.length;
}
