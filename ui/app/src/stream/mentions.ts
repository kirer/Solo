/**
 * 把正文里的 `@名字` / `@owner` 画成强调色，并统一显示成 `@老大`。
 *
 * 为什么在 DOM 上做而不是在 Markdown 渲染时做：Markdown 已经把正文转成 HTML 了，
 * 在字符串上正则替换会误伤标签内部和代码块。这里只走文本节点，且跳过 `pre`/`code`。
 * 代价是要一次 DOM 遍历 —— 只在正文变化时跑一遍，可以接受。
 */

const OWNER_ALIASES = /^@(?:owner|老板)$/i;
const AT = /@[\p{L}\p{N}._-]+/gu;

export function paintMentions(root: HTMLElement): void {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (parent === null) return NodeFilter.FILTER_REJECT;
			if (parent.closest("pre, code, a") !== null) return NodeFilter.FILTER_REJECT;
			return AT.test(node.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
		},
	});

	const jobs: Text[] = [];
	while (walker.nextNode()) jobs.push(walker.currentNode as Text);
	for (const node of jobs) paint(node);
}

function paint(node: Text): void {
	const text = node.nodeValue ?? "";
	AT.lastIndex = 0;
	if (!AT.test(text)) return;
	AT.lastIndex = 0;

	const fragment = document.createDocumentFragment();
	let last = 0;
	for (const match of text.matchAll(AT)) {
		const token = match[0];
		const at = match.index;
		if (at > last) fragment.append(text.slice(last, at));
		const span = document.createElement("span");
		span.className = "mention-name";
		// 历史消息里写的是 `@owner`（那时还没有「老大」这个叫法），
		// 显示层统一换掉，不去洗库：库里的原文是事实。
		span.textContent = OWNER_ALIASES.test(token) ? "@老大" : token;
		fragment.append(span);
		last = at + token.length;
	}
	if (last < text.length) fragment.append(text.slice(last));
	node.replaceWith(fragment);
}
