/**
 * 图片放大器（需求 #6「聊天要能看图」）。
 *
 * 为什么做成**全局单例**而不是给每个 `.md-img` 绑事件：
 * 消息流每次刷新都整段重建 DOM（`renderMessages()` → `replaceChildren`），
 * 逐个绑定会在每轮刷新后全部失效；而且 markdown 渲染器（`markdown.js`）产出的是
 * 字符串，它没有机会去绑事件。所以只在 document 上挂**一次**委托，
 * 用 `capture` 抢在业务处理器之前——否则点图会先触发「点消息弹浮窗」。
 *
 * 挂载点不存在时才创建（`ensure()`）：大多数会话一辈子看不到图，
 * 不该在首屏就多一个节点。
 */

let layer = null;

function ensure() {
	if (layer !== null) return layer;
	layer = document.createElement("div");
	layer.className = "md-lightbox";
	layer.hidden = true;
	layer.setAttribute("role", "dialog");
	layer.setAttribute("aria-label", "图片预览（点击关闭）");
	document.body.append(layer);
	return layer;
}

function open(src, alt) {
	const box = ensure();
	const img = document.createElement("img");
	img.src = src;
	img.alt = alt;
	box.replaceChildren(img);
	box.hidden = false;
}

function close() {
	if (layer === null) return;
	layer.hidden = true;
	// 清掉 img：否则大图会一直留在内存里（几百 KB × N 张）
	layer.replaceChildren();
}

/**
 * 装一次全局委托。返回 `{ close }` 方便调试，正常不用。
 *
 * - 点正文里的图 → 放大
 * - 点遮罩 / 按 Esc → 关闭
 * - 图加载失败 → 打 `data-broken`，样式里给个可见占位（而不是 0×0 空洞）
 */
export function initLightbox() {
	if (document.body.dataset.lightbox === "on") return { close };
	document.body.dataset.lightbox = "on";

	document.addEventListener(
		"click",
		(event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;

			// 图 → 打开
			const img = target.closest(".md-img img");
			if (img instanceof HTMLImageElement) {
				event.preventDefault();
				event.stopPropagation();
				open(img.getAttribute("src") ?? "", img.getAttribute("alt") ?? "");
				return;
			}

			// 遮罩本身 → 关闭（点图内部不算）
			if (target.classList.contains("md-lightbox")) {
				event.stopPropagation();
				close();
			}
		},
		// capture：必须先于频道消息流的「点消息弹浮窗」处理器
		true,
	);

	document.addEventListener(
		"error",
		(event) => {
			const target = event.target;
			if (target instanceof HTMLImageElement && target.closest(".md-img") !== null) {
				target.dataset.broken = "true";
				target.alt = `图片加载失败：${target.alt}`;
			}
		},
		// img 的 error 不冒泡，只能用 capture 在捕获阶段拿
		true,
	);

	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") close();
	});

	return { close };
}
