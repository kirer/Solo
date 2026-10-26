/**
 * 一人公司 · 设置面板内容。
 *
 * 负责三块：#settings-models（模型目录）、#settings-im（IM 接入）、
 * #settings-network（端口 / 局域网地址）。外壳（浮层开关、主题）归 app.js。
 *
 * 数据：GET /api/settings
 * 写入：PATCH /api/settings、POST /api/models、DELETE /api/models?id=
 * 约定：PATCH / POST / DELETE 都返回最新设置，避免写完再读一次。
 *
 * 模型的增删改在服务启动时载入，无法热生效：接口返回 restartRequired 时
 * 这里只提示「需重启服务生效」，不假装热更新。
 */
import { escapeAttr, escapeHtml } from "./format.js";

const CHANNELS = [
	{ value: "wechat", label: "微信" },
	{ value: "wecom", label: "企业微信" },
	{ value: "feishu", label: "飞书" },
	{ value: "qq", label: "QQ" },
	{ value: "telegram", label: "Telegram" },
	{ value: "discord", label: "Discord" },
	{ value: "slack", label: "Slack" },
	{ value: "webhook", label: "自定义 Webhook" },
];

const PROVIDERS = [
	{ value: "openai-responses", label: "OpenAI Responses" },
	{ value: "anthropic", label: "Anthropic" },
	{ value: "openai", label: "OpenAI Chat Completions" },
];

const state = {
	data: null,
	loading: false,
	error: "",
	/** 模型「添加」表单是否展开，以及失败后要保留的草稿 / 字段错误。 */
	modelForm: false,
	/** 编辑中的模型原 id（空串 = 新增）。内置项也可以编辑：落成一条覆盖项。 */
	modelEditing: "",
	modelDraft: null,
	modelErrors: null,
	confirmDelete: "",
	/** IM 草稿：改完点保存才 PATCH，避免每敲一个字符就写盘。 */
	imDraft: null,
	imDirty: false,
	accountDraft: null,
	accountErrors: null,
	confirmAccountDelete: "",
};

let notify = () => {};
let panel = null;
const containers = { models: null, im: null, network: null };

/* ── API ─────────────────────────────────────────────────────────────────── */

async function requestJson(path, options = {}) {
	let response;
	try {
		response = await fetch(path, options);
	} catch {
		throw new Error("连接不上服务，检查 ai-company 是否还在运行。");
	}
	let body = null;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	if (!response.ok) {
		const raw = body?.error ?? body?.message ?? "";
		const message = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : "";
		throw new Error(message !== "" ? message : `接口返回 ${response.status}，请稍后重试。`);
	}
	if (body === null) {
		if (response.status === 204) return null;
		// 服务端未实现该接口时，静态兜底会把 index.html 用 200 返回：
		// 这里必须点破，不能让界面显示成「还没有配置模型」。
		const type = response.headers.get("content-type") ?? "";
		if (!type.includes("application/json")) {
			throw new Error(`接口 ${path} 还不存在（返回了网页而不是 JSON）。服务端就绪后重试。`);
		}
		throw new Error(`接口 ${path} 返回了空内容。`);
	}
	if (typeof body === "object" && body.error !== undefined && body.error !== null) {
		throw new Error(String(body.error));
	}
	return body;
}

function jsonBody(value) {
	return {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(value),
	};
}

function normalizeSettings(raw) {
	const models = raw?.models ?? {};
	const im = raw?.im ?? {};
	const network = raw?.network ?? {};
	const catalog = Array.isArray(models.catalog) ? models.catalog : [];
	const lanUrls = Array.isArray(network.lanUrls) ? network.lanUrls : [];
	return {
		network: {
			port: Number.isFinite(Number(network.port)) ? Number(network.port) : 0,
			host: typeof network.host === "string" ? network.host : "",
			url: typeof network.url === "string" ? network.url : "",
			lanUrls: lanUrls
				.map((item) => (typeof item === "string" ? item : String(item?.url ?? "")))
				.filter((item) => item !== ""),
		},
		models: {
			default: typeof models.default === "string" ? models.default : "",
			restartRequired: Boolean(models.restartRequired),
			catalog: catalog
				.filter((model) => model !== null && typeof model === "object" && typeof model.id === "string")
				.map((model) => ({
					id: model.id,
					name: typeof model.name === "string" && model.name !== "" ? model.name : model.id,
					provider: typeof model.provider === "string" ? model.provider : "",
					baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : "",
					inputPerMTok: toNumber(model.inputPerMTok),
					outputPerMTok: toNumber(model.outputPerMTok),
					contextWindow: toNumber(model.contextWindow),
					maxOutput: toNumber(model.maxOutput),
					source: model.source === "custom" ? "custom" : "builtin",
					builtin: typeof model.builtin === "string" ? model.builtin : "",
					overridden: model.overridden === true,
				})),
		},
		im: {
			enabled: Boolean(im.enabled),
			outboundWebhook: typeof im.outboundWebhook === "string" ? im.outboundWebhook : "",
			inboundToken: typeof im.inboundToken === "string" ? im.inboundToken : "",
			accounts: (Array.isArray(im.accounts) ? im.accounts : [])
				.filter((account) => account !== null && typeof account === "object")
				.map((account, index) => ({
					id:
						typeof account.id === "string" && account.id !== ""
							? account.id
							: `acct_${index + 1}`,
					channel: typeof account.channel === "string" ? account.channel : "webhook",
					name: typeof account.name === "string" ? account.name : "",
					enabled: account.enabled !== false,
					note: typeof account.note === "string" ? account.note : "",
				})),
		},
	};
}

function toNumber(value) {
	if (value === null || value === undefined || value === "") return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function cloneAccounts(accounts) {
	return accounts.map((account) => ({ ...account }));
}

/* ── 格式化 ──────────────────────────────────────────────────────────────── */

function providerLabel(provider) {
	return PROVIDERS.find((item) => item.value === provider)?.label ?? provider ?? "";
}

function channelLabel(channel) {
	return CHANNELS.find((item) => item.value === channel)?.label ?? channel ?? "未知渠道";
}

function compactNumber(value) {
	if (value === null || value === undefined) return "";
	if (value >= 1_000_000) {
		const millions = value / 1_000_000;
		return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
	}
	if (value >= 1_000) {
		const thousands = value / 1_000;
		return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(0)}K`;
	}
	return String(value);
}

function priceLabel(value) {
	if (value === null || value === undefined) return "";
	const fixed = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
	return `$${fixed}/M`;
}

function modelMeta(model) {
	const parts = [];
	if (model.provider !== "") parts.push(providerLabel(model.provider));
	const input = priceLabel(model.inputPerMTok);
	const output = priceLabel(model.outputPerMTok);
	if (input !== "" || output !== "") {
		parts.push(`输入 ${input === "" ? "—" : input} · 输出 ${output === "" ? "—" : output}`);
	} else {
		parts.push("未配置价格");
	}
	if (model.contextWindow !== null) parts.push(`${compactNumber(model.contextWindow)} ctx`);
	if (model.maxOutput !== null) parts.push(`最多 ${compactNumber(model.maxOutput)} tok`);
	return parts.join(" · ");
}

/** 默认值可能是 "provider/modelId"（后端原样），按几种形态对齐到 catalog.id。 */
function resolveDefaultId(models) {
	const raw = String(models?.default ?? "").trim();
	if (raw === "") return "";
	const catalog = models?.catalog ?? [];
	const exact = catalog.find((model) => model.id === raw);
	if (exact !== undefined) return exact.id;
	const withProvider = catalog.find((model) => `${model.provider}/${model.id}` === raw);
	if (withProvider !== undefined) return withProvider.id;
	const tail = raw.slice(raw.lastIndexOf("/") + 1);
	const byTail = catalog.find((model) => model.id === tail);
	return byTail?.id ?? raw;
}

function inboundUrl() {
	const network = state.data?.network;
	const lanUrl = network?.lanUrls?.[0] ?? "";
	const base = (lanUrl || network?.url || location.origin).replace(/\/+$/, "");
	const token = state.imDraft?.inboundToken?.trim() ?? "";
	return `${base}/api/im/inbound?token=${encodeURIComponent(token)}`;
}

/* ── 渲染：通用 ──────────────────────────────────────────────────────────── */

/** 三块共用一份读取结果：错误只在模型区给完整提示 + 重试，其余两块给一行指路。 */
function errorBlock({ compact = false } = {}) {
	if (compact) {
		return '<p class="set-hint set-hint--warn">设置没读到，重试入口在上方「模型」区。</p>';
	}
	return `<div class="set-error" role="alert">
		<p>读取设置失败：${escapeHtml(state.error)}</p>
		<button class="set-btn" type="button" data-action="retry">重试</button>
	</div>`;
}

function loadingHint() {
	return `<p class="set-hint">${state.loading ? "正在读取设置…" : "还没有读到设置。"}</p>`;
}

function inputField(name, label, options = {}) {
	const {
		value = "",
		placeholder = "",
		type = "text",
		required = false,
		wide = false,
		error = "",
		hint = "",
		step = "",
		min = "",
		max = "",
	} = options;
	const attrs = [
		`class="set-input${type === "number" ? " tnum" : ""}"`,
		`name="${escapeAttr(name)}"`,
		`type="${escapeAttr(type)}"`,
		`value="${escapeAttr(value)}"`,
		`placeholder="${escapeAttr(placeholder)}"`,
		'autocomplete="off"',
		'spellcheck="false"',
	];
	if (type === "number") {
		attrs.push('inputmode="decimal"');
		if (step !== "") attrs.push(`step="${escapeAttr(step)}"`);
		if (min !== "") attrs.push(`min="${escapeAttr(min)}"`);
		if (max !== "") attrs.push(`max="${escapeAttr(max)}"`);
	}
	if (required) attrs.push('aria-required="true"');
	if (error !== "") attrs.push('aria-invalid="true"');
	return `<label class="set-field${wide ? " set-field--wide" : ""}">
		<span class="set-field-label">${escapeHtml(label)}${required ? '<i class="set-req" aria-hidden="true">*</i>' : ""}</span>
		<input ${attrs.join(" ")}>
		${hint !== "" ? `<span class="set-hint">${escapeHtml(hint)}</span>` : ""}
		${error !== "" ? `<span class="set-field-error">${escapeHtml(error)}</span>` : ""}
	</label>`;
}

function selectField(name, label, options, settings = {}) {
	const { value = "", wide = false, error = "", hint = "" } = settings;
	const body = options
		.map(
			(option) =>
				`<option value="${escapeAttr(option.value)}"${option.value === value ? " selected" : ""}>${escapeHtml(option.label)}</option>`,
		)
		.join("");
	return `<label class="set-field${wide ? " set-field--wide" : ""}">
		<span class="set-field-label">${escapeHtml(label)}</span>
		<select class="set-select" name="${escapeAttr(name)}"${error !== "" ? ' aria-invalid="true"' : ""}>${body}</select>
		${hint !== "" ? `<span class="set-hint">${escapeHtml(hint)}</span>` : ""}
		${error !== "" ? `<span class="set-field-error">${escapeHtml(error)}</span>` : ""}
	</label>`;
}

function copyButton(value, label) {
	return `<button class="set-btn" type="button" data-copy="${escapeAttr(value)}" data-copy-label="${escapeAttr(label)}">复制</button>`;
}

function copyRow(value, label) {
	return `<li class="set-copy-row">
		<span class="set-copy-label">${escapeHtml(label)}</span>
		<div class="set-copy">
			<code class="set-copy-text mono">${escapeHtml(value)}</code>
			${copyButton(value, label)}
		</div>
	</li>`;
}

/* ── 渲染：模型 ──────────────────────────────────────────────────────────── */

function renderModels() {
	if (containers.models === null) return;
	containers.models.innerHTML = modelsHtml();
}

function modelsHtml() {
	const parts = [];
	if (state.error !== "") parts.push(errorBlock());
	if (state.data === null) {
		if (state.error === "") parts.push(loadingHint());
		return parts.join("");
	}
	const models = state.data.models;
	const defaultId = resolveDefaultId(models);
	const missingDefault =
		models.default !== "" && !models.catalog.some((model) => model.id === defaultId);
	const notes = [];
	if (models.restartRequired && state.error === "") {
		notes.push(`<div class="set-note set-note--warn" role="status">
			<b>需重启服务生效</b>
			<span>模型目录在服务启动时载入，保存后重启 ai-company 才会生效。</span>
		</div>`);
	}
	if (models.default !== "" && missingDefault) {
		// 删掉当前默认模型后后端不会自动改默认值：这里必须说破，否则用户以为「没默认模型」。
		notes.push(`<div class="set-note set-note--warn" role="alert">
			<b>默认模型已失效</b>
			<span>配置里仍是 <code class="mono">${escapeHtml(models.default)}</code>，但它已不在清单中；请重新指定一个默认模型。</span>
		</div>`);
	}
	const restart = notes.join("");
	const rows =
		models.catalog.length === 0
			? `<li class="set-empty">还没有配置模型。</li>`
			: models.catalog.map((model) => modelRow(model, defaultId)).join("");
	parts.push(`<div class="set-stack">
		${restart}
		<ul class="set-list" aria-label="模型清单">${rows}</ul>
		${state.modelForm ? modelFormHtml() : '<button class="set-add" type="button" data-action="model-form-open">＋ 添加模型</button>'}
	</div>`);
	return parts.join("");
}

function modelRow(model, defaultId) {
	const isDefault = model.id === defaultId;
	const custom = model.source === "custom";
	const deleting = state.confirmDelete === model.id;
	const editing = state.modelEditing !== "" && state.modelEditing === model.id;
	const actions = [];
	if (!isDefault) {
		actions.push(
			`<button class="set-btn" type="button" data-action="default-model" data-id="${escapeAttr(model.id)}">设为默认</button>`,
		);
	}
	// 内置和自定义都能改：内置项的改动落成一条覆盖项（重启后生效），
	// 所以「编辑」按钮对所有行都出现，不再是自定义项的专利。
	actions.push(
		editing
			? `<button class="set-btn" type="button" data-action="cancel-edit-model">取消</button>`
			: `<button class="set-btn" type="button" data-action="edit-model" data-id="${escapeAttr(model.id)}">编辑</button>`,
	);
	actions.push(
		deleting
			? `<button class="set-btn set-btn--danger" type="button" data-action="delete-model" data-id="${escapeAttr(model.id)}" data-confirm="1">确认删除</button>
					<button class="set-btn" type="button" data-action="cancel-delete">取消</button>`
			: `<button class="set-btn set-btn--danger" type="button" data-action="delete-model" data-id="${escapeAttr(model.id)}">删除</button>`,
	);
	return `<li class="set-item${isDefault ? " is-default" : ""}${editing ? " is-editing" : ""}">
		<div class="set-item-body">
			<div class="set-item-line">
				<b class="set-item-name">${escapeHtml(model.name)}</b>
				<span class="set-tag">${custom ? "自定义" : "内置"}</span>
				${model.overridden === true ? '<span class="set-tag set-tag--edited">已改</span>' : ""}
				${isDefault ? '<span class="set-tag set-tag--default">默认</span>' : ""}
			</div>
			<div class="set-item-id mono" title="${escapeAttr(model.id)}">${escapeHtml(model.id)}</div>
			<div class="set-item-meta">${escapeHtml(modelMeta(model))}</div>
			${model.baseUrl !== "" ? `<div class="set-item-meta set-item-url mono">${escapeHtml(model.baseUrl)}</div>` : ""}
		</div>
		${actions.length === 0 ? "" : `<div class="set-item-actions">${actions.join("")}</div>`}
	</li>`;
}

function modelFormHtml() {
	const draft = state.modelDraft ?? { provider: "openai-responses" };
	const errors = state.modelErrors ?? {};
	const editing = state.modelEditing !== "" ? state.modelEditing : "";
	// 内置项是代码常量：编辑它不修改常量，而是写一条覆盖项（重启后生效）。
	// 这里必须说破，否则老板会以为「改了源码」。
	const target = editing === "" ? null : (state.data?.models?.catalog ?? []).find((item) => item.id === editing);
	const isBuiltin = target !== undefined && target.source === "builtin";
	return `<form class="set-form" id="model-form" novalidate data-editing="${escapeAttr(editing)}">
		<div class="set-form-head">
			<b>${editing === "" ? "添加模型" : `编辑 ${escapeHtml(target?.name ?? editing)}`}</b>
			<span class="set-hint">${isBuiltin ? "内置模型：改动会存为覆盖项，重启后生效" : "写入服务端配置，重启后生效"}</span>
		</div>
		${errors.form ? `<p class="set-field-error" role="alert">${escapeHtml(errors.form)}</p>` : ""}
		<div class="set-form-grid">
			${inputField("id", "模型 ID", {
				value: draft.id,
				required: true,
				wide: true,
				placeholder: "例如 openai/gpt-4.1 或 claude-sonnet-4-5",
				error: errors.id,
				hint: "必须和模型服务商侧一致；同 ID 不能重复。",
			})}
			${inputField("name", "显示名", {
				value: draft.name,
				wide: true,
				placeholder: "例如 GPT-4.1",
				error: errors.name,
			})}
			${selectField("provider", "Provider", PROVIDERS, {
				value: draft.provider ?? "openai-responses",
				error: errors.provider,
			})}
			${inputField("baseUrl", "Base URL", {
				value: draft.baseUrl,
				placeholder: "https://...（可选）",
				error: errors.baseUrl,
			})}
			${inputField("apiKey", "API Key", {
				value: draft.apiKey,
				type: "password",
				wide: true,
				placeholder: "留空则沿用环境变量 / 默认凭据",
				error: errors.apiKey,
				hint: "只写入服务端配置，页面不会回显。",
			})}
			${inputField("inputPerMTok", "输入单价", {
				value: draft.inputPerMTok,
				type: "number",
				min: "0",
				step: "0.001",
				placeholder: "美元 / 百万 token",
				error: errors.inputPerMTok,
			})}
			${inputField("outputPerMTok", "输出单价", {
				value: draft.outputPerMTok,
				type: "number",
				min: "0",
				step: "0.001",
				placeholder: "美元 / 百万 token",
				error: errors.outputPerMTok,
			})}
			${inputField("contextWindow", "上下文窗口", {
				value: draft.contextWindow,
				type: "number",
				min: "1",
				step: "1",
				placeholder: "token，例如 200000",
				error: errors.contextWindow,
			})}
			${inputField("maxOutput", "最大输出", {
				value: draft.maxOutput,
				type: "number",
				min: "1",
				step: "1",
				placeholder: "token（可选）",
				error: errors.maxOutput,
			})}
		</div>
		<div class="set-form-actions">
			<button class="set-btn" type="button" data-action="model-form-cancel">取消</button>
			<button class="set-btn set-btn--primary" type="submit">${editing === "" ? "添加模型" : "保存修改"}</button>
		</div>
	</form>`;
}

function readModelDraft(form) {
	const read = (name) => String(form.elements.namedItem(name)?.value ?? "").trim();
	return {
		id: read("id"),
		name: read("name"),
		provider: read("provider") || "openai-responses",
		baseUrl: read("baseUrl"),
		apiKey: read("apiKey"),
		inputPerMTok: read("inputPerMTok"),
		outputPerMTok: read("outputPerMTok"),
		contextWindow: read("contextWindow"),
		maxOutput: read("maxOutput"),
	};
}

function validateModelDraft(draft, editingId = state.modelEditing) {
	const errors = {};
	const catalog = state.data?.models?.catalog ?? [];
	if (draft.id === "") {
		errors.id = "模型 ID 必填。";
	} else if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(draft.id)) {
		errors.id = "只能用字母、数字和 . _ : / @ + -，且以字母或数字开头。";
	} else if (catalog.some((model) => model.id === draft.id && model.id !== editingId)) {
		errors.id = "这个 ID 已在模型清单里。";
	}
	if (draft.baseUrl !== "" && !/^https?:\/\/\S+$/i.test(draft.baseUrl)) {
		errors.baseUrl = "要以 http:// 或 https:// 开头。";
	}
	for (const [key, label] of [
		["inputPerMTok", "输入单价"],
		["outputPerMTok", "输出单价"],
	]) {
		if (draft[key] === "") continue;
		const value = Number(draft[key]);
		if (!Number.isFinite(value) || value < 0) {
			errors[key] = `${label}必须是非负数字（美元/百万 token）。`;
		}
	}
	for (const [key, label] of [
		["contextWindow", "上下文窗口"],
		["maxOutput", "最大输出"],
	]) {
		if (draft[key] === "") continue;
		const value = Number(draft[key]);
		if (!Number.isInteger(value) || value <= 0) {
			errors[key] = `${label}必须是正整数（token）。`;
		}
	}
	return errors;
}

function modelPayload(draft) {
	const payload = { id: draft.id, provider: draft.provider };
	// 编辑内置项 = 给这条内置 id 写覆盖项。把被覆盖的 id 一起带上，后端才知道
	// 这是「改内置」而不是「新建一条自定义模型」。
	if (state.modelEditing !== "") {
		const target = (state.data?.models?.catalog ?? []).find((item) => item.id === state.modelEditing);
		if (target?.source === "builtin") payload.builtin = target.builtin || state.modelEditing;
	}
	if (draft.name !== "") payload.name = draft.name;
	if (draft.baseUrl !== "") payload.baseUrl = draft.baseUrl;
	if (draft.apiKey !== "") payload.apiKey = draft.apiKey;
	if (draft.inputPerMTok !== "") payload.inputPerMTok = Number(draft.inputPerMTok);
	if (draft.outputPerMTok !== "") payload.outputPerMTok = Number(draft.outputPerMTok);
	if (draft.contextWindow !== "") payload.contextWindow = Number(draft.contextWindow);
	if (draft.maxOutput !== "") payload.maxOutput = Number(draft.maxOutput);
	return payload;
}

/**
 * 保存模型表单：新增走 `POST /api/models`，编辑走 `PATCH /api/models?id=`。
 *
 * 内置项也能编辑 —— 后端把它落成一条 `builtin` 覆盖项（重启后生效）。
 */
async function saveModel(draft) {
	const form = panel?.querySelector("#model-form");
	if (form !== null) form.setAttribute("aria-busy", "true");
	const editing = state.modelEditing;
	try {
		const result =
			editing === ""
				? await requestJson("/api/models", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(modelPayload(draft)),
					})
				: await requestJson(`/api/models?id=${encodeURIComponent(editing)}`, {
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(modelPayload(draft)),
					});
		state.modelForm = false;
		state.modelEditing = "";
		state.modelDraft = null;
		state.modelErrors = null;
		if (result?.models !== undefined) applySettings(result, { keepIm: true });
		else await refresh({ quiet: true, keepIm: true });
		renderAll();
		const verb = editing === "" ? "已添加模型" : "已保存模型";
		notify(
			result?.restartRequired === true
				? `${verb} ${draft.id}，重启服务后生效。`
				: `${verb} ${draft.id}。`,
			"info",
		);
	} catch (error) {
		state.modelErrors = { form: errorMessage(error) };
		renderModels();
		notify(`${editing === "" ? "添加" : "保存"}模型失败：${errorMessage(error)}`, "error");
	}
}

async function setDefaultModel(id) {
	try {
		const result = await requestJson(
			"/api/settings",
			jsonBody({ models: { default: id } }),
		);
		applySettings(result, { keepIm: true });
		renderAll();
		const restart = result?.models?.restartRequired === true;
		notify(restart ? `默认模型已设为 ${id}，重启服务后生效。` : `默认模型已设为 ${id}。`, "info");
	} catch (error) {
		notify(`设置默认模型失败：${errorMessage(error)}`, "error");
	}
}

async function deleteModel(id) {
	try {
		const result = await requestJson(`/api/models?id=${encodeURIComponent(id)}`, { method: "DELETE" });
		state.confirmDelete = "";
		if (result?.models !== undefined) applySettings(result, { keepIm: true });
		else await refresh({ quiet: true, keepIm: true });
		renderAll();
		notify(`已删除模型 ${id}${result?.restartRequired === true ? "，重启服务后生效。" : "。"}`, "info");
	} catch (error) {
		state.confirmDelete = "";
		renderAll();
		notify(`删除模型失败：${errorMessage(error)}`, "error");
	}
}

/* ── 渲染：IM ────────────────────────────────────────────────────────────── */

function renderIm() {
	if (containers.im === null) return;
	containers.im.innerHTML = imHtml();
}

function imHtml() {
	const parts = [];
	if (state.error !== "") parts.push(errorBlock({ compact: true }));
	if (state.data === null) {
		if (state.error === "") parts.push(loadingHint());
		return parts.join("");
	}
	const draft = state.imDraft;
	if (draft === null) return parts.join("") + loadingHint();
	const url = inboundUrl();
	const accounts = draft.accounts;
	const rows =
		accounts.length === 0
			? '<li class="set-empty">还没有账号。添加账号后，外部桥接服务才知道消息来自哪个渠道。</li>'
			: accounts.map(accountRow).join("");
	parts.push(`<div class="set-stack">
		<div class="set-switch-row">
			<div class="set-switch-copy">
				<b class="set-switch-title">启用 IM 入站</b>
				<span class="set-hint">关闭后入站地址直接拒绝外部消息。</span>
			</div>
			<label class="set-switch">
				<input type="checkbox" data-im="enabled"${draft.enabled ? " checked" : ""}>
				<span class="set-switch-track" aria-hidden="true"></span>
			</label>
		</div>
		<div class="set-field">
			<span class="set-field-label">入站地址</span>
			<div class="set-copy">
				<code class="set-copy-text mono" data-inbound-url>${escapeHtml(url)}</code>
				<button class="set-btn" type="button" data-copy="${escapeAttr(url)}" data-copy-label="入站地址">复制</button>
			</div>
			<span class="set-hint">外部桥把用户消息转发到这里；token 等同于密码，别贴到公开地方。</span>
		</div>
		<div class="set-field">
			<span class="set-field-label">入站 Token</span>
			<div class="set-input-row">
				<input class="set-input mono" type="text" data-im="inboundToken" value="${escapeAttr(draft.inboundToken)}" autocomplete="off" spellcheck="false" placeholder="点右侧生成">
				<button class="set-btn" type="button" data-action="generate-token">生成</button>
				<button class="set-btn" type="button" data-copy-token data-copy-label="Token">复制</button>
			</div>
		</div>
		<label class="set-field">
			<span class="set-field-label">出站 Webhook</span>
			<input class="set-input" type="url" data-im="outboundWebhook" value="${escapeAttr(draft.outboundWebhook)}" placeholder="https://...（可选）" autocomplete="off" spellcheck="false">
			<span class="set-hint">员工回复会 POST 到这个地址（群机器人或你自己的桥）。</span>
		</label>
		<div class="set-sub-head">
			<span>账号 <b class="tnum">${accounts.length}</b></span>
			<button class="set-btn" type="button" data-action="add-account">添加账号</button>
		</div>
		${state.accountDraft === null ? "" : accountFormHtml()}
		<ul class="set-list" aria-label="IM 账号">${rows}</ul>
		<p class="set-hint">IM 不是内置聊天窗口：需要一个外部桥接服务（微信 / 企微 / 飞书 / QQ 等）把消息转发到上面的入站地址。</p>
		<div class="set-save">
			<span class="set-dirty" data-im-dirty${state.imDirty ? "" : " hidden"}>有未保存的修改</span>
			<button class="set-btn set-btn--primary" type="button" data-action="save-im">保存 IM 设置</button>
		</div>
	</div>`);
	return parts.join("");
}

function accountRow(account) {
	const deleting = state.confirmAccountDelete === account.id;
	return `<li class="set-item${account.enabled ? "" : " is-off"}">
		<div class="set-item-body">
			<div class="set-item-line">
				<b class="set-item-name">${escapeHtml(account.name === "" ? "未命名账号" : account.name)}</b>
				<span class="set-tag">${escapeHtml(channelLabel(account.channel))}</span>
				<span class="set-tag ${account.enabled ? "set-tag--run" : ""}">${account.enabled ? "已启用" : "已停用"}</span>
			</div>
			${account.note === "" ? "" : `<div class="set-item-meta">${escapeHtml(account.note)}</div>`}
		</div>
		<div class="set-item-actions">
			<button class="set-btn" type="button" data-action="edit-account" data-id="${escapeAttr(account.id)}">编辑</button>
			${deleting
				? `<button class="set-btn set-btn--danger" type="button" data-action="delete-account" data-id="${escapeAttr(account.id)}" data-confirm="1">确认删除</button>
					<button class="set-btn" type="button" data-action="cancel-account-delete">取消</button>`
				: `<button class="set-btn set-btn--danger" type="button" data-action="delete-account" data-id="${escapeAttr(account.id)}">删除</button>`}
		</div>
	</li>`;
}

function accountFormHtml() {
	const draft = state.accountDraft;
	if (draft === null) return "";
	const errors = state.accountErrors ?? {};
	return `<form class="set-form" id="account-form" novalidate>
		<div class="set-form-head">
			<b>${draft.id === "" ? "添加账号" : "编辑账号"}</b>
			<span class="set-hint">保存后点「保存 IM 设置」写入服务端</span>
		</div>
		<div class="set-form-grid">
			${inputField("name", "名称", {
				value: draft.name,
				required: true,
				wide: true,
				placeholder: "例如 公司大群",
				error: errors.name,
			})}
			${selectField("channel", "渠道", CHANNELS, {
				value: draft.channel,
				error: errors.channel,
			})}
			${inputField("note", "备注", {
				value: draft.note,
				wide: true,
				placeholder: "可选，一句话说明这个账号接哪里",
				error: errors.note,
			})}
		</div>
		<label class="set-check">
			<input type="checkbox" name="enabled"${draft.enabled ? " checked" : ""}>
			<span>启用这个账号</span>
		</label>
		<div class="set-form-actions">
			<button class="set-btn" type="button" data-action="cancel-account">取消</button>
			<button class="set-btn set-btn--primary" type="submit">${draft.id === "" ? "添加" : "保存"}</button>
		</div>
	</form>`;
}

function readAccountDraft(form) {
	const read = (name) => String(form.elements.namedItem(name)?.value ?? "").trim();
	return {
		id: state.accountDraft?.id ?? "",
		name: read("name"),
		channel: read("channel") || "wechat",
		note: read("note"),
		enabled: Boolean(form.elements.namedItem("enabled")?.checked),
	};
}

function submitAccountForm(form) {
	const draft = readAccountDraft(form);
	state.accountDraft = draft;
	const errors = {};
	if (draft.name === "") errors.name = "账号名称必填，方便在对话里区分来消息的人。";
	state.accountErrors = errors;
	if (Object.keys(errors).length > 0) {
		renderIm();
		panel?.querySelector("#account-form [aria-invalid='true']")?.focus();
		return;
	}
	if (state.imDraft === null) return;
	const accounts = state.imDraft.accounts;
	if (draft.id === "") {
		const id = `acct_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		accounts.push({ ...draft, id });
	} else {
		const index = accounts.findIndex((account) => account.id === draft.id);
		if (index === -1) accounts.push({ ...draft });
		else accounts[index] = { ...draft };
	}
	state.accountDraft = null;
	state.accountErrors = null;
	markImDirty();
	renderIm();
}

function markImDirty() {
	state.imDirty = true;
	const indicator = panel?.querySelector("[data-im-dirty]");
	if (indicator !== null && indicator !== undefined) indicator.hidden = false;
}

function updateInboundUrl() {
	const url = inboundUrl();
	const code = panel?.querySelector("[data-inbound-url]");
	if (code !== null && code !== undefined) code.textContent = url;
	const copy = panel?.querySelector("[data-copy-label='入站地址']");
	if (copy !== null && copy !== undefined) copy.dataset.copy = url;
}

function generateToken() {
	if (state.imDraft === null) return;
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const token = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	state.imDraft.inboundToken = token;
	const input = panel?.querySelector('[data-im="inboundToken"]');
	if (input !== null && input !== undefined) input.value = token;
	markImDirty();
	updateInboundUrl();
	notify("已生成新的入站 token，保存后生效。", "info");
}

function validateIm() {
	const draft = state.imDraft;
	if (draft === null) return "";
	if (draft.enabled && draft.inboundToken.trim() === "") {
		return "启用 IM 前要先生成或填写入站 token。";
	}
	if (draft.outboundWebhook !== "" && !/^https?:\/\/\S+$/i.test(draft.outboundWebhook)) {
		return "出站 Webhook 要以 http:// 或 https:// 开头。";
	}
	if (draft.accounts.some((account) => account.name.trim() === "")) {
		return "每个账号都要有名称。";
	}
	return "";
}

async function saveIm() {
	const draft = state.imDraft;
	if (draft === null || state.data === null) return;
	const problem = validateIm();
	if (problem !== "") {
		notify(problem, "error");
		return;
	}
	const body = {
		enabled: draft.enabled,
		inboundToken: draft.inboundToken,
		outboundWebhook: draft.outboundWebhook,
		accounts: cloneAccounts(draft.accounts),
	};
	try {
		const result = await requestJson("/api/settings", jsonBody({ im: body }));
		if (result?.im !== undefined) {
			state.imDirty = false;
			state.accountDraft = null;
			state.accountErrors = null;
			applySettings(result, { keepIm: false });
			renderAll();
		} else {
			await refresh({ quiet: true, keepIm: false });
		}
		notify("IM 设置已保存。", "info");
	} catch (error) {
		notify(`保存 IM 设置失败：${errorMessage(error)}`, "error");
	}
}

/* ── 渲染：访问 ──────────────────────────────────────────────────────────── */

function renderNetwork() {
	if (containers.network === null) return;
	containers.network.innerHTML = networkHtml();
}

function networkHtml() {
	const parts = [];
	if (state.error !== "") parts.push(errorBlock({ compact: true }));
	if (state.data === null) {
		if (state.error === "") parts.push(loadingHint());
		return parts.join("");
	}
	const network = state.data.network;
	const rows = [
		`<p class="settings-row"><span>端口</span><span class="mono settings-value">${network.port === 0 ? "—" : network.port}</span></p>`,
		`<p class="settings-row"><span>监听</span><span class="mono settings-value">${escapeHtml(network.host === "" ? "—" : network.host)}</span></p>`,
	];
	const addresses = [];
	if (network.url !== "") addresses.push({ label: "本机", value: network.url });
	network.lanUrls.forEach((url, index) => {
		if (url !== network.url) addresses.push({ label: `局域网 ${index + 1}`, value: url });
	});
	parts.push(`<div class="set-stack">
		${rows.join("")}
		${
			addresses.length === 0
				? '<p class="set-hint">没有检测到可访问地址。</p>'
				: `<ul class="set-copy-list" aria-label="访问地址">${addresses
						.map((address) => copyRow(address.value, address.label))
						.join("")}</ul>`
		}
		<p class="set-hint set-hint--warn">没有登录与鉴权：只在可信局域网内使用，别把端口直接暴露到公网。</p>
		<p class="set-hint">改端口或监听地址需要重启服务，并同步更新启动参数。</p>
	</div>`);
	return parts.join("");
}

/* ── 复制 ────────────────────────────────────────────────────────────────── */

async function copyText(text, label) {
	const value = String(text ?? "");
	if (value === "") {
		notify(`没有可复制的${label}。`, "warn");
		return;
	}
	let copied = false;
	try {
		if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === "function") {
			await navigator.clipboard.writeText(value);
			copied = true;
		}
	} catch {
		copied = false;
	}
	if (!copied) {
		// 没有 clipboard API / 没有权限（http + 非 localhost、旧浏览器）时的兜底。
		// textarea 挂在 body 上而不是面板里：面板是 overflow 容器，focus/选中在 Safari 上会失效。
		const area = document.createElement("textarea");
		area.value = value;
		area.setAttribute("readonly", "");
		area.setAttribute("aria-hidden", "true");
		area.style.position = "fixed";
		area.style.top = "0";
		area.style.left = "0";
		area.style.width = "1px";
		area.style.height = "1px";
		area.style.padding = "0";
		area.style.border = "0";
		area.style.opacity = "0";
		document.body.append(area);
		area.focus({ preventScroll: true });
		area.select();
		area.setSelectionRange(0, value.length);
		try {
			copied = document.execCommand("copy");
		} catch {
			copied = false;
		}
		area.remove();
	}
	notify(copied ? `已复制${label}。` : "复制失败，请手动选中文本。", copied ? "info" : "error");
}

/* ── 数据流 ──────────────────────────────────────────────────────────────── */

function applySettings(raw, { keepIm = false } = {}) {
	const next = normalizeSettings(raw);
	state.data = next;
	state.error = "";
	if (!keepIm) {
		state.imDraft = {
			enabled: next.im.enabled,
			inboundToken: next.im.inboundToken,
			outboundWebhook: next.im.outboundWebhook,
			accounts: cloneAccounts(next.im.accounts),
		};
		state.imDirty = false;
		state.accountDraft = null;
		state.accountErrors = null;
	}
}

/**
 * 重渲染前把「已打开但还没提交」的表单值收回草稿。
 *
 * 打开设置面板会刷新一次数据，如果此时用户正在填表单，直接重渲染会把
 * 输入框里的内容清掉——草稿是唯一的事实来源，重渲染必须从它重新画。
 */
function captureOpenDrafts() {
	const modelForm = panel?.querySelector("#model-form");
	if (modelForm instanceof HTMLFormElement) state.modelDraft = readModelDraft(modelForm);
	const accountForm = panel?.querySelector("#account-form");
	if (accountForm instanceof HTMLFormElement && state.accountDraft !== null) {
		state.accountDraft = readAccountDraft(accountForm);
	}
}

async function refresh({ quiet = false, keepIm = state.imDirty } = {}) {
	if (state.loading) return;
	captureOpenDrafts();
	state.loading = true;
	if (!quiet && state.data === null) renderAll();
	try {
		const raw = await requestJson("/api/settings");
		state.loading = false;
		applySettings(raw, { keepIm });
		renderAll();
	} catch (error) {
		state.loading = false;
		state.error = errorMessage(error);
		renderAll();
	}
}

function errorMessage(error) {
	return error instanceof Error && error.message !== "" ? error.message : "未知错误";
}

function renderAll() {
	syncDefaultLabel();
	renderModels();
	renderIm();
	renderNetwork();
}

/**
 * index.html 的「默认模型」值行（#company-model）原本显示组织快照里的 company.model。
 * 设置面板里它是**配置**的默认模型，两者可能不同（改了默认但还没重启）。
 * 这里打上 data-settings-owner，app.js 的 renderChrome 就不再覆盖它。
 */
function syncDefaultLabel() {
	const label = document.getElementById("company-model");
	if (label === null) return;
	const models = state.data?.models;
	if (models === undefined) return;
	const id = resolveDefaultId(models);
	if (id === "") return;
	const model = models.catalog.find((item) => item.id === id);
	// 这一行是 .mono 的配置值，显示 id 比显示名字更准确（名字在下面的清单里）。
	label.textContent = id;
	label.title = model === undefined ? id : `${model.name}${model.provider === "" ? "" : ` · ${providerLabel(model.provider)}`}`;
	label.dataset.settingsOwner = "1";
}

/* ── 交互 ────────────────────────────────────────────────────────────────── */

function onClick(event) {
	const target = event.target instanceof Element ? event.target.closest("[data-action], [data-copy], [data-copy-token]") : null;
	if (target === null) return;
	if (target.hasAttribute("data-copy")) {
		void copyText(target.dataset.copy ?? "", target.dataset.copyLabel ?? "内容");
		return;
	}
	if (target.hasAttribute("data-copy-token")) {
		const input = panel?.querySelector('[data-im="inboundToken"]');
		void copyText(input?.value ?? "", "Token");
		return;
	}
	const id = target.dataset.id ?? "";
	switch (target.dataset.action) {
		case "retry":
			void refresh({ quiet: false, keepIm: state.imDirty });
			break;
		case "model-form-open":
			state.modelForm = true;
			state.modelEditing = "";
			state.modelDraft = { provider: "openai-responses" };
			state.modelErrors = null;
			renderModels();
			panel?.querySelector("#model-form input[name='id']")?.focus();
			break;
		case "model-form-cancel":
			state.modelForm = false;
			state.modelEditing = "";
			state.modelDraft = null;
			state.modelErrors = null;
			renderModels();
			break;
		case "edit-model": {
			const model = (state.data?.models?.catalog ?? []).find((item) => item.id === id);
			if (model === undefined) break;
			state.modelForm = true;
			state.modelEditing = id;
			// 回填既有值。API Key 不回显（服务端只存不读），留空表示「不修改」。
			state.modelDraft = {
				id: model.id,
				name: model.name,
				provider: model.provider === "" ? "openai-responses" : model.provider,
				baseUrl: model.baseUrl,
				inputPerMTok: model.inputPerMTok === null ? "" : String(model.inputPerMTok),
				outputPerMTok: model.outputPerMTok === null ? "" : String(model.outputPerMTok),
				contextWindow: model.contextWindow === null ? "" : String(model.contextWindow),
				maxOutput: model.maxOutput === null ? "" : String(model.maxOutput),
			};
			state.modelErrors = null;
			state.confirmDelete = "";
			renderModels();
			panel?.querySelector("#model-form input[name='id']")?.focus();
			break;
		}
		case "cancel-edit-model":
			state.modelForm = false;
			state.modelEditing = "";
			state.modelDraft = null;
			state.modelErrors = null;
			renderModels();
			break;
		case "default-model":
			void setDefaultModel(id);
			break;
		case "delete-model":
			if (target.dataset.confirm === "1") {
				void deleteModel(id);
			} else {
				state.confirmDelete = id;
				renderModels();
			}
			break;
		case "cancel-delete":
			state.confirmDelete = "";
			renderModels();
			break;
		case "add-account":
			state.accountDraft = { id: "", channel: "wechat", name: "", enabled: true, note: "" };
			state.accountErrors = null;
			state.confirmAccountDelete = "";
			renderIm();
			panel?.querySelector("#account-form input[name='name']")?.focus();
			break;
		case "edit-account": {
			const account = state.imDraft?.accounts.find((item) => item.id === id);
			if (account !== undefined) {
				state.accountDraft = { ...account };
				state.accountErrors = null;
				state.confirmAccountDelete = "";
				renderIm();
				panel?.querySelector("#account-form input[name='name']")?.focus();
			}
			break;
		}
		case "delete-account":
			if (target.dataset.confirm === "1") {
				if (state.imDraft !== null) {
					state.imDraft.accounts = state.imDraft.accounts.filter((account) => account.id !== id);
					state.confirmAccountDelete = "";
					markImDirty();
					renderIm();
				}
			} else {
				state.confirmAccountDelete = id;
				renderIm();
			}
			break;
		case "cancel-account":
			state.accountDraft = null;
			state.accountErrors = null;
			renderIm();
			break;
		case "cancel-account-delete":
			state.confirmAccountDelete = "";
			renderIm();
			break;
		case "generate-token":
			generateToken();
			break;
		case "save-im":
			void saveIm();
			break;
		default:
			break;
	}
}

function onFieldChange(event) {
	const field = event.target instanceof HTMLElement ? event.target.dataset.im : undefined;
	if (field === undefined || field === "" || state.imDraft === null) return;
	if (event.target instanceof HTMLInputElement && event.target.type === "checkbox") {
		state.imDraft[field] = event.target.checked;
	} else if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
		state.imDraft[field] = event.target.value;
	}
	markImDirty();
	if (field === "inboundToken") updateInboundUrl();
}

function onSubmit(event) {
	const form = event.target;
	if (!(form instanceof HTMLFormElement)) return;
	// 注意：表单里有 name="id" 的输入框，它会遮蔽 form.id（HTMLFormElement 的具名访问），
	// 所以这里只能读 attribute，不能读 property。
	// 设置里所有表单都自己处理，一律拦住原生提交（否则整页跳转把界面刷掉）。
	event.preventDefault();
	const id = form.getAttribute("id");
	if (id === "model-form") submitModelForm(form);
	else if (id === "account-form") submitAccountForm(form);
}

function submitModelForm(form) {
	const draft = readModelDraft(form);
	state.modelDraft = draft;
	const errors = validateModelDraft(draft);
	state.modelErrors = errors;
	if (Object.keys(errors).length > 0) {
		renderModels();
		panel?.querySelector("#model-form [aria-invalid='true']")?.focus();
		return;
	}
	void saveModel(draft);
}

function bind() {
	if (panel === null || panel.dataset.settingsBound === "1") return;
	panel.dataset.settingsBound = "1";
	panel.addEventListener("click", onClick);
	panel.addEventListener("input", onFieldChange);
	panel.addEventListener("change", onFieldChange);
	panel.addEventListener("submit", onSubmit);
}

/* ── 对外接口 ────────────────────────────────────────────────────────────── */

/**
 * @param {{ onToast?: (text: string, tone?: string) => void }} options
 */
export function initSettings(options = {}) {
	if (typeof options.onToast === "function") notify = options.onToast;
	panel = document.getElementById("settings");
	containers.models = document.getElementById("settings-models");
	containers.im = document.getElementById("settings-im");
	containers.network = document.getElementById("settings-network");
	if (panel === null) {
		return { refresh: async () => {}, apply: () => {} };
	}
	bind();
	renderAll();
	void refresh();
	return {
		refresh(options_) {
			return refresh(options_);
		},
		/** 开发 / 视觉验收用：直接渲染一份契约数据，不发请求。 */
		apply(payload) {
			applySettings(payload, { keepIm: false });
			state.loading = false;
			renderAll();
		},
	};
}
