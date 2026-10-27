/**
 * 新前端（世代 2 频道页）的共享小工具。
 *
 * 与 `ui/js/format.js` 的关系：那个文件是旧前端（组织图 / 看板 / 设置 / 档案 / 流水）
 * 共用的，里面有大量本页用不到的东西（token 格式化、状态色、工具图标映射）。
 * 这里只留本页真正用到的五个：转义、相对时间、时钟、头像色、剪贴板。
 *
 * 为什么新开一份而不是抽公共：旧前端的这些函数与它的 CSS 变量、图标表绑在一起，
 * 抽出来会连带把旧概念搬进新页面。等旧前端删掉，这两份自然合一。
 */

export function escapeHtml(text) {
	return String(text ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function escapeAttr(text) {
	return escapeHtml(text).replace(/`/g, "&#96;");
}

/** 列表里的相对时间：「刚刚 / 3 分钟前 / 昨天 14:05」。 */
export function relTime(at, now = Date.now()) {
	const diff = now - at;
	if (!Number.isFinite(diff)) return "";
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	if (diff < 172_800_000) return "昨天";
	if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)} 天前`;
	return new Date(at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** 消息气泡上的时间：`HH:MM`。 */
export function clockTime(at) {
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) return "";
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 同一天的时刻分隔条：`今天 14:05` / `10月26日 14:05`。 */
export function dayLabel(at, now = Date.now()) {
	const date = new Date(at);
	const today = new Date(now);
	const sameDay =
		date.getFullYear() === today.getFullYear() &&
		date.getMonth() === today.getMonth() &&
		date.getDate() === today.getDate();
	if (sameDay) return "今天";
	const day = `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
	return date.getFullYear() === today.getFullYear() ? day : `${date.getFullYear()} 年 ${day}`;
}

export function sameDay(a, b) {
	const left = new Date(a);
	const right = new Date(b);
	return (
		left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate()
	);
}

/**
 * 头像底色：由名字算出稳定色相。
 *
 * 用固定饱和度和明度而不是随机：同一人在列表、气泡、档案里必须同色，
 * 否则眼睛会以为是两个人。
 */
export function hueFor(label) {
	let hash = 0;
	for (const char of String(label ?? "")) hash = (hash * 31 + char.codePointAt(0)) % 360;
	return hash;
}

export function initials(label) {
	const text = String(label ?? "").trim();
	if (text === "") return "?";
	// 中文取首字，英文取首字母（最多两个）。
	if (/[\u4e00-\u9fa5]/.test(text)) return text.slice(0, 1);
	const words = text.split(/\s+/).filter(Boolean);
	return words.slice(0, 2).map((word) => word[0].toUpperCase()).join("");
}

/** 复制到剪贴板，失败时返回 false（页面自己决定怎么提示）。 */
export async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// 无 https / 无权限时退回 execCommand（老浏览器与 http:// 局域网访问都走这条）。
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.append(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	}
}
