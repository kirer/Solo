/**
 * 角色档案：内嵌在对话面板里（#chat-dock），不再是悬浮层。
 *
 * 挂载点由 index.html 提供：`.chat-dock#chat-dock` 紧跟 `.chat-head`，宽度与对话面板
 * 同宽。展开/收起由头部右侧的 #chat-fold 按钮控制，过渡用高度（grid 0fr→1fr）+
 * 透明度，避免整块重绘；移动端 dock 高度受限，内部滚动。
 *
 * 兜底：页面没有 #chat-dock 时（例如模块单独跑），退回旧的悬浮层 #profile-layer，
 * 保证这个模块不依赖外壳 DOM 也能工作——但默认路径永远是内嵌。
 *
 * 两个挂载点（老板 #2）：对话面板里的 #chat-dock，以及频道视图右上角按钮打开的
 * #ch-dock。用 `dock` 参数指定；不传就是 #chat-dock（保持向后兼容）。
 * 同一份渲染逻辑跑两次，互不干扰（各自一份 open/token 状态）。
 *
 * 数据来自 app.js 注入的 fetchProfile（GET /api/profile/:conversationId）。
 * 三种降级都必须有字：加载中 / 请求失败 / 没有档案。
 */
import { escapeHtml } from "./format.js";
import { icon } from "./icons.js";

const $ = (id) => document.getElementById(id);
const DOCK_MS = 210;

const KIND_LABEL = {
	owner: "老板",
	role: "高管",
	project: "项目负责人",
	staff: "员工",
	system: "系统",
};

const text = (value) => String(value ?? "").trim();
const kindLabel = (kind) => KIND_LABEL[text(kind)] ?? "";

function metaRow(key, value, wide = false) {
	const content = text(value);
	if (content === "") return "";
	return `<div class="profile-meta-row${wide ? " profile-meta-row--wide" : ""}"><dt>${escapeHtml(
		key,
	)}</dt><dd>${escapeHtml(content)}</dd></div>`;
}

function sectionHtml(title, bodyHtml, open = false) {
	return `<details class="profile-sec"${open ? " open" : ""}>
		<summary>
			<span class="profile-sec-title">${escapeHtml(title)}</span>
			<span class="profile-chev">${icon("chevronDown", 12)}</span>
		</summary>
		<div class="profile-sec-body">${bodyHtml}</div>
	</details>`;
}

function proseHtml(value, empty) {
	const content = text(value);
	if (content === "") return `<p class="profile-muted">${escapeHtml(empty)}</p>`;
	return `<p class="profile-text">${escapeHtml(content)}</p>`;
}

function toolsHtml(tools) {
	const list = Array.isArray(tools) ? tools : [];
	if (list.length === 0) return '<p class="profile-muted">没有登记技能 / 工具。</p>';
	return `<ul class="profile-tools">${list
		.map((tool) => {
			const name = text(tool?.name) || "未命名工具";
			const description = text(tool?.description);
			return `<li><b>${escapeHtml(name)}</b>${
				description === "" ? "" : `<span>${escapeHtml(description)}</span>`
			}</li>`;
		})
		.join("")}</ul>`;
}

function loadedHtml(profile) {
	// 模型是长串，单独占一整行；其它两列铺开，奇数个时最后一行也占满，
	// 避免网格右下角留一个空格子。
	const rows = [
		["角色", profile?.role, false],
		["身份", kindLabel(profile?.kind), false],
		["项目", profile?.project, false],
		["上级", profile?.parent, false],
		["模型", profile?.model, true],
	].filter(([, value]) => text(value) !== "");
	if (rows.length > 0 && rows.length % 2 === 1 && rows[rows.length - 1][2] !== true) {
		rows[rows.length - 1][2] = true;
	}
	const meta = rows.map(([key, value, wide]) => metaRow(key, value, wide)).join("");

	return `${
		meta === "" ? "" : `<dl class="profile-meta">${meta}</dl>`
	}${sectionHtml("角色预制提示词", proseHtml(profile?.charter, "这位职工没有单独的预制提示词。"), true)}${sectionHtml(
		"通用准则",
		proseHtml(profile?.guide, "没有登记通用准则。"),
	)}${sectionHtml("技能 / 工具", toolsHtml(profile?.tools))}`;
}

function loadingHtml() {
	return `<div class="profile-state" role="status" aria-live="polite">
		<div class="profile-state-head"><span class="chat-spinner" aria-hidden="true"></span><b>正在读取角色档案…</b></div>
		<p>角色预制提示词、准则和工具清单马上就到。</p>
	</div>`;
}

function failedHtml(reason) {
	return `<div class="profile-state" role="alert">
		<b>档案没读到</b>
		<p>${escapeHtml(reason)}</p>
		<button class="profile-retry" type="button" data-profile-retry>重试</button>
	</div>`;
}

function emptyHtml(detail) {
	return `<div class="profile-state" role="status">
		<b>暂无档案</b>
		<p>${escapeHtml(detail)}</p>
	</div>`;
}

/** 悬浮层兜底（只在页面没有 #chat-dock 时使用）。 */
function layerNode() {
	const existing = $("profile-layer");
	if (existing !== null) return existing;
	const layer = document.createElement("div");
	layer.id = "profile-layer";
	layer.className = "profile-layer";
	layer.hidden = true;
	document.body.append(layer);
	return layer;
}

/**
 * @param {{ fetchProfile?: (conversationId: number) => Promise<any>,
 *           onToggle?: (open: boolean) => void,
 *           dock?: HTMLElement | null,
 *           trigger?: HTMLElement | null }} options
 *   `dock`：挂载点，默认 `#chat-dock`。
 *   `trigger`：收起时把焦点还回去的按钮，默认 `#chat-fold`。
 * @returns {{ open: (conversationId: number, actor?: any) => void, close: () => void, isOpen: () => boolean }}
 */
export function initProfile({ fetchProfile, onToggle, dock: dockEl, trigger } = {}) {
	const dock = dockEl ?? $("chat-dock");
	const inline = dock !== null && dock !== undefined;
	const focusBack = trigger ?? $("chat-fold");

	let root;
	let clip;
	let panel;
	let scrim = null;
	let layer = null;

	if (inline) {
		// 内嵌：chat 面板里的 #chat-dock 由 index.html 提供，这里只往里写内容。
		dock.innerHTML = "";
		dock.hidden = true;
		dock.dataset.open = "false";
		dock.setAttribute("aria-hidden", "true");
		root = dock;
	} else {
		layer = layerNode();
		layer.innerHTML = "";
		scrim = document.createElement("div");
		scrim.className = "profile-scrim";
		scrim.addEventListener("click", () => close());
		root = document.createElement("section");
		root.className = "profile";
		root.setAttribute("role", "dialog");
		root.setAttribute("aria-modal", "true");
		root.setAttribute("aria-label", "角色档案");
		root.tabIndex = -1;
		layer.append(scrim, root);
	}

	clip = document.createElement("div");
	clip.className = "chat-dock-clip";
	panel = document.createElement("section");
	panel.className = `chat-dock-panel${inline ? "" : " profile"}`;
	panel.setAttribute("role", inline ? "region" : "dialog");
	panel.setAttribute("aria-label", "角色档案");
	if (!inline) panel.setAttribute("aria-modal", "true");
	clip.append(panel);
	root.append(clip);

	let open = false;
	let currentId = null;
	let currentActor = null;
	let token = 0;
	let hideTimer = 0;

	function onKeydown(event) {
		if (event.key !== "Escape" || !open) return;
		event.preventDefault();
		close();
	}

	function shellHtml(header, bodyHtml) {
		const label = text(header?.label) || "职工";
		const subtitle = text(header?.subtitle);
		const kind = kindLabel(header?.kind);
		const meta = [kind, subtitle].filter((part) => part !== "").join(" · ");
		return `<header class="profile-head">
				<div class="profile-ident">
					<b class="profile-name">${escapeHtml(label)}</b>
					<span class="profile-sub">${escapeHtml(meta === "" ? "角色档案" : meta)}</span>
				</div>
				<button class="icon-btn profile-close" type="button" data-profile-close aria-label="收起档案" title="收起档案">${icon(
					"chevronUp",
					15,
				)}</button>
			</header>
			<div class="profile-body">${bodyHtml}</div>`;
	}

	function render(header, bodyHtml) {
		panel.innerHTML = shellHtml(header, bodyHtml);
		panel.querySelector("[data-profile-close]")?.addEventListener("click", () => close());
		panel.querySelector("[data-profile-retry]")?.addEventListener("click", () => {
			void load(currentId, currentActor);
		});
	}

	function focusPanel() {
		const closeButton = panel.querySelector("[data-profile-close]");
		if (closeButton instanceof HTMLElement) closeButton.focus({ preventScroll: true });
		else panel.focus({ preventScroll: true });
	}

	async function load(conversationId, actor) {
		const id = Number(conversationId);
		if (!Number.isFinite(id)) return;
		currentId = id;
		currentActor = actor ?? null;
		const mine = (token += 1);

		render(actor ?? { label: "职工", subtitle: "角色档案" }, loadingHtml());

		if (typeof fetchProfile !== "function") {
			if (mine !== token) return;
			render(actor ?? {}, failedHtml("档案接口还没接通：等 app.js 把 fetchProfile 传进来。"));
			return;
		}

		let data;
		try {
			data = await fetchProfile(id);
		} catch {
			if (mine !== token) return;
			render(actor ?? {}, failedHtml("请求出错了，可能服务刚重启，稍后再试。"));
			return;
		}
		if (mine !== token || !open) return;

		if (data === null || data === undefined) {
			render(actor ?? {}, emptyHtml("这位职工还没登记角色信息，或者档案接口返回了 404。"));
			return;
		}
		if (typeof data !== "object") {
			render(actor ?? {}, emptyHtml("档案数据格式不对，暂时显示不了。"));
			return;
		}

		const header = {
			label: text(data.label) || text(actor?.label) || "职工",
			subtitle: text(data.subtitle) || text(actor?.subtitle),
			kind: text(data.kind) || text(actor?.kind),
		};
		render(header, loadedHtml(data));
		// 内容在打开期间才到齐：高度会变，浏览器自己会跑 grid 过渡。
	}

	function clearHideTimer() {
		if (hideTimer !== 0) {
			window.clearTimeout(hideTimer);
			hideTimer = 0;
		}
	}

	function openProfile(conversationId, actor) {
		clearHideTimer();
		if (!open) {
			open = true;
			root.hidden = false;
			root.setAttribute("aria-hidden", inline ? "false" : "true");
			if (!inline && layer !== null) layer.hidden = false;
			document.body.classList.add("profile-open");
			document.addEventListener("keydown", onKeydown);
			onToggle?.(true);
			// 先上屏再加 data-open，否则浏览器拿不到 0fr 的起始状态。
			window.requestAnimationFrame(() => {
				root.dataset.open = "true";
			});
		}
		void load(conversationId, actor);
	}

	function finishClose() {
		root.dataset.open = "false";
		root.setAttribute("aria-hidden", "true");
		if (inline) root.hidden = true;
		else if (layer !== null) layer.hidden = true;
	}

	function close() {
		if (!open) return;
		open = false;
		token += 1;
		document.body.classList.remove("profile-open");
		root.dataset.open = "false";
		document.removeEventListener("keydown", onKeydown);
		if (inline) {
			// 收起动画结束后再 hidden：直接 hidden 会把高度过渡吞掉。
			clearHideTimer();
			hideTimer = window.setTimeout(finishClose, DOCK_MS);
		} else {
			finishClose();
		}
		onToggle?.(false);
		focusBack?.focus?.({ preventScroll: true });
	}

	return {
		open: openProfile,
		close,
		isOpen: () => open,
	};
}
