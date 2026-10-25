/**
 * 待办与选项的**解析**逻辑（纯函数，无 DOM）。
 *
 * 历史：这个文件原本还负责渲染聊天面板顶部那块「待办卡片区」（`#ask-area`）。
 * 那块区域已经移除——一条待决问题本质就是「有人在等你回话」，它属于对话本身，
 * 应该在聊天流里渲染（见 ui/js/chat.js 的 renderPending）。同一条问题出现两次、
 * 答完还没反应，正是用户报的问题。现在只留下两条路径共用的解析与判断。
 *
 * 导出的三样东西：
 * - `splitOptionsFromText`：assistant 回复里「确实在问你选一个」的编号列表 → 选项；
 * - `optionsFromItem`：一条待决项的结构化选项（含从正文解析的兜底）；
 * - `looksLikeChoice` / 内部解析器：判断「这是不是真的在让人选」，宁可漏判不可误判——
 *   把「1. 读文件」这种步骤渲染成可点按钮，点一下就会把步骤当答案发出去。
 */
const MAX_OPTIONS = 9;

/* ── 纯函数：选项解析 ───────────────────────────────────────────────────── */

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩";
const OPTION_LINE = /^\s*(?:([①-⑩])|(\d{1,2})\s*[.、)）]|[-*]\s+)(?:\s*)(.+?)\s*$/;

/** 一行是不是选项行（带圈编号 / 阿拉伯数字 / 短横线列表）。 */
function optionOf(line) {
	const match = OPTION_LINE.exec(line);
	if (match === null) return null;
	const label = String(match[3] ?? "").trim();
	if (label === "") return null;
	return { label };
}

/** 从一段文字末尾解析出连续编号选项块。 */
function trailingOptions(raw) {
	const lines = String(raw ?? "").split("\n");
	const picked = [];
	let index = lines.length - 1;
	while (index >= 0) {
		const line = lines[index];
		if (line.trim() === "") {
			// 允许选项块与正文之间正好一个空行；再往前就是正文了
			if (picked.length === 0) {
				index -= 1;
				continue;
			}
			break;
		}
		const option = optionOf(line);
		if (option === null) break;
		picked.unshift(option);
		index -= 1;
	}
	if (picked.length < 2 || picked.length > MAX_OPTIONS) return null;
	return { options: picked, startLine: index + 1 };
}

/**
 * 从一行里解析带圈编号选项（处置问题的正文格式常是一行两项）。
 *
 * 「选项：① 暂搁（推荐）② 永久放弃」——trailingOptions 只认独立成行的列表，
 * 这里补一条：一行里出现 ≥2 个 ①-⑩ 时按它们切分。
 */
function circledOptionsIn(text) {
	const lines = String(text ?? "").split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line === undefined || !/[①-⑩]/.test(line)) continue;
		const marks = [...line.matchAll(/[①-⑩]\s*([^①-⑩]+)/g)]
			.map((match) => String(match[1] ?? "").trim())
			.filter((label) => label !== "");
		if (marks.length < 2 || marks.length > MAX_OPTIONS) continue;
		return { options: marks.map((label) => ({ label })), startLine: index, endLine: index + 1 };
	}
	return null;
}

/**
 * 正文里有没有「让人选一个」的信号。
 *
 * 刻意保守：计划清单 / 步骤列表 / 普通编号要点都不能长成可点的选项——
 * 点一下就会把「1. 读文件」当成回答发给模型。只有明确的选择语义才放行。
 */
function looksLikeChoice(intro, options) {
	const body = String(intro ?? "").trimEnd();
	if (body === "") return false;
	const lines = body.split("\n");
	const lastLine = String(lines[lines.length - 1] ?? "").trim();
	const tail = body.slice(-320);

	// 正文最后一句话本身是个问题（问号收尾；内联选项时问题可能在倒数第二行）
	const lastTwo = lines.slice(-2).map((line) => line.trim());
	if (lastTwo.some((line) => /[?？]["'”』」)）]?$/.test(line)) || /[?？]["'”』」)）]?$/.test(body.trim())) {
		return true;
	}
	// 明确的「选一个」语义
	if (/(选一个|挑一个|选择一个|选哪|挑哪|哪个|哪一个|哪一项|哪一种|选择一项)/.test(tail)) return true;
	if (/(要不要|还是|二选一|三选一)/.test(tail)) return true;
	// 第二人称 + 选择动词：例如「你选一个」「请挑一个」「需要你确认」
	if (/(请|麻烦|需要|你|您)[^。！\n]{0,16}(选|挑|决定|确认|回复|回答|处置|怎么办|怎么处理|如何处理)/.test(tail)) {
		return true;
	}
	// 真正在问选择时，列表通常很短；没有任何选择信号的长列表一律不当选项
	void options;
	return false;
}

/**
 * 从 assistant 回复里切出「正文 + 选项」。
 *
 * @returns {{ body: string, options: { label: string }[] } | null}
 */
export function splitOptionsFromText(raw) {
	const text = String(raw ?? "");
	const lines = text.split("\n");
	const trailing = trailingOptions(text);
	const parsed = trailing ?? circledOptionsIn(text);
	if (parsed === null) return null;
	// 选项块之前的正文：用来判断是不是真的在问选择
	const intro = (trailing === null
		? [...lines.slice(0, parsed.startLine), lines.slice(parsed.endLine).join("\n")].join("\n")
		: lines.slice(0, parsed.startLine).join("\n")
	).trimEnd();
	const optionLine = lines.slice(parsed.startLine, parsed.endLine).join("\n");
	if (!looksLikeChoice(`${intro}\n${optionLine}`, parsed.options)) return null;
	const optionLabels = parsed.options.map((option) => option.label);
	if (optionLabels.some((label) => label === "")) return null;
	return { body: intro, options: parsed.options };
}

/** 待决项的结构化选项（可能没有）。 */
export function optionsFromItem(item) {
	const list = Array.isArray(item?.disposition?.options)
		? item.disposition.options
		: Array.isArray(item?.options)
			? item.options
			: null;
	if (list !== null && list.length > 0) {
		return list.slice(0, MAX_OPTIONS).map((option) => ({
			label: String(option?.label ?? option?.id ?? "").trim(),
			recommended: option?.recommended === true,
		}));
	}
	const question = String(item?.question ?? "");
	const parsed = trailingOptions(question) ?? circledOptionsIn(question);
	if (parsed === null) return [];
	return parsed.options.map((option) => ({ label: option.label, recommended: false }));
}

