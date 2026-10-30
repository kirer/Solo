/**
 * 把一段可能带换行的正文压成一行，给列表预览、频道留痕、投递摘要用。
 *
 * 只有这一份实现：以前散在 `channel/tools.ts`、`channel/deliver.ts`、
 * `team/settle.ts`、`view/index.ts` 五处，规则还各不相同（有的截 `max` 再加省略号，
 * 出来的长度是 `max + 1`）。统一取**最严格**的那条：折叠空白 → 去首尾空格 →
 * 超长则 `slice(0, max - 1) + "…"`，**结果长度永不超过 `max`**。
 *
 * 放 `src/core/` 根、不放任何一层：`view/` 零依赖（不许 import 领域），
 * 领域又不许反向 import `view/`。它是纯字符串函数，没有 IO、没有业务概念。
 */

/** 折叠空白成单个空格、去首尾空格，超长则截断并以 `…` 结尾（总长 ≤ `max`）。 */
export function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
