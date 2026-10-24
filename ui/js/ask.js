/**
 * 待你拍板的卡片。
 *
 * 只在组织快照里 forYou 的条目上出现；提交走 /api/answer（由 app.js 注入）。
 * 不在每次 SSE 推送时重建：签名没变就直接返回，避免打字被打断。
 */
import { escapeHtml, relTime } from "./format.js";
import { icon } from "./icons.js";

let onSubmit;
let signature = "";
let bound = false;

export function initAsk({ onAnswer }) {
	onSubmit = onAnswer;
	const area = document.getElementById("ask-area");

	if (!bound) {
		bound = true;
		area.addEventListener("submit", (event) => {
			const form = event.target.closest(".ask-reply");
			if (form === null) return;
			event.preventDefault();
			void submit(form);
		});
		area.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey) return;
			const textarea = event.target.closest("textarea");
			if (textarea === null) return;
			event.preventDefault();
			void submit(textarea.closest(".ask-reply"));
		});
		area.addEventListener("input", (event) => {
			const textarea = event.target.closest("textarea");
			if (textarea === null) return;
			textarea.style.height = "auto";
			textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
		});
	}

	return { render };
}

function render(items) {
	const area = document.getElementById("ask-area");
	const list = Array.isArray(items) ? items : [];
	const next = list.map((item) => `${item.key}:${item.askedAt}:${item.question.length}`).join("|");
	if (next === signature) return;
	signature = next;

	if (list.length === 0) {
		area.innerHTML = "";
		return;
	}

	area.innerHTML = list
		.map(
			(item, index) => `
		<article class="ask" data-key="${escapeHtml(item.key)}" style="--i:${index}">
			<div class="ask-top">
				<span class="ask-kicker"><i></i>需要你拍板</span>
				<span class="ask-from">来自 ${escapeHtml(item.from)}</span>
				<span class="ask-time">${escapeHtml(relTime(item.askedAt))}</span>
			</div>
			<div class="ask-q">${questionHtml(item.question)}</div>
			<form class="ask-reply">
				<label class="sr-only" for="answer-${escapeHtml(item.key)}">你的决定</label>
				<textarea id="answer-${escapeHtml(item.key)}" rows="1" placeholder="给出你的决定…"></textarea>
				<button class="ask-send" type="submit">${icon("send", 14)}<span>发送</span></button>
			</form>
		</article>`,
		)
		.join("");
}

function questionHtml(text) {
	return escapeHtml(text).replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
}

async function submit(form) {
	if (form === null) return;
	const card = form.closest(".ask");
	if (card === null || form.dataset.busy === "1") return;
	const textarea = form.querySelector("textarea");
	const button = form.querySelector(".ask-send");
	const text = String(textarea?.value ?? "").trim();
	if (text === "") {
		textarea?.focus();
		return;
	}

	form.dataset.busy = "1";
	if (button !== null) {
		button.disabled = true;
		button.innerHTML = '<span>发送中…</span>';
	}

	try {
		const ok = await onSubmit(card.dataset.key, text);
		if (ok === false) throw new Error("提交失败");
		card.classList.add("is-done");
		setTimeout(() => card.remove(), 260);
	} catch {
		form.dataset.busy = "0";
		if (button !== null) {
			button.disabled = false;
			button.innerHTML = `${icon("refresh", 14)}<span>重试</span>`;
		}
		if (card.querySelector(".ask-err") === null) {
			const hint = document.createElement("p");
			hint.className = "ask-err";
			hint.textContent = "没提交成功，再试一次。";
			card.append(hint);
		}
	}
}
