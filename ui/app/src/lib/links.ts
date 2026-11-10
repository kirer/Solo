import { MD_IMAGE_FAIL_CLASS } from "./markdown.ts";
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

/**
 * 正文里的文件路径（`` `teams/x/a.md` ``、`[周报](teams/x/a.md)`）：点开是右栏的预览层。
 *
 * 和上面那条分开装：外链是「跳出去看」，路径是「在 Solo 里看」，两者不共用一条判断。
 */
export function installPathPreview(open: (path: string) => void): void {
	document.addEventListener("click", (event) => {
		if (event.defaultPrevented) return;
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		const target = event.target;
		if (!(target instanceof Element)) return;
		const node = target.closest("[data-path]");
		if (node === null) return;
		const path = node.getAttribute("data-path") ?? "";
		if (path === "") return;
		event.preventDefault();
		open(path);
	});
}

/**
 * 正文里的本地图片（`` `teams/x/a.png` `` 画成的那张）：读不出来时别留一个破图。
 *
 * `img` 的 `error` 不冒泡，所以用捕获阶段在 `document` 上听一次。换成一个可点的
 * 「看不了，点这里去右栏」——路径本身没变，点下去还是走 `openRightFile`，由后端说
 * 到底是找不到还是不支持。
 */
export function installBrokenImages(open: (path: string) => void): void {
	document.addEventListener(
		"error",
		(event) => {
			const target = event.target;
			if (!(target instanceof HTMLImageElement)) return;
			const holder = target.closest(".md-img");
			if (holder === null) return;
			const path = target.getAttribute("title") ?? target.getAttribute("alt") ?? "";
			const label = path === "" ? "这张图看不了，点这里" : `${path} 看不了，点这里`;
			const button = document.createElement("button");
			button.type = "button";
			button.className = MD_IMAGE_FAIL_CLASS;
			button.textContent = label;
			button.addEventListener("click", (click) => {
				click.preventDefault();
				if (path !== "") open(path);
			});
			holder.replaceChildren(button);
		},
		true,
	);
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
