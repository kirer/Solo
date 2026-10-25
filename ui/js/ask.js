/**
 * 待你拍板的卡片 + 选项框解析。
 *
 * 只在组织快照里 forYou 的条目上出现；提交走 /api/answer（由 app.js 注入）。
 * 不在每次 SSE 推送时重建：签名没变就直接返回，避免打字被打断。
 *
 * 选项来源（按优先级）：
 * 1. `item.disposition.options`：后端处置待办的结构化选项（id/label/recommended）；
 * 2. `item.options`：将来普通待决项也可能直接带结构化选项；
 * 3. 从 `item.question` 的正文里解析编号/带圈编号列表（`选项：① 暂搁 ② 放弃`）——
 *    兼容还没有把 options 透出到 org 快照的后端。
 * 最后一项永远是「自定义输入」：点它把焦点放回输入框，不做任何自动提交。
 *
 * 这里同时导出纯函数给 chat.js 用：assistant 回复里「确实在问你选一个」的编号列表
 * 也渲染成同一套选项卡片，两条路径共用一份解析与视觉。
 */
import { escapeHtml, relTime } from "./format.js";
import { icon } from "./icons.js";

const $ = (id) => document.getElementById(id);
const MAX_OPTIONS = 9;

/* ── 纯函数：选项解析 ───────────────────────────────────────────────────── */

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩";
const OPTION_LINE = /^\s*(?:([①-⑩])|(\d{1,2})\s*[.、)）]|[-*]\s+)(?:\s*)(.+?)\s*$/;

/** 一行是不是选项行（带圈编号 / 阿拉伯数字 / 短横线列表）。 */
function optionOf(line) {
	const match = OPTION_LINE.exec(line);
	if (match === null) return null;
	const label = String(match[3] ?? "").trim();
	if (label === "") return null;
	return { label };
}

/** 从一段文字末尾解析出连续编号选项块。 */
function trailingOptions(raw) {
	const lines = String(raw ?? "").split("\n");
	const picked = [];
	let index = lines.length - 1;
	while (index >= 0) {
		const line = lines[index];
		if (line.trim() === "") {
			// 允许选项块与正文之间正好一个空行；再往前就是正文了
			if (picked.length === 0) {
				index -= 1;
				continue;
			}
			break;
		}
		const option = optionOf(line);
		if (option === null) break;
		picked.unshift(option);
		index -= 1;
	}
	if (picked.length < 2 || picked.length > MAX_OPTIONS) return null;
	return { options: picked, startLine: index + 1 };
}

/**
 * 从一行里解析带圈编号选项（处置问题的正文格式常是一行两项）。
 *
 * 「选项：① 暂搁（推荐）② 永久放弃」——trailingOptions 只认独立成行的列表，
 * 这里补一条：一行里出现 ≥2 个 ①-⑩ 时按它们切分。
 */
function circledOptionsIn(text) {
	const lines = String(text ?? "").split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line === undefined || !/[①-⑩]/.test(line)) continue;
		const marks = [...line.matchAll(/[①-⑩]\s*([^①-⑩]+)/g)]
			.map((match) => String(match[1] ?? "").trim())
			.filter((label) => label !== "");
		if (marks.length < 2 || marks.length > MAX_OPTIONS) continue;
		return { options: marks.map((label) => ({ label })), startLine: index, endLine: index + 1 };
	}
	return null;
}

/**
 * 正文里有没有「让人选一个」的信号。
 *
 * 刻意保守：计划清单 / 步骤列表 / 普通编号要点都不能长成可点的选项——
 * 点一下就会把「1. 读文件」当成回答发给模型。只有明确的选择语义才放行。
 */
function looksLikeChoice(intro, options) {
	const body = String(intro ?? "").trimEnd();
	if (body === "") return false;
	const lines = body.split("\n");
	const lastLine = String(lines[lines.length - 1] ?? "").trim();
	const tail = body.slice(-320);

	// 正文最后一句话本身是个问题（问号收尾；内联选项时问题可能在倒数第二行）
	const lastTwo = lines.slice(-2).map((line) => line.trim());
	if (lastTwo.some((line) => /[?？]["'”』」)）]?$/.test(line)) || /[?？]["'”』」)）]?$/.test(body.trim())) {
		return true;
	}
	// 明确的「选一个」语义
	if (/(选一个|挑一个|选择一个|选哪|挑哪|哪个|哪一个|哪一项|哪一种|选择一项)/.test(tail)) return true;
	if (/(要不要|还是|二选一|三选一)/.test(tail)) return true;
	// 第二人称 + 选择动词：例如「你选一个」「请挑一个」「需要你确认」
	if (/(请|麻烦|需要|你|您)[^。！\n]{0,16}(选|挑|决定|确认|回复|回答|处置|怎么办|怎么处理|如何处理)/.test(tail)) {
		return true;
	}
	// 真正在问选择时，列表通常很短；没有任何选择信号的长列表一律不当选项
	void options;
	return false;
}

/**
 * 从 assistant 回复里切出「正文 + 选项」。
 *
 * @returns {{ body: string, options: { label: string }[] } | null}
 */
export function splitOptionsFromText(raw) {
	const text = String(raw ?? "");
	const lines = text.split("\n");
	const trailing = trailingOptions(text);
	const parsed = trailing ?? circledOptionsIn(text);
	if (parsed === null) return null;
	// 选项块之前的正文：用来判断是不是真的在问选择
	const intro = (trailing === null
		? [...lines.slice(0, parsed.startLine), lines.slice(parsed.endLine).join("\n")].join("\n")
		: lines.slice(0, parsed.startLine).join("\n")
	).trimEnd();
	const optionLine = lines.slice(parsed.startLine, parsed.endLine).join("\n");
	if (!looksLikeChoice(`${intro}\n${optionLine}`, parsed.options)) return null;
	const optionLabels = parsed.options.map((option) => option.label);
	if (optionLabels.some((label) => label === "")) return null;
	return { body: intro, options: parsed.options };
}

/** 待决项的结构化选项（可能没有）。 */
export function optionsFromItem(item) {
	const list = Array.isArray(item?.disposition?.options)
		? item.disposition.options
		: Array.isArray(item?.options)
			? item.options
			: null;
	if (list !== null && list.length > 0) {
		return list.slice(0, MAX_OPTIONS).map((option) => ({
			label: String(option?.label ?? option?.id ?? "").trim(),
			recommended: option?.recommended === true,
		}));
	}
	const question = String(item?.question ?? "");
	const parsed = trailingOptions(question) ?? circledOptionsIn(question);
	if (parsed === null) return [];
	return parsed.options.map((option) => ({ label: option.label, recommended: false }));
}

/** 一条待决项是不是「需要选一个」的处置类问题。 */
function isDispositionLike(item) {
	if (item?.disposition !== undefined) return true;
	return /被打断的工作|暂搁|永久放弃/.test(String(item?.question ?? ""));
}

/* ── 卡片渲染 ───────────────────────────────────────────────────────────── */

let onSubmit;
let signature = "";
let bound = false;
let areaNode = null;

export function initAsk({ onAnswer }) {
	onSubmit = onAnswer;
	const area = $("ask-area");
	areaNode = area;

	if (!bound) {
		bound = true;
		area.addEventListener("submit", (event) => {
			const form = event.target.closest(".ask-reply");
			if (form === null) return;
			event.preventDefault();
			void submit(form);
		});
		area.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				const textarea = event.target.closest("textarea");
				if (textarea === null) return;
				event.preventDefault();
				void submit(textarea.closest(".ask-reply"));
				return;
			}
			// 1-9：在选项卡片上直接选（焦点不在输入框时）
			if (/^[1-9]$/.test(event.key) && !isEditable(event.target)) {
				if (activateOption(area, Number(event.key) - 1)) event.preventDefault();
			}
		});
		area.addEventListener("input", (event) => {
			const textarea = event.target.closest("textarea");
			if (textarea === null) return;
			textarea.style.height = "auto";
			textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
		});
		area.addEventListener("click", (event) => {
			const button = event.target.closest("[data-ask-option]");
			if (button === null) return;
			const card = button.closest(".ask");
			if (card === null) return;
			if (button.dataset.askOption === "custom") {
				card.querySelector("textarea")?.focus();
				return;
			}
			void pick(card, button.dataset.label ?? "");
		});
	}

	return { render };
}

function isEditable(target) {
	return (
		target instanceof HTMLElement &&
		(target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)
	);
}

/** 数字键选择：只作用于第一张有待选项的卡片。 */
function activateOption(scope, index) {
	const card = scope.querySelector(".ask-options")?.closest(".ask");
	const button = card?.querySelector(`.ask-opt:not(.ask-opt--custom)[data-ask-option="${index}"]`);
	if (button === undefined || button === null) return false;
	button.click();
	return true;
}

function render(items) {
	const area = areaNode ?? $("ask-area");
	const list = Array.isArray(items) ? items : [];
	const next = list
		.map((item) => `${item.key}:${item.askedAt}:${item.question.length}:${(optionsFromItem(item) ?? []).length}`)
		.join("|");
	if (next === signature) return;
	signature = next;

	if (list.length === 0) {
		area.innerHTML = "";
		return;
	}

	area.innerHTML = list
		.map((item, index) => {
			const options = optionsFromItem(item);
			const disposition = isDispositionLike(item);
			return `
		<article class="ask" data-key="${escapeHtml(item.key)}" data-kind="${disposition ? "disposition" : "pending"}" style="--i:${index}">
			<div class="ask-top">
				<span class="ask-kicker"><i></i>${disposition ? "等你处置" : "需要你拍板"}</span>
				<span class="ask-from">来自 ${escapeHtml(item.from)}</span>
				<span class="ask-time">${escapeHtml(relTime(item.askedAt))}</span>
			</div>
			<div class="ask-q">${questionHtml(item.question)}</div>
			${
				options.length > 0
					? optionCardsHtml(options, disposition)
					: ""
			}
			<form class="ask-reply">
				<label class="sr-only" for="answer-${escapeHtml(item.key)}">你的决定</label>
				<textarea id="answer-${escapeHtml(item.key)}" rows="1" placeholder="${
					options.length > 0 ? "也可以直接写你的决定…" : "给出你的决定…"
				}"></textarea>
				<button class="ask-send" type="submit">${icon("send", 14)}<span>发送</span></button>
			</form>
		</article>`;
		})
		.join("");
}

/**
 * 选项卡片：单选，最后一项固定「自定义输入」。
 *
 * 处置类的「暂搁」需要恢复条件（后端硬要求），所以点它不直接提交，
 * 而是把「暂搁：」填进输入框并聚焦，让人补一句条件再发。
 */
function optionCardsHtml(options, disposition) {
	const cards = options
		.map((option, index) => {
			const label = option.label;
			const needsCondition = disposition && /暂搁|暂停|shelve/i.test(label);
			const hint = option.recommended
				? "推荐"
				: needsCondition
					? "需写恢复条件"
					: "";
			return `<button class="ask-opt" type="button" role="radio" aria-checked="false" data-ask-option="${index}" data-label="${escapeHtml(
				label,
			)}">
				<span class="ask-opt-key mono">${index + 1}</span>
				<span class="ask-opt-label">${escapeHtml(label)}</span>
				${hint === "" ? "" : `<span class="ask-opt-hint">${hint}</span>`}
			</button>`;
		})
		.join("");
	const customIndex = options.length;
	return `<div class="ask-options" role="radiogroup" aria-label="选项">
			${cards}
			<button class="ask-opt ask-opt--custom" type="button" data-ask-option="custom">
				<span class="ask-opt-key mono">${customIndex + 1}</span>
				<span class="ask-opt-label">自定义输入</span>
				<span class="ask-opt-hint">${icon("edit", 12)}</span>
			</button>
		</div>
		<p class="ask-options-hint">按 <kbd>1</kbd>–<kbd>9</kbd> 快速选择</p>`;
}

/** 处置类的「暂搁」：填进输入框，等恢复条件。 */
function prefillCondition(card, label) {
	const textarea = card.querySelector("textarea");
	if (textarea === null) return;
	textarea.value = `${label.replace(/（.*?）/g, "").trim()}：`;
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
	textarea.focus();
}

async function pick(card, label) {
	const picked = String(label ?? "").trim();
	if (picked === "") return;
	const disposition = card.dataset.kind === "disposition";
	if (disposition && /暂搁|暂停|shelve/i.test(picked)) {
		prefillCondition(card, picked);
		return;
	}
	const textarea = card.querySelector("textarea");
	if (textarea !== null) textarea.value = picked;
	await submit(card.querySelector(".ask-reply"));
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
		// 选过的选项给一个短暂回执，再收起卡片
		const picked = card.querySelector(`[data-ask-option][data-label="${cssEscape(text)}"]`);
		picked?.classList.add("is-picked");
		picked?.setAttribute("aria-checked", "true");
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

function cssEscape(value) {
	if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
	return String(value).replace(/["\\]/g, "\\$&");
}
