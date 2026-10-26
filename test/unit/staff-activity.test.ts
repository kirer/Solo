/**
 * 职工「工作记录」流水的用例（UX-7 数据源）。
 *
 * 守四件事：
 * 1. **思考过程要保留**：老板口径「不是只是工具调用，还是他思考过程啊」——
 *    `thinking` 与 `assistant` 都必须在，只有 `tool` 是不合格的。
 * 2. **系统留痕与老板自己的话不进**：`user` / `note` / `alert` 排除。
 * 3. **tool 条目要两个摘要**：`argsSummary` + `outputSummary`——
 *    因为前端 `renderTool` 是「参数 pane + 输出 pane」两块分开渲染的。
 * 4. **摘要截断**：实测工具输出平均 870 字、最长 23912 字，全量返回会冲垮一次响应。
 *
 * ⚠️ 用例**直接 import 真实实现**。第一版本在测试里手抄了一份同构 `toItem`，
 * 结果把源码故意改坏时用例照样绿——测的是副本不是源码（本项目的第 24 条）。
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toActivityItem } from "../../src/server/activity.ts";
import type { FeedItem } from "../../src/server/feed.ts";

const ROOT = join(import.meta.dirname, "../..");

/** 造一条 feed 条目（只为测试用；真实形态见 `src/server/feed.ts` 的 `FeedItem`）。 */
const feed = (item: Record<string, unknown>): FeedItem => item as unknown as FeedItem;

describe("工作记录：思考过程必须保留（老板口径「还是他思考过程」）", () => {
	test("thinking 条目保留", () => {
		const item = toActivityItem(feed({ id: 1, kind: "thinking", text: "我需要先读一下源码", at: 1000 }));
		expect(item?.kind).toBe("thinking");
		expect(item).toMatchObject({ id: 1, kind: "thinking", text: "我需要先读一下源码", at: 1000 });
	});

	test("assistant 条目保留", () => {
		const item = toActivityItem(feed({ id: 2, kind: "assistant", text: "我先核对一下现状。", at: 1001 }));
		expect(item).toMatchObject({ id: 2, kind: "assistant", text: "我先核对一下现状。" });
	});

	test("只有 tool 而没有 thinking/assistant 是**不合格**的（旧契约的错误形态）", () => {
		const kept = [
			{ id: 1, kind: "tool", name: "bash", args: "", output: "", state: "ok", collapsible: false, at: 0 },
		].map((x) => toActivityItem(feed(x)));
		expect(kept.filter((x) => x?.kind === "thinking" || x?.kind === "assistant")).toHaveLength(0);
		// 这条用例记录的正是被老板否掉的第一版契约：只返回工具调用。
		expect(kept).toHaveLength(1);
	});
});

describe("工作记录：排除系统留痕与老板自己的话", () => {
	test("user 条目不收（老板的话已在私聊里，重复展示等于同一条出现两遍）", () => {
		expect(toActivityItem(feed({ id: 3, kind: "user", text: "先别动", at: 1 }))).toBeUndefined();
	});

	test("note 条目不收（派活/回报等系统留痕，不是「他的输出」）", () => {
		expect(toActivityItem(feed({ id: 4, kind: "note", text: "【T-1 开始】…", at: 1 }))).toBeUndefined();
	});

	test("alert 条目不收", () => {
		expect(toActivityItem(feed({ id: 5, kind: "alert", text: "模型调用出错", at: 1 }))).toBeUndefined();
	});
});

describe("工作记录：tool 条目要两个摘要（前端两个 pane）", () => {
	test("同时给 toolName/name、argsSummary/args、outputSummary/output（前端零转换即可渲染）", () => {
		const item = toActivityItem(
			feed({ id: 6, kind: "tool", name: "bash", args: "grep -n foo src/a.ts", output: "找到 3 处", state: "ok", collapsible: false, at: 2 }),
		);
		expect(item).toMatchObject({
			kind: "tool",
			// 负责人契约的字段名
			toolName: "bash",
			argsSummary: "grep -n foo src/a.ts",
			outputSummary: "找到 3 处",
			// 前端 renderTool 实际读的字段名（feed-render.js:48/76/78）
			name: "bash",
			args: "grep -n foo src/a.ts",
			output: "找到 3 处",
			isError: false,
			state: "ok",
		});
	});

	test("前端 renderTool 需要的四个字段一个都不缺", () => {
		const item = toActivityItem(
			feed({ id: 60, kind: "tool", name: "bash", args: "ls", output: "a b c", state: "ok", collapsible: false, at: 2 }),
		);
		if (item?.kind !== "tool") throw new Error("unreachable");
		// 这四项任一缺失，feed-render.js 的 renderTool 就会渲染成空白/（无参数）
		for (const key of ["name", "args", "output", "state"] as const) {
			expect(item[key], `缺 ${key} 会让 renderTool 渲染不出来`).toBeDefined();
		}
		// renderThinking 需要 text
		const think = toActivityItem(feed({ id: 61, kind: "thinking", text: "想", at: 3 }));
		expect(think).toMatchObject({ kind: "thinking", text: "想" });
	});

	test("state=error ⇒ isError=true", () => {
		const item = toActivityItem(
			feed({ id: 7, kind: "tool", name: "bash", args: "exit 1", output: "boom", state: "error", collapsible: false, at: 3 }),
		);
		expect(item).toMatchObject({ isError: true, state: "error" });
	});

	test("state=running 不被当成错误（工具还没跑完）", () => {
		const item = toActivityItem(
			feed({ id: 8, kind: "tool", name: "bash", args: "", output: "", state: "running", collapsible: false, at: 4 }),
		);
		expect(item).toMatchObject({ isError: false, state: "running" });
	});

	test("args 为空时不崩（feed 里 toolResult 单独成条目时 args 就是空串）", () => {
		const item = toActivityItem(
			feed({ id: 9, kind: "tool", name: "bash", args: "", output: "输出", state: "ok", collapsible: false, at: 5 }),
		);
		expect(item).toMatchObject({ argsSummary: "", outputSummary: "输出" });
	});
});

describe("工作记录：摘要截断", () => {
	test("工具输出超 300 字截断，fullLength 保留真实长度", () => {
		const long = "字".repeat(1008);
		const item = toActivityItem(
			feed({ id: 10, kind: "tool", name: "bash", args: "x", output: long, state: "ok", collapsible: true, at: 6 }),
		);
		expect(item?.kind).toBe("tool");
		if (item?.kind !== "tool") throw new Error("unreachable");
		expect(item.truncated).toBe(true);
		expect(item.outputSummary.length).toBe(300);
		expect(item.fullLength).toBe(1008);
	});

	test("短输出不截断", () => {
		const item = toActivityItem(
			feed({ id: 11, kind: "tool", name: "say", args: "", output: "已发到「系统」", state: "ok", collapsible: false, at: 7 }),
		);
		if (item?.kind !== "tool") throw new Error("unreachable");
		expect(item.truncated).toBe(false);
		expect(item.fullLength).toBe("已发到「系统」".length);
	});

	test("思考/回复正文也截断（长 reasoning 一样能撑爆响应）", () => {
		const long = "想".repeat(540);
		const item = toActivityItem(feed({ id: 12, kind: "thinking", text: long, at: 8 }));
		if (item?.kind !== "thinking") throw new Error("unreachable");
		expect(item.truncated).toBe(true);
		expect(item.text.length).toBe(300);
		expect(item.fullLength).toBe(540);
	});

	test("正好 300 字不截断（边界）", () => {
		const exact = "字".repeat(300);
		const item = toActivityItem(feed({ id: 13, kind: "assistant", text: exact, at: 9 }));
		if (item?.kind !== "assistant") throw new Error("unreachable");
		expect(item.truncated).toBe(false);
	});
});

describe("工作记录：翻页不能静默「到顶」（读的窗口只有 400 条）", () => {
	/**
	 * 这一组守的是一个**只靠离线逻辑推不出来的**缺陷：
	 * `readFeed` 一次只取最新 400 条 entries，而实测线上四个真实会话的 entries 数是
	 * 1905=628 / 149=547 / 161=689 / 89=816 —— **全部超过 400**。
	 * 如果分页只在那一窗里做，`before` 翻到第 400 条之前就取不到东西，`hasMore` 会算成 false，
	 * 用户会以为「历史就这些」。这正是老板「往上翻看历史逐步加载」要防的静默失效。
	 *
	 * 这里用**窗口语义的桩**复刻 `readFeed(limit, before)`：始终返回 `id < before` 的最新 limit 条。
	 */
	const FEED_WINDOW = 400;
	const MAX_WINDOWS = 8;

	function fakeFeed(total: number, limit: number, before?: number): { id: number }[] {
		const upper = before === undefined ? total : Math.min(total, before - 1);
		const start = Math.max(1, upper - limit + 1);
		const items: { id: number }[] = [];
		for (let id = start; id <= upper; id += 1) items.push({ id });
		return items;
	}

	/** 复刻 `readStaffActivity` 的分页核心（与源码同构；源码里还套了 readFeed/toActivityItem）。 */
	/**
	 * 旧实现：**每次只读最新 400 条**（readFeed 的默认窗口），在窗内筛完就返回。
	 * 关键差异：它的窗口下界固定是 `total - 399`，不会因为 `before` 而往前移。
	 */
	function pageOld(total: number, limit: number, before?: number): { items: number[]; hasMore: boolean } {
		const windowStart = Math.max(1, total - FEED_WINDOW + 1); // 只有最近 400 条可见
		const all: { id: number }[] = [];
		for (let id = windowStart; id <= total; id += 1) {
			if (before !== undefined && id >= before) continue;
			all.push({ id });
		}
		const start = Math.max(0, all.length - limit);
		// 旧实现用「窗口内还有更早的」判断 hasMore —— 窗口到底就说 false
		return { items: all.slice(start).map((item) => item.id), hasMore: start > 0 };
	}

	function page(total: number, limit: number, before?: number): { items: number[]; hasMore: boolean } {
		const desc: { id: number }[] = [];
		let cursor = before;
		let reachedEnd = false;
		for (let round = 0; round < MAX_WINDOWS; round += 1) {
			const windowItems = fakeFeed(total, FEED_WINDOW, cursor);
			if (windowItems.length === 0) {
				reachedEnd = true;
				break;
			}
			let added = 0;
			for (let index = windowItems.length - 1; index >= 0; index -= 1) {
				const item = windowItems[index];
				if (item === undefined) continue;
				if (cursor !== undefined && item.id >= cursor) continue;
				desc.push(item);
				added += 1;
				if (desc.length > limit) break;
			}
			const oldestId = windowItems[0]?.id;
			if (added === 0 || windowItems.length < FEED_WINDOW || oldestId === undefined) {
				reachedEnd = true;
				break;
			}
			cursor = oldestId;
			if (desc.length > limit) break;
		}
		return { items: desc.slice(0, limit).reverse().map((item) => item.id), hasMore: desc.length > limit || !reachedEnd };
	}

	test("628 条历史（实测 1905 的真实规模）能完整翻到底，且不重不漏", () => {
		const TOTAL = 628;
		const seen: number[] = [];
		let cursor: number | undefined;
		for (let guard = 0; guard < 50; guard += 1) {
			const result = page(TOTAL, 30, cursor);
			if (result.items.length === 0) break;
			seen.push(...result.items);
			if (!result.hasMore) break;
			cursor = result.items[0];
		}
		expect(seen).toHaveLength(TOTAL);
		expect(new Set(seen).size).toBe(TOTAL);
		// 翻到底必须能拿到最老的那条（id=1）；否则就是「静默到顶」
		expect(seen).toContain(1);
		// 不缺任何一条
		const missing = Array.from({ length: TOTAL }, (_, index) => index + 1).filter((id) => !seen.includes(id));
		expect(missing).toEqual([]);
	});

	test("对拍：旧实现（只读一窗 400）翻到第 400 条就静默到顶，新实现不会", () => {
		// 这条用例的意义：证明「多翻几窗」不是多余优化，而是修一个真缺陷。
		const TOTAL = 628;
		const oldSeen: number[] = [];
		let oldCursor: number | undefined;
		for (let guard = 0; guard < 50; guard += 1) {
			const result = pageOld(TOTAL, 30, oldCursor);
			if (result.items.length === 0) break;
			oldSeen.push(...result.items);
			if (!result.hasMore) break;
			oldCursor = result.items[0];
		}
		// 旧实现：只拿得到最近 400 条，1..228 全部丢失，且 hasMore 已经说 false
		expect(oldSeen.length).toBeLessThan(TOTAL);
		expect(oldSeen).not.toContain(1);

		const newSeen: number[] = [];
		let newCursor: number | undefined;
		for (let guard = 0; guard < 50; guard += 1) {
			const result = page(TOTAL, 30, newCursor);
			if (result.items.length === 0) break;
			newSeen.push(...result.items);
			if (!result.hasMore) break;
			newCursor = result.items[0];
		}
		expect(newSeen.length).toBe(TOTAL);
		expect(newSeen).toContain(1);
	});

	test("第一页 hasMore=true（历史有 628 条，不该声称到顶）", () => {
		expect(page(628, 30).hasMore).toBe(true);
	});

	test("数据量小于窗口时，一次性 hasMore=false", () => {
		const result = page(20, 30);
		expect(result.items).toHaveLength(20);
		expect(result.hasMore).toBe(false);
	});

	test("恰好等于窗口大小时也能翻完（边界 400）", () => {
		const result = page(400, 30);
		expect(result.items).toHaveLength(30);
		// 400 条 > 一页，所以还有更多
		expect(result.hasMore).toBe(true);
	});
});

describe("feed.ts 的 before 语义：必须下推给底层（不能在内存里过滤）", () => {
	/**
	 * 这一组来自两次真实审查：
	 *
	 * **第一次（负责人 #240）**：注释说要「把窗口扩到略大于 limit」，代码却没扩。
	 * 我当时改成真扩窗（`limit * 2`）——**但那仍然不够**。
	 *
	 * **第二次（T-24 用真实库验证时我自己发现）**：
	 * 扩窗后依然是「先取最新 N 条，再在内存里按 `id < before` 过滤」。
	 * 翻到后段时 `before` 很小，而「最新 N 条」里 `id < before` 的所剩无几
	 * ——实测会话 89（1036 条）在 cursor=3000 时，800 条里只有 221 条命中，
	 * 调用方据此判「返回不足一窗 ⇒ 到头」，**静默丢掉 236 条历史**。
	 *
	 * **正解**：`EntryQuery` 支持 `maxEntryId`
	 * （`@earendil-works/pi-durable` 的 `types.d.ts:708`：「Newest entry ID that may be returned」），
	 * 把 `before` 下推给底层，让它直接扫那一段。
	 */
	const FEED_SOURCE = readFileSync(join(ROOT, "src/server/feed.ts"), "utf8");

	test("before 必须下推为 maxEntryId（不能在内存里过滤）", () => {
		expect(FEED_SOURCE).toContain("maxEntryId: before - 1");
	});

	test("maxEntryId 是闭区间，所以传 before - 1 才等于「严格早于」", () => {
		const block = FEED_SOURCE.slice(FEED_SOURCE.indexOf("const query ="), FEED_SOURCE.indexOf("const page = await conversation.entries"));
		expect(block).toContain("maxEntryId: before - 1");
	});

	test("内存里仍要再挡一次 id >= before（防后端边界解释不一致）", () => {
		expect(FEED_SOURCE).toContain("page.items.filter((entry) => entry.id < before)");
	});

	test("不传 before 时查询不带 maxEntryId（行为与改前一致）", () => {
		const block = FEED_SOURCE.slice(FEED_SOURCE.indexOf("const query ="), FEED_SOURCE.indexOf("const page = await conversation.entries"));
		expect(block).toContain('{ order: "descending" as const }');
	});
});

describe("工作记录分页：游标取「本页最旧」（防御性写法，但**不是**丢数据的根因）", () => {
	const SOURCE = readFileSync(join(ROOT, "src/server/activity.ts"), "utf8");

	/**
	 * ⚠️ 这组用例守的是**写法正确性**，不是「修掉了丢数据」。
	 *
	 * 实测对拍（真实库 5 个会话、每页 30 条）：
	 *   · 不下推 maxEntryId + 整窗游标 → 总缺失 2107
	 *   · 不下推 maxEntryId + 本页游标 → 总缺失 2107   ← 改游标**没用**
	 *   · 下推           + 整窗游标 → 总缺失 0
	 *   · 下推           + 本页游标 → 总缺失 0        ← 改游标**也没用**
	 *
	 * ⇒ **丢数据的唯一根因是 `before` 没下推**（见上一组用例）。
	 * 游标取本页最旧仍然是对写法：它避免每次查询白扫一大段，
	 * 也避免「将来有人改了下推逻辑」时立刻变成丢数据。
	 * **但不能把它写成"根因"**，否则下一个人会在下推被改动时失去警觉。
	 */
	test("cursor 取自 desc 末位（本页最旧），不是 windowItems[0]", () => {
		// T-26 之后游标是 item seq（不是 entry id），但「取本页最旧」这条不变
		expect(SOURCE).toContain("const oldestPushed = desc[desc.length - 1]?.seq;");
		expect(SOURCE).toContain("cursor = oldestPushed;");
		expect(SOURCE).not.toContain("cursor = oldestId;");
	});

	test("（已撤销）原断言「游标不是丢数据的根因」——T-26 证明它在 item 粒度下**是**根因", () => {
		// 这条断言的历史：
		// - T-25：四组合对照证明「整窗游标 vs 本页游标」在 **entry 粒度**下都不丢，
		//   于是我在源码里写了「它不是丢数据的根因」，并加断言锁住这句话。
		// - T-26：重启后用 **item 粒度**发现真缺陷——一个 entry 产出多条 item 且共用 entry id，
		//   游标按 entry id 切分 ⇒ 同一 entry 内未返回的 item 被整批跳过（会话 89 缺 532 条）。
		//
		// **所以「游标不是根因」这个结论只在 entry 粒度成立，在 item 粒度是错的。**
		// 保留这条注释作为记录：当时的对照实验**度量单位选错了**，所以对照实验本身是对的、
		// 结论却错了 —— 这是「度量单位」比「实验方法」更隐蔽的一个例子。
		expect(true).toBe(true);
	});

	test("到头判据是「这一窗返回不足 FEED_WINDOW」，而不是拿 windowItems 比", () => {
		expect(SOURCE).toContain("if (feed.items.length < FEED_WINDOW)");
	});
});

describe("分页：id 稀疏（有空洞）时仍必须正确", () => {
	const FEED_SRC = readFileSync(join(ROOT, "src/server/feed.ts"), "utf8");

	/**
	 * 真实数据里 entry id **严重不连续**（实测最新快照）：
	 *   会话 89: 1090 条，id 跨度 8945 → 稀疏率 87.8%
	 *   会话 149: 618 条，id 跨度 8420 → 稀疏率 92.7%
	 *   会话 161: 771 条，id 跨度 8460 → 稀疏率 90.9%
	 *   会话 1897: 808 条，id 跨度 6761 → 稀疏率 88.0%
	 *   会话 1905: 1074 条，id 跨度 7156 → 稀疏率 85.0%
	 *
	 * ⇒ 「假数据 id 连续（1..N）」永远测不出这里的边界。
	 *
	 * 关键风险：我们传 `maxEntryId: before - 1`，而 `before - 1` **很可能是个不存在的 id**。
	 * 底层语义必须是「不超过它的最新一条」，而不是「等于它」。实测（真实库）确认成立：
	 *   id<=3420（空洞）→ [3419, 3408, 3407]
	 *   id<=3419（真实）→ [3419, 3408, 3407]   ← 一致
	 */

	test("源码用 maxEntryId（闭区间上界），不是精确匹配", () => {
		// 若有人改成「找 id 恰好等于 before-1 的条目」，稀疏 id 下会立刻返回空
		expect(FEED_SRC).toContain("maxEntryId: before - 1");
		expect(FEED_SRC).not.toContain("maxEntryId: entryIdOf(before)");
	});

	test("内存里仍按 id < before 过滤（对空洞 id 也不例外）", () => {
		expect(FEED_SRC).toContain("entry.id < before");
	});

	test("模拟稀疏 id：跨 8945 个 id 只有 1090 条，逐页仍不重不漏", () => {
		// 造一个稀疏 id 集合：在 1..8945 里均匀取 1090 个
		const TOTAL_SPAN = 8945;
		const COUNT = 1090;
		const all: number[] = [];
		for (let i = 0; i < COUNT; i += 1) all.push(Math.round((i * (TOTAL_SPAN - 1)) / (COUNT - 1)) + 1);
		const uniqueAll = [...new Set(all)].sort((a, b) => a - b);

		/** 复刻 readFeed：`maxEntryId` 是闭区间上界（不要求命中）。 */
		const readFeedLike = (limit: number, before?: number): number[] => {
			const pool = before === undefined ? uniqueAll : uniqueAll.filter((id) => id <= before - 1);
			return pool.slice(-limit); // 取最新 limit 条（升序）
		};

		const LIMIT = 30;
		const FEED_WINDOW = 400;
		const page = (before?: number): { items: number[]; hasMore: boolean } => {
			const desc: number[] = [];
			let cursor = before;
			let reachedEnd = false;
			for (let round = 0; round < 8; round += 1) {
				const items = readFeedLike(FEED_WINDOW, cursor);
				if (items.length === 0) {
					reachedEnd = true;
					break;
				}
				let added = 0;
				for (let i = items.length - 1; i >= 0; i -= 1) {
					const id = items[i];
					if (id === undefined) continue;
					if (cursor !== undefined && id >= cursor) continue;
					desc.push(id);
					added += 1;
					if (desc.length > LIMIT) break;
				}
				const oldest = desc[desc.length - 1];
				if (added === 0 || oldest === undefined) {
					reachedEnd = true;
					break;
				}
				if (items.length < FEED_WINDOW) {
					reachedEnd = true;
					break;
				}
				if (desc.length > LIMIT) break;
				cursor = oldest;
			}
			return desc.length > LIMIT
				? { items: desc.slice(0, LIMIT).reverse(), hasMore: true }
				: { items: desc.slice().reverse(), hasMore: !reachedEnd };
		};

		const seen: number[] = [];
		let cursor: number | undefined;
		for (let guard = 0; guard < 200; guard += 1) {
			const result = page(cursor);
			if (result.items.length === 0) break;
			seen.push(...result.items);
			if (!result.hasMore) break;
			cursor = result.items[0];
		}

		expect(new Set(seen).size).toBe(uniqueAll.length);
		expect(seen).toHaveLength(uniqueAll.length);
		const missing = uniqueAll.filter((id) => !seen.includes(id));
		expect(missing).toEqual([]);
	});

	test("before 落在空洞 id 上时，等价于「上界」而不是「精确命中」", () => {
		// 一个稀疏集合：1, 5, 9, 13...（每 4 个一个空洞）
		const sparse = Array.from({ length: 10 }, (_, index) => index * 4 + 1); // 1,5,9,...,37
		// before=6（6 不存在，是空洞）→ 应返回 <=5 的那些（即 1,5）
		const upperInclusive = 6 - 1;
		const got = sparse.filter((id) => id <= upperInclusive);
		expect(got).toEqual([1, 5]);
		// 若实现成「精确命中 before-1=5」也恰好命中；但 before=7（空洞 6）时：
		const got7 = sparse.filter((id) => id <= 7 - 1);
		expect(got7).toEqual([1, 5]); // 仍是 [1,5]，证明是「上界」语义
	});
});

describe("T-26 分页游标：一个 entry 产出多条 item 时，逐条都要能取到", () => {
	/**
	 * 真缺陷（重启后实测）：`before=210` 返回 5 条 item，**id 全是 198**，且 `hasMore=false`。
	 * 根因：游标用 entry id，而一个 `pi.assistant` 最多产出 5 条 item（1 条 assistant + 4 条 toolCall），
	 * 它们**共用同一个 entry id** ⇒ 跨页时同一 entry 内还没返回的那几条被整批跳过。
	 *
	 * 度量单位错误：上一版我用「entry 数对得上」证明不丢 —— 但用户看到的每条工具调用都是独立 item。
	 */
	const SOURCE = readFileSync(join(ROOT, "src/server/activity.ts"), "utf8");

	test("ActivityItem 暴露独立的分页游标 seq（不再只用 entry id）", () => {
		expect(SOURCE).toContain("readonly seq: number;");
		expect(SOURCE).toContain("ITEM_SEQ_STRIDE");
	});

	test("seq = entryId * STRIDE + entry 内序号", () => {
		expect(SOURCE).toContain("const seq = item.id * ITEM_SEQ_STRIDE + indexInEntry;");
	});

	test("按 entry 累加 indexInEntry（同一 entry 的多条 item 序号递增）", () => {
		expect(SOURCE).toContain("if (item.id !== previousId) {");
		expect(SOURCE).toContain("indexInEntry += 1;");
	});

	test("分页过滤与游标都用 seq，不用 id", () => {
		expect(SOURCE).toContain("if (cursor !== undefined && item.seq >= cursor) continue;");
		expect(SOURCE).toContain("const oldestPushed = desc[desc.length - 1]?.seq;");
	});

	test("（源码契约）游标必须用 seq —— 若有人改回 id，上面两条会红；这条守「逐条取到」不靠模拟", () => {
		// 前面那条「模拟」用例测的是我手写的分页逻辑，**不是源码**。
		// 变异验证暴露了这一点：把源码改回 entry 级游标时，模拟用例照样绿（它测的是副本）。
		// 所以我需要一条**直接对源码**的断言：
		const block = SOURCE.slice(SOURCE.indexOf("for (let index = windowItems.length - 1"), SOURCE.indexOf("hitWindowLimit = !reachedEnd;"));
		expect(block).toContain("item.seq >= cursor");
		expect(block).toContain("desc[desc.length - 1]?.seq");
		// 同一条 entry 的多条 item：seq 必须能区分，靠 indexInEntry 累加
		expect(SOURCE).toContain("toActivityItem(item, indexInEntry)");
	});

	test("模拟：一个 entry 产 5 条 item，逐页翻应全部取到（旧实现会丢 4 条）", () => {
		// 造 3 个 entry：entry 10 产出 5 条 item，entry 11 产出 1 条，entry 12 产出 2 条
		const STRIDE = 1000;
		const all: { id: number; seq: number }[] = [];
		const plan: [number, number][] = [[10, 5], [11, 1], [12, 2]];
		for (const [entryId, count] of plan) {
			for (let index = 0; index < count; index += 1) all.push({ id: entryId, seq: entryId * STRIDE + index });
		}
		const LIMIT = 3;
		const page = (before?: number) => {
			const pool = before === undefined ? all : all.filter((x) => x.seq < before);
			const window = pool.slice(-LIMIT);
			return { items: window, hasMore: pool.length > LIMIT };
		};

		const seen: number[] = [];
		let cursor: number | undefined;
		for (let guard = 0; guard < 20; guard += 1) {
			const result = page(cursor);
			if (result.items.length === 0) break;
			seen.push(...result.items.map((x) => x.seq));
			if (!result.hasMore) break;
			cursor = result.items[0]?.seq;
		}
		expect(new Set(seen).size).toBe(all.length);
		expect(seen).toHaveLength(all.length);

		// 对照：旧实现（按 entry id 切游标）会丢 —— 用 min(id) 当游标
		const seenById: number[] = [];
		let cursorId: number | undefined;
		for (let guard = 0; guard < 20; guard += 1) {
			const pool = cursorId === undefined ? all : all.filter((x) => x.id < cursorId);
			const window = pool.slice(-LIMIT);
			if (window.length === 0) break;
			seenById.push(...window.map((x) => x.seq));
			if (pool.length <= LIMIT) break;
			cursorId = window[0]?.id;
		}
		// 旧实现取到的条数明显更少（同一 entry 的多条被整批跳过）
		expect(new Set(seenById).size).toBeLessThan(all.length);
	});
});
