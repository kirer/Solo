/**
 * 共享格式化与转义。
 *
 * 界面里所有模型文本进 DOM 前都必须经过 escapeHtml；
 * 图标名与工具名在这里统一映射，避免各处各写一套中文。
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

export function formatTokens(value) {
	const tokens = Number(value ?? 0);
	if (!Number.isFinite(tokens) || tokens <= 0) return "0";
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
	return String(Math.round(tokens));
}

export function formatCost(value) {
	const usd = Number(value ?? 0);
	if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
	if (usd < 0.01) return "<$0.01";
	return `$${usd.toFixed(2)}`;
}

export function statusLabel(status) {
	return status === "busy" ? "在跑" : status === "waiting" ? "待你" : "空闲";
}

/** 节点的边框状态：忙优先，其次待你，最后空闲。 */
export function statusOf(actor) {
	if (actor?.status === "busy") return "busy";
	if ((actor?.awaitingYou ?? 0) > 0 || actor?.status === "waiting") return "waiting";
	return "idle";
}

export function relTime(at, now = Date.now()) {
	const value = Number(at ?? 0);
	if (!Number.isFinite(value) || value <= 0) return "";
	const diff = Math.max(0, now - value);
	if (diff < 45_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
	if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`;
	const date = new Date(value);
	return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function clockTime(at) {
	const value = Number(at ?? 0);
	if (!Number.isFinite(value) || value <= 0) return "";
	const date = new Date(value);
	const pad = (n) => String(n).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function initials(label) {
	const text = String(label ?? "").trim();
	if (text === "") return "·";
	if (/^[\x00-\x7F]+$/.test(text)) {
		const words = text.split(/[\s_-]+/).filter(Boolean);
		if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
		return text.slice(0, 2).toUpperCase();
	}
	return text.slice(0, 1);
}

/** 稳定的人物色相：同一名字每次都得到同一个颜色。 */
const HUES = [172, 202, 42, 330, 12, 95, 240, 285];
export function hueFor(label) {
	const text = String(label ?? "");
	let hash = 0;
	for (let index = 0; index < text.length; index += 1) {
		hash = (hash * 31 + text.charCodeAt(index)) % 100_000;
	}
	return HUES[hash % HUES.length];
}

export function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

/** 工具名 → 中文动作。 */
const TOOL_LABELS = {
	bash: ["执行命令", "terminal"],
	read: ["读取文件", "file"],
	write: ["写入文件", "filePlus"],
	edit: ["修改文件", "edit"],
	org_tree: ["查看组织架构", "tree"],
	staff_hire: ["招聘员工", "userPlus"],
	staff_list: ["查看员工", "users"],
	staff_assign: ["分配工作", "userCheck"],
	staff_archive: ["归档员工", "userMinus"],
	project_create: ["立项", "folderPlus"],
	project_list: ["查看项目", "folder"],
	project_plan: ["制定计划", "clipboard"],
	project_terminate: ["终止项目", "stop"],
	project_delete: ["删除项目", "trash"],
	delegate_to_staff: ["派活", "send"],
	delegate_to_role: ["转交", "send"],
	escalate: ["上报", "arrowUp"],
	decide: ["拍板", "check"],
	budget_check: ["预算检查", "wallet"],
	cost_report: ["成本报告", "chart"],
	review_architecture: ["架构评审", "spark"],
};

/** 把工具参数压成一行人话。 */
function detailOf(name, args) {
	if (args === undefined || args === null || args === "") return "";
	const record = typeof args === "object" ? args : parseJsonish(args);
	if (record === undefined) return String(args).replace(/\s+/g, " ").slice(0, 120);

	const pick = (...keys) => {
		for (const key of keys) {
			const value = record[key];
			if (typeof value === "string" && value.trim() !== "") return value.trim();
			if (typeof value === "number") return String(value);
		}
		return "";
	};

	let detail = "";
	switch (name) {
		case "bash":
			detail = pick("command", "cmd", "script");
			break;
		case "read":
		case "write":
		case "edit":
			detail = pick("path", "file_path", "file");
			break;
		case "delegate_to_staff":
			detail = [pick("project"), pick("employee"), pick("task")].filter(Boolean).join(" · ");
			break;
		case "delegate_to_role":
			detail = [pick("role"), pick("task")].filter(Boolean).join(" · ");
			break;
		case "staff_hire":
			detail = [pick("project"), pick("name", "employee"), pick("role")].filter(Boolean).join(" · ");
			break;
		case "staff_assign":
			detail = [pick("project"), pick("employee"), pick("task")].filter(Boolean).join(" · ");
			break;
		case "staff_archive":
			detail = [pick("project"), pick("name", "employee")].filter(Boolean).join(" · ");
			break;
		case "project_create":
			detail = [pick("name"), pick("slug")].filter(Boolean).join(" · ") || pick("brief");
			break;
		case "project_terminate":
		case "project_delete":
			detail = [pick("project", "slug"), pick("reason")].filter(Boolean).join(" · ");
			break;
		case "escalate":
			detail = pick("question", "text");
			break;
		case "decide":
			detail = pick("decision", "text");
			break;
		case "budget_check":
		case "cost_report":
			detail = pick("project", "scope");
			break;
		case "project_plan":
			detail = [pick("project", "slug"), pick("goal")].filter(Boolean).join(" · ");
			break;
		default: {
			const first = Object.values(record).find(
				(value) => typeof value === "string" && value.trim() !== "",
			);
			detail = typeof first === "string" ? first : "";
		}
	}

	return detail.replace(/\s+/g, " ").slice(0, 160);
}

export function toolMeta(name, args) {
	const key = String(name ?? "tool");
	const [label, iconName] = TOOL_LABELS[key] ?? [key, "tool"];
	return { label, icon: iconName, detail: detailOf(key, args) };
}

export function parseJsonish(raw) {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw === "object") return raw;
	const text = String(raw).trim();
	if (text === "" || (text[0] !== "{" && text[0] !== "[")) return undefined;
	try {
		const parsed = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function isMac() {
	return /Mac|iPhone|iPad/.test(navigator.platform ?? "") || /Mac OS X/.test(navigator.userAgent);
}
