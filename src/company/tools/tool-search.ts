/**
 * `tool_search`：延迟工具（`deferred: true`）按需加载。
 *
 * ── 为什么不用 pi-durable 自带的那个 ──
 *
 * 自带的 `createToolSearchTool()` 用 BM25，分词器只保留 `[a-z0-9]`
 * （见 `node_modules/@earendil-works/pi-durable/dist/search.js` 的 `tokenize`）：
 *
 * ```js
 * .toLowerCase().split(/[^a-z0-9]+/)
 * ```
 *
 * 中文查询会被切得一个 token 都不剩 → `queryTerms.length === 0` → 直接返回空。
 * 而我们的工具描述**全是中文**，于是：
 *
 * ```
 * tool_search("推进项目状态") → "No matching tools found."
 * ```
 *
 * 这不是「搜得不准」，是**中文根本搜不到**。延迟加载对中文用户等于把能力删了。
 *
 * ── 现在怎么做 ──
 *
 * 两路混合打分，取并集后按分排序：
 * 1. **ASCII 词**：沿用 BM25 的思路（去停用词、简单词干），英文名/参数名仍能命中
 * 2. **中文二元组**：查询里的每个相邻二字组合，出现在文档里就加分
 *
 * 中文二元组是这里的关键：中文没有空格，用 bigram 当词是最省事且有效的近似
 * （「推进项目状态」→ 推进/进项/项目/目状/状态）。「项目」能命中 `project_status`。
 */
import { defineTool, Type, type ToolRegistration } from "../../runtime/index.ts";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";

/** 默认返回条数。 */
const DEFAULT_LIMIT = 8;

/** 英文停用词（与 pi-durable 一致）。 */
const STOP_WORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
	"in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "with",
]);

/** 简单词干：让 `issues` 命中 `issue`。 */
function stem(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
}

/** 拆出英文词（小写、去停用词、词干化）。 */
export function asciiTerms(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 0 && !STOP_WORDS.has(term))
		.map(stem);
}

/** 拆出中文二元组。 */
export function cjkBigrams(text: string): string[] {
	const out: string[] = [];
	for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
		if (run.length === 1) {
			out.push(run);
			continue;
		}
		for (let index = 0; index + 1 < run.length; index += 1) out.push(run.slice(index, index + 2));
	}
	return out;
}

/** 一个工具的可检索文本：名字 + 描述 + 参数名与参数说明。 */
function searchTextOf(tool: ToolRegistration): string {
	const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description ?? ""];
	const collect = (schema: unknown): void => {
		if (typeof schema !== "object" || schema === null) return;
		const node = schema as Record<string, unknown>;
		if (typeof node.description === "string") parts.push(node.description);
		const properties = node.properties;
		if (typeof properties === "object" && properties !== null) {
			for (const [key, value] of Object.entries(properties)) {
				parts.push(key);
				collect(value);
			}
		}
		collect(node.items);
		for (const key of ["anyOf", "oneOf", "allOf"]) {
			const variants = node[key];
			if (Array.isArray(variants)) for (const variant of variants) collect(variant);
		}
	};
	collect(tool.parameters);
	return parts.filter((part) => part.trim() !== "").join(" ");
}

/**
 * 给候选工具打分。返回 `[名字, 分数]`，按分数降序、同分保持注册顺序。
 *
 * 打分规则（够用就好，不追求信息检索的最优）：
 * - 工具名完全等于查询：+100（「我就知道它叫什么」）
 * - 工具名包含查询（或反之）：+40
 * - 命中一个英文词：+10
 * - 命中一个中文二元组：+4（二元组容易重复命中，所以单价比英文词低）
 * - 命中整个中文查询串：+30（「推进项目状态」原样出现在描述里）
 */
export function rankTools(
	query: string,
	candidates: readonly ToolRegistration[],
	limit: number,
): string[] {
	const trimmed = query.trim();
	if (trimmed === "" || limit <= 0) return [];

	const lowerQuery = trimmed.toLowerCase();
	const queryAscii = new Set(asciiTerms(trimmed));
	const queryCjk = new Set(cjkBigrams(trimmed));

	const scored = candidates.map((tool, index) => {
		const text = searchTextOf(tool);
		const lowerName = tool.name.toLowerCase();
		let score = 0;

		if (lowerName === lowerQuery) score += 100;
		else if (lowerName.includes(lowerQuery) || lowerQuery.includes(lowerName)) score += 40;

		if (text.includes(trimmed)) score += 30;

		const docAscii = new Set(asciiTerms(text));
		for (const term of queryAscii) if (docAscii.has(term)) score += 10;

		const docCjk = new Set(cjkBigrams(text));
		for (const bigram of queryCjk) if (docCjk.has(bigram)) score += 4;

		return { name: tool.name, score, index };
	});

	return scored
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || left.index - right.index)
		.slice(0, limit)
		.map((entry) => entry.name);
}

/**
 * 创建 `tool_search`。
 *
 * 加载方式是 `control: { addTools }`：pi-durable 会在本轮结束后把它写进会话的
 * `modelTools.add`，**下一次请求**这些工具就直接出现在模型面前
 * （且跨压缩保留，见 `node_modules/@earendil-works/pi-durable/dist/harness/agent.js` 的 `addTools`）。
 */
export function createToolSearchTool(): ToolRegistration {
	return defineTool({
		name: TOOL_SEARCH_TOOL_NAME,
		description: [
			"搜索那些没有直接给你的工具，并把它们加载进来（下次调用即可用）。",
			"你手上只有常用工具；长尾能力（立项、招聘、终止项目、圆桌、预算…）需要先用这个搜出来。",
			"查询可以用中文或英文，例如「立项」「招聘员工」「终止项目」「budget」。",
			"先用 my_capabilities 看自己总共有哪些能力（含按需加载的），再用这个加载需要的。",
		].join(""),
		parameters: Type.Object({
			query: Type.String({ description: "搜索词，中文或英文均可" }),
			limit: Type.Optional(Type.Number({ description: `最多返回几个，默认 ${DEFAULT_LIMIT}` })),
		}),
		execute: async (args, api, context) => {
			const max = args.limit ?? DEFAULT_LIMIT;
			if (!Number.isInteger(max) || max <= 0) {
				throw new Error("limit 必须是正整数。");
			}
			if (args.query.trim() === "") {
				throw new Error("query 不能为空。");
			}

			const agent = await api.agent(context);
			const candidates = agent.deferred;
			const loaded = rankTools(args.query, candidates, max);

			if (loaded.length === 0) {
				const available = candidates.map((tool) => tool.name).join("、");
				return {
					output: [
						{
							type: "text" as const,
							text: [
								`没有匹配「${args.query}」的工具。`,
								candidates.length === 0
									? "你现在没有按需加载的工具（所有能力都已直接可用）。"
									: `可以按需加载的有：${available}`,
								"换一个更贴近工具名的词再试，或直接用 my_capabilities 看清单。",
							].join("\n"),
						},
					],
				};
			}

			const lines = loaded.map((name) => {
				const tool = candidates.find((entry) => entry.name === name);
				const first = (tool?.description ?? "").trim().split(/\r?\n/)[0] ?? "";
				return `- ${name}: ${first}`;
			});

			return {
				output: [
					{
						type: "text" as const,
						text: [
							`已加载 ${loaded.length} 个工具，**下一次调用**起可直接使用：`,
							...lines,
						].join("\n"),
					},
				],
				control: { addTools: loaded },
			};
		},
	});
}
