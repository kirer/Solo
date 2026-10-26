/**
 * 轻提示（toast）。
 *
 * 历史：这块逻辑原本长在 `chat.js` 里。老板拍板去掉右侧对话面板之后
 * （「去掉右侧聊天面板」），聊天面板不再常驻，但「发失败 / 连接在重连」这类
 * 一次性反馈还得有地方去——于是把它提成独立模块，挂到 `<body>` 上的一个浮层，
 * 不依赖任何面板存在。
 *
 * 只用 `append` + 定时淡出，不重建 DOM，不碰任何面板的布局。
 */

/** 一条 toast 停留多久（毫秒）。 */
const TOAST_MS = 3_600;

/** 最多同时堆几条（超了从最旧的开始丢）。 */
const MAX_TOASTS = 3;

let container = null;

function ensureContainer() {
	if (container !== null && container.isConnected) return container;
	container = document.createElement("div");
	container.className = "chat-toasts app-toasts";
	// 读屏：toast 是「顺带说一句」，不该打断正在读的内容。
	container.setAttribute("aria-live", "polite");
	container.setAttribute("role", "status");
	document.body.append(container);
	return container;
}

/**
 * 弹一条提示。
 *
 * @param {string} text 内容。空白串直接忽略（调用方常常把 error.message 透传进来）。
 * @param {"info"|"warn"|"error"} [tone] 语气。只有 warn / error 会被染成告警色。
 */
export function notify(text, tone = "info") {
	const value = String(text ?? "").trim();
	if (value === "") return;
	const box = ensureContainer();
	const toast = document.createElement("div");
	toast.className = "chat-toast";
	toast.dataset.tone = tone === "warn" || tone === "error" ? tone : "info";
	toast.textContent = value;
	box.append(toast);
	while (box.children.length > MAX_TOASTS) box.firstElementChild.remove();
	window.setTimeout(() => {
		toast.classList.add("is-out");
		window.setTimeout(() => toast.remove(), 200);
	}, TOAST_MS);
}
