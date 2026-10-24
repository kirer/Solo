/**
 * 角色档案浮层。
 *
 * 聊天头部原来的「全部展开 / 收起」按钮换成了「查看这位职工的角色档案」，
 * 数据来自 GET /api/profile/:conversationId（app.js 通过 fetchProfile 注入，
 * 这里不自己发请求，也不碰外壳 DOM——挂载点 #profile-layer 由 index.html 提供，
 * 没有时自己在 body 末尾补一个，保证这个模块单独也能跑）。
 *
 * 三种降级都必须有字：加载中 / 请求失败 / 没有档案。
 */
import { escapeHtml } from "./format.js";
import { icon } from "./icons.js";

const $ = (id) => document.getElementById(id);

const KIND_LABEL = {
	owner: "老板",
	role: "高管",
	project: "项目负责人",
	staff: "员工",
	system: "系统",
};

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

/**
 * @param {{ fetchProfile?: (conversationId: number) => Promise<any>,
 *           onToggle?: (open: boolean) => void }} options
 * @returns {{ open: (conversationId: number, actor?: any) => void, close: () => void, isOpen: () => boolean }}
 */
export function initProfile({ fetchProfile, onToggle } = {}) {
	const layer = layerNode();
	layer.innerHTML = "";

	const scrim = document.createElement("div");
	scrim.className = "profile-scrim";
	scrim.addEventListener("click", () => close());

	const panel = document.createElement("section");
	panel.className = "profile";
	panel.setAttribute("role", "dialog");
	panel.setAttribute("aria-modal", "true");
	panel.setAttribute("aria-label", "角色档案");
	panel.tabIndex = -1;

	layer.append(scrim, panel);

	let open = false;
	let currentId = null;
	let currentActor = null;
	let token = 0;

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
				<button class="icon-btn profile-close" type="button" data-profile-close aria-label="关闭档案" title="关闭档案">${icon(
					"x",
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
		focusPanel();

		if (typeof fetchProfile !== "function") {
			if (mine !== token) return;
			render(
				actor ?? {},
				failedHtml("档案接口还没接通：等 app.js 把 fetchProfile 传进来。"),
			);
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
	}

	function openProfile(conversationId, actor) {
		if (!open) {
			open = true;
			layer.hidden = false;
			document.body.classList.add("profile-open");
			document.addEventListener("keydown", onKeydown);
			onToggle?.(true);
		}
		void load(conversationId, actor);
	}

	function close() {
		if (!open) return;
		open = false;
		token += 1;
		layer.hidden = true;
		document.body.classList.remove("profile-open");
		document.removeEventListener("keydown", onKeydown);
		panel.innerHTML = "";
		onToggle?.(false);
		$("chat-fold")?.focus({ preventScroll: true });
	}

	return {
		open: openProfile,
		close,
		isOpen: () => open,
	};
}
