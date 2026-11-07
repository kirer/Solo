/**
 * 正文里的外链：默认在 Solo 里开，而不是跳走。
 *
 * 只接管**普通左键**点到的 `http(s)` 链接 —— ⌘/Ctrl/Shift/Alt 点、中键、右键菜单
 * 都留给浏览器/系统自己处理（想在新标签页打开的人不该被拦）。站内路径（`/`、`#`）
 * 不算外链，照旧走页面自己。
 */

export function builtinLink(href: string): boolean {
	return /^https?:\/\//i.test(href.trim());
}

export function installLinkBrowser(open: (url: string) => void): void {
	document.addEventListener("click", (event) => {
		if (event.defaultPrevented) return;
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		const target = event.target;
		if (!(target instanceof Element)) return;
		const anchor = target.closest("a[href]");
		if (anchor === null) return;
		const href = anchor.getAttribute("href") ?? "";
		if (!builtinLink(href)) return;
		event.preventDefault();
		open(href);
	});
}
