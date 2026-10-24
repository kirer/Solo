/** 对话面板（占位实现，由 chat-dev 替换）。 */
import { escapeHtml } from "./format.js";
export function initChat({ onSend }) {
	const body = document.getElementById("chat-body");
	return {
		setActor(actor) {
			document.getElementById("chat-title").textContent = actor.label;
			document.getElementById("chat-role").textContent = actor.subtitle;
			document.getElementById("chat-avatar").textContent = actor.label.slice(0, 1);
		},
		setFeed(feed) {
			body.innerHTML = feed.items
				.map((item) => `<p>${escapeHtml(item.text ?? item.name ?? "")}</p>`)
				.join("");
		},
		setLoading() { body.innerHTML = '<p class="note">加载中…</p>'; },
		clear() { body.innerHTML = ""; },
		addLocalQueued() {},
		notify() {},
		toggle() {},
		openSheet() {},
		closeSheet() {},
		expand() {},
		updateOrg() {},
	};
	void onSend;
}
