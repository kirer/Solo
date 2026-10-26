/**
 * 待办卡片：老板在频道里拍板 / 处置一件事的那块界面。
 *
 * 历史：这块逻辑原本长在 `ui/js/chat.js`（右侧对话面板）的闭包里。老板拍板
 * 「去掉右侧聊天面板」之后，面板没了、待办的渲染与提交也就没了入口——组织图上的
 * 红点还在，但老板点不到任何能回话的地方。现在把它搬进频道消息流：
 *
 * - **渲染位置**：跟在当前频道最后一条消息之后（不是顶部黄框——用户明确否掉过）。
 *   待办是「有人在等你回话」，它属于对话本身，不该另开一块区域。
 * - **数据来源**：`GET /api/channels/:id` 的 `pending` 字段（见 src/server/channels-view.ts）。
 *   后端已经算好 `canDispose`（权限口径只在 `canDisposePending` 一处定义），界面不自己算。
 * - **提交**：三种动作各调一个接口，都在这里，不回到 app.js 绕一圈——
 *   答复 `/api/answer`、处置 `/api/pending/dispose`、接管 `/api/pending/take-over`。
 *
 * 设计上刻意保留「本地即时反馈」：提交成功后卡片当场变「已答复」，不等下一次轮询。
 * 用户答完要马上看到生效，这是这个组件唯一的存在意义。
 */
import { clockTime, escapeAttr, escapeHtml, relTime } from "./format.js";
import { icon } from "./icons.js";
import { elFromHtml, plainText } from "./dom-utils.js";

/**
 * 卡片渲染器工厂。
 *
 * @param {object} options
 * @param {(key: string) => void} [options.onSettled] 一条待办被答复/处置/接管后调用，
 *   宿主据此重新拉一次频道（让卡片从流里消失）。不传就只做本地视觉反馈。
 */
export function initPending({ onSettled } = {}) {
	/** 本地已结算的 key：轮询回来时 pending 里已经没有它，但过渡期不该再可点。 */
	const answered = new Set();

	function settled(key, card, label) {
		answered.add(key);
		if (card !== null) {
			card.classList.remove("is-submitting");
			card.classList.add("is-answered");
			const state = card.querySelector(".pend-state");
			if (state !== null) state.textContent = label;
			else {
				card
					.querySelector(".pend-head")
					?.insertAdjacentHTML("beforeend", `<span class="pend-state">${escapeHtml(label)}</span>`);
			}
			for (const button of card.querySelectorAll("button")) button.disabled = true;
		}
		if (typeof onSettled === "function") onSettled(key);
	}

	/**
	 * 渲染一条待办。
	 *
	 * 选项：后端给了结构化 options 就用；否则不猜（自由输入永远可用）。
	 * 最后一项固定「自定义输入」，与 DSH 的选择框一致。
	 */
	function render(item) {
		const disposition = item.disposition === true;
		const options = Array.isArray(item.options) ? item.options : [];
		const optionHtml =
			options.length === 0
				? ""
				: `<div class="pend-options" role="radiogroup" aria-label="选项">
					${options
						.map(
							(option, index) => `<button class="pend-opt" type="button" role="radio" aria-checked="false"
								data-pending-option="${index}" data-label="${escapeAttr(option.label)}">
								<span class="pend-opt-key">${index + 1}</span>
								<span class="pend-opt-label">${escapeHtml(option.label)}</span>
								${option.recommended === true ? '<span class="pend-opt-hint">推荐</span>' : ""}
							</button>`,
						)
						.join("")}
					<button class="pend-opt pend-opt--custom" type="button" data-pending-option="custom">
						<span class="pend-opt-key">${Math.min(options.length + 1, 9)}</span>
						<span class="pend-opt-label">自定义输入</span>
						${icon("edit", 12)}
					</button>
				</div>`;

		const node = elFromHtml(`
			<div class="pend${disposition ? " pend--disposition" : ""}" data-pending-key="${escapeAttr(item.key)}">
				<div class="pend-head">
					<span class="pend-kicker">${icon(disposition ? "alert" : "bell", 12)}<span>${
						disposition ? "等你处置" : "需要你拍板"
					}</span></span>
					<span class="pend-from">来自 ${escapeHtml(item.from)}</span>
					<span class="pend-time">${escapeHtml(relTime(item.askedAt))}</span>
				</div>
				<div class="pend-q">${plainText(item.question)}</div>
				${traceHtml(item)}
				${optionHtml}
				<form class="pend-reply">
					<textarea rows="1" placeholder="${
						options.length === 0 ? "写下你的决定…" : "也可以直接写…"
					}" aria-label="你的决定"></textarea>
					<button class="pend-send" type="submit" aria-label="提交决定">${icon("send", 14)}</button>
				</form>
				${disposeActionsHtml(item)}
				<p class="pend-err" hidden>没提交成功，再试一次。</p>
			</div>`);
		node.dataset.raw = String(item.question ?? "");
		if (answered.has(item.key)) node.classList.add("is-answered");
		return node;
	}

	/**
	 * 「驳回 / 标记已解决」两个操作。
	 *
	 * 只在后端说「这条该你处置」时渲染（`item.canDispose`）。后端仍会在
	 * /api/pending/dispose 再拦一次，界面隐藏按钮只是体验、不是防线。
	 */
	function disposeActionsHtml(item) {
		// CEO 接管（缺陷 B）：CEO 复核后认为「这在我授权范围内」，拉回自己层处理。
		// 与驳回/已解决并列但不共用权限位：takeOver 的后端口径是 canTakeOver
		// （只有 CEO + owner 级 + 未答复未处置），dispose 的是 canDispose。
		const takeOverHtml =
			item.canTakeOver === true
				? `<button class="pend-dispose-btn pend-dispose-btn--takeover" type="button" data-pending-takeover="1">
					<span>接管到 CEO</span></button>`
				: "";
		if (item.canDispose !== true && takeOverHtml === "") return "";
		const disposeHtml =
			item.canDispose === true
				? `<button class="pend-dispose-btn" type="button" data-pending-dispose="resolved">${icon(
						"check",
						12,
					)}<span>标记已解决</span></button>
				<button class="pend-dispose-btn pend-dispose-btn--reject" type="button" data-pending-dispose="rejected">
					<span>驳回</span></button>
				<form class="pend-reject-form" hidden>
					<textarea rows="1" placeholder="驳回理由（必填）…" aria-label="驳回理由"></textarea>
					<button class="pend-reject-send" type="submit">确认驳回</button>
				</form>`
				: "";
		return `<div class="pend-dispose">${disposeHtml}${takeOverHtml}</div>`;
	}

	/**
	 * 来源说明（缺陷 B 要求 4）：老板级待办为什么到了老板这儿。
	 * 后端在 `item.trace` 里给好文本，界面只负责显示。
	 */
	function traceHtml(item) {
		const note = item.trace?.note;
		if (typeof note !== "string" || note === "") return "";
		return `<div class="pend-trace">${icon("bell", 11)}<span>${escapeHtml(note)}</span></div>`;
	}

	/* ── 提交 ── */

	/** 显示后端给的可读原因（越权 / 已处置 / 不存在），不自己编文案。 */
	function showError(card, message, fallback) {
		const err = card.querySelector(".pend-err");
		if (err === null) return;
		err.textContent = message === "" ? fallback : message;
		err.removeAttribute("hidden");
	}

	async function postJson(path, body) {
		try {
			const response = await fetch(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const data = await response.json().catch(() => null);
			const ok = response.ok && (data?.ok === true || path === "/api/answer");
			const message = ok ? "" : String(data?.error ?? data?.reason ?? `HTTP ${response.status}`);
			return { ok, message };
		} catch {
			return { ok: false, message: "网络异常，没提交成功。" };
		}
	}

	async function submitReply(card, text) {
		const key = card?.dataset.pendingKey ?? "";
		const value = String(text ?? "").trim();
		if (key === "" || value === "") {
			card?.querySelector(".pend-reply textarea")?.focus();
			return;
		}
		const button = card.querySelector(".pend-send");
		const textarea = card.querySelector(".pend-reply textarea");
		if (button !== null) button.disabled = true;
		if (textarea !== null) textarea.disabled = true;
		card.classList.add("is-submitting");

		const { ok, message } = await postJson("/api/answer", { key, text: value });
		if (!ok) {
			card.classList.remove("is-submitting");
			if (button !== null) button.disabled = false;
			if (textarea !== null) textarea.disabled = false;
			showError(card, message, "没提交成功，再试一次。");
			return;
		}
		settled(key, card, "已答复");
	}

	async function submitDispose(card, status, reason) {
		const key = card?.dataset.pendingKey ?? "";
		if (key === "") return;
		const value = String(reason ?? "").trim();
		if (status === "rejected" && value === "") {
			// 驳回必须给理由（与后端同口径）：没写就展开输入框，不发请求。
			const form = card.querySelector(".pend-reject-form");
			if (form !== null) {
				form.hidden = false;
				form.querySelector("textarea")?.focus();
			}
			return;
		}

		const buttons = card.querySelectorAll(".pend-dispose-btn, .pend-reject-send");
		for (const button of buttons) button.disabled = true;
		card.classList.add("is-submitting");

		const { ok, message } = await postJson("/api/pending/dispose", { key, status, reason: value });
		if (!ok) {
			card.classList.remove("is-submitting");
			for (const button of buttons) button.disabled = false;
			showError(card, message, "没提交成功，再试一次。");
			return;
		}
		settled(key, card, status === "rejected" ? "已驳回" : "已解决");
	}

	async function submitTakeOver(card) {
		const key = card?.dataset.pendingKey ?? "";
		if (key === "") return;
		const buttons = card.querySelectorAll("[data-pending-takeover]");
		for (const button of buttons) button.disabled = true;
		card.classList.add("is-submitting");

		const { ok, message } = await postJson("/api/pending/take-over", { key });
		if (!ok) {
			card.classList.remove("is-submitting");
			for (const button of buttons) button.disabled = false;
			showError(card, message, "没提交成功，再试一次。");
			return;
		}
		settled(key, card, "已接管");
	}

	/* ── 事件 ── */

	/**
	 * 处理一次点击。返回 true 表示这次点击属于待办卡片（宿主别再处理）。
	 *
	 * 用事件委托而不是逐卡绑监听：消息流每次轮询都整段重建，
	 * 逐卡绑等于每轮泄漏一批 listener。
	 */
	function onClick(event) {
		const target = event.target instanceof Element ? event.target : null;
		if (target === null) return false;
		const card = target.closest("[data-pending-key]");
		if (card === null) return false;

		// 选项：点一下把文案填进输入框（不直接提交——老板可能想改两个字）。
		const option = target.closest("[data-pending-option]");
		if (option !== null) {
			const value = option.dataset.pendingOption;
			const textarea = card.querySelector(".pend-reply textarea");
			if (textarea !== null) {
				if (value === "custom") {
					textarea.value = "";
					textarea.focus();
				} else {
					textarea.value = option.dataset.label ?? "";
					textarea.focus();
				}
			}
			for (const sibling of card.querySelectorAll("[data-pending-option]")) {
				const picked = sibling === option;
				sibling.classList.toggle("is-picked", picked);
				sibling.setAttribute("aria-checked", picked ? "true" : "false");
			}
			return true;
		}

		const dispose = target.closest("[data-pending-dispose]");
		if (dispose !== null) {
			const form = card.querySelector(".pend-reject-form");
			const reason = form?.querySelector("textarea")?.value ?? "";
			submitDispose(card, dispose.dataset.pendingDispose, reason);
			return true;
		}

		if (target.closest("[data-pending-takeover]") !== null) {
			submitTakeOver(card);
			return true;
		}
		return false;
	}

	/**
	 * Enter 直接提交（Shift+Enter 换行）。
	 *
	 * 与 chat.js 同一套：待办卡片里的 textarea 在 Safari 里单独按 Enter 不会
	 * 触发表单 submit，所以必须自己接。中文输入法选词时的 Enter 不算提交。
	 */
	function onKeydown(event) {
		const target = event.target;
		if (!(target instanceof Element)) return false;
		if (event.key !== "Enter" || event.shiftKey) return false;
		if (event.isComposing || event.keyCode === 229) return false;
		const card = target.closest("[data-pending-key]");
		if (card === null || !target.matches("textarea")) return false;
		event.preventDefault();
		const form = target.closest("form");
		if (form?.classList.contains("pend-reject-form") === true) {
			submitDispose(card, "rejected", target.value ?? "");
		} else {
			submitReply(card, target.value ?? "");
		}
		return true;
	}

	/** 处理一次提交（Enter / 点发送）。返回 true 表示被待办卡片吃掉了。 */
	function onSubmit(event) {
		const target = event.target;
		if (!(target instanceof Element)) return false;
		const card = target.closest("[data-pending-key]");
		if (card === null) return false;

		if (target.matches(".pend-reply")) {
			event.preventDefault();
			submitReply(card, target.querySelector("textarea")?.value ?? "");
			return true;
		}
		if (target.matches(".pend-reject-form")) {
			event.preventDefault();
			submitDispose(card, "rejected", target.querySelector("textarea")?.value ?? "");
			return true;
		}
		return false;
	}

	/** 当前时间（用于卡片上的相对时间；轮询重渲染时会刷新）。 */
	function stamp(at) {
		return clockTime(at);
	}

	return { render, onClick, onSubmit, onKeydown, isAnswered: (key) => answered.has(key), stamp };
}
