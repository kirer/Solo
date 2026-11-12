/**
 * 更新弹窗里「这一版改了什么」那一段的排版（纯函数，不碰清单、不碰窗口）。
 *
 * 清单里的 `notes` 是发版时从 `git log` 标题生成的 `string[]`（一条一行、人话、
 * 不带 `feat:` 这类前缀），生成侧归发布流程。这里只负责把它排成能塞进
 * Electron 原生 `dialog.showMessageBox` 的 `detail` 的一段文字。
 *
 * 为什么要截：原生 messageBox 的 `detail` 没有滚动、没有排版，塞长了系统自己截，
 * 截在哪一句不知道。所以四层闸全在自己这边收：
 *
 *   ① 单条超过 60 个字 → 截到 57 个字 + `…`
 *   ② 最多显示 5 条 → 多的收成一行「…还有 N 条」
 *   ③ 整段（含引导句）不超过 600 个字符 → 超了从最后一条往前删
 *   ④ 条目里的换行、制表符压成一个空格，免得把 `detail` 的版式撑开
 *
 * 字一律按 `Array.from` 数（中文、emoji 都算 1 个），不按 UTF-16 长度数。
 */

/** 引导句。没有 notes 时整段返回空串，调用方据此退回旧文案。 */
const HEADING = "这一版改了什么：";
/** 单条超过这个字数就截。 */
const ITEM_LIMIT = 60;
/** 截到多少个字（后面再补一个省略号）。 */
const ITEM_KEEP = 57;
/** 最多显示几条。 */
const ITEM_MAX = 5;
/** 整段字符数上限。 */
const BLOCK_LIMIT = 600;

const chars = (text: string): string[] => Array.from(text);

/** 换行、制表符、连续空白一律压成一个空格，两端剪掉。 */
function squeeze(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** 单条截断：正好 60 个字不动，61 个才截。 */
function clip(text: string): string {
	const list = chars(text);
	if (list.length <= ITEM_LIMIT) return text;
	return `${list.slice(0, ITEM_KEEP).join("")}…`;
}

/** 没有 notes 时弹窗 detail 的原文案。老版本用户看到的字一个都不能变。 */
const ASK = "现在下载吗？下载完会再问一次要不要重启安装。";

/**
 * 把清单里的 `notes` 排成弹窗里那一段。`notes` 为空（或全是空白）时返回 `""`，
 * 调用方应当照旧只显示「当前是 X。现在下载吗？」。
 */
export function formatNotes(notes: readonly string[]): string {
	const items = notes.map((note) => clip(squeeze(note))).filter((note) => note !== "");
	if (items.length === 0) return "";

	let shown = items.slice(0, ITEM_MAX);
	let hidden = items.length - shown.length;

	const render = (): string => {
		const lines = shown.map((note) => `· ${note}`);
		if (hidden > 0) lines.push(`· …还有 ${hidden} 条，见 Release 页面`);
		return [HEADING, ...lines].join("\n");
	};

	let block = render();
	// ③ 整段超了就从最后一条往前删，删一条重排一次。
	while (chars(block).length > BLOCK_LIMIT && shown.length > 0) {
		shown = shown.slice(0, -1);
		hidden = items.length - shown.length;
		block = render();
	}
	return block;
}

/**
 * 「有新版本」那个弹窗的 `detail` 全文：当前版本 → 这一版改了什么 → 追问。
 * `notes` 为空时**逐字**等于加这一版之前的文案，老清单的用户看不出任何差别。
 */
export function versionDetail(current: string, notes: readonly string[]): string {
	const block = formatNotes(notes);
	if (block === "") return `当前是 ${current}。${ASK}`;
	return `当前是 ${current}。\n\n${block}\n\n${ASK}`;
}
