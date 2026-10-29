/**
 * 四种行。这个文件就是「信息密度」的定义。
 *
 * 一张表定死能画什么：say / event / note / pending。未命中的 kind 一律 return null
 * —— 不画、不占高、不显示「不支持的消息类型」。宁可少一行，也不给界面添一种新卡片。
 *
 * 这里只产出 DOM 字符串/节点，不碰 fetch、不碰全局状态：事件全部交给 app.js 的委托。
 */

import { attachmentsHtml } from "./attach.js";
import { avatarSvg } from "./avatar.js";
import { clipText, clipWithEllipsis, clockTime, dayLabel, escapeHtml, sameDay } from "./format.js";
import { renderMarkdown } from "./markdown.js";

/**
 * 17 个工具 → 人话。这是产品语气的一部分：用户看到的是「他读了一个文件」，
 * 不是 `read_file({"path":"x"})`。未命中的工具名画「在做一件事」，绝不显示原名。
 */
export const TOOL_PHRASES = {
	say: "说了一句",
	read_channel: "翻了一遍频道",
	org: "看了一遍名册",
	hire: "拉了一个人进来",
	update_identity: "改了自己的档案",
	list_skills: "翻了一遍技能",
	read_skill: "读了一份技能",
	write_skill: "写了一份技能",
	list_projects: "翻了一遍项目",
	read_project: "读了一个项目",
	write_project: "写了一个项目",
	remember: "记了一笔",
	read_history: "翻了一遍历史",
	recall: "回想了一下",
	run: "执行了命令",
	write_file: "写了一个文件",
	read_file: "读了一个文件",
};

/** 说人类的 kind 走 say 行。其余（think/tool/work/note）各有归宿，剩下的不画。 */
const SAY_KINDS = new Set(["say", "chat", "report", "decision", "question"]);

/** 处理中占位的固定文案。存量数据里落库的是旧文案，界面不再读 message.text。 */
export const PROCESSING_TEXT = "开始处理";

/**
 * 这条占位是不是已经过期（同一个人在这之后已经说过话了）。
 *
 * 服务端的占位填充不保证一定覆盖成功：实测有占位留在库里、真人回复另起一条，
 * 于是屏幕上一条「开始处理」永远转圈。判断只看顺序与发言人，不看文案：
 * 同一个 slug 在它之后有任意一条非占位的说话行，这条占位就不该再画。
 */
/** 处理中占位的存活上限：超过它就是没人会来收的残留，不该再占着屏幕。 */
export const PLACEHOLDER_TTL_MS = 10 * 60 * 1000;

/**
 * 这条占位是不是放太久了。
 *
 * 有人会来收的占位（老板刚说完话、对方正在跑）几分钟内就会被覆盖或跟上一句话；
 * 但像是「叫了一个没有会话的同事」这种情况，那条占位永远不会有人接 —— 它会在
 * 屏幕上永远转圈。所以再加一条时间上限：超过 10 分钟就当它不存在。
 */
export function isExpiredPlaceholder(message, now = Date.now(), ttl = PLACEHOLDER_TTL_MS) {
	if (message?.processing !== true) return false;
	const at = Number(message.at);
	if (!Number.isFinite(at) || at <= 0) return false;
	return now - at > ttl;
}

export function isStalePlaceholder(message, messages, index) {
	if (message?.processing !== true) return false;
	const list = Array.isArray(messages) ? messages : [];
	for (let cursor = index + 1; cursor < list.length; cursor += 1) {
		const later = list[cursor];
		if (!later || later.fromSlug !== message.fromSlug) continue;
		if (later.processing === true) continue;
		if (later.kind == null || SAY_KINDS.has(later.kind)) return true;
	}
	return false;
}

/** 长文才折叠，追问和短报告不折。 */
const FOLD_KINDS = new Set(["chat", "report", "decision", "question", "say"]);
const FOLD_OVER = 1500;

/** 同一人 2 分钟内连发 → 后续行不画头像名字，只缩进对齐。 */
const GROUP_MS = 2 * 60 * 1000;
// 半分钟内连着说的几句算「一段」：气泡角连起来、时间戳只留第一个。
// 这和后端 `STEP_MERGE_MS` 是同一个数 —— 后端把过程话并进上一条，前端把漏过来的相邻几句
// 在视觉上并成一块，否则同一件事在屏幕上被切开成三块，读起来像三个人在抢话。
const CONT_MS = 30 * 1000;

const ICONS = {
	// 过程行的三个小图标：思考 / 工具 / 命令。12px 线性图标，一个颜色，
	// 不用彩色 —— 过程行是背景音，不该比正文更抢眼。
	think: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2v1.4M8 12.4v1.4M2.2 8h1.4M12.4 8h1.4M4 4l1 1M11 11l1 1M12 4l-1 1M5 11l-1 1"/><circle cx="8" cy="8" r="2.2"/></svg>`,
	tool: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M10.4 2.6a3.4 3.4 0 0 0-3.1 5.5L3 12.4l1.6 1.6 4.3-4.3a3.4 3.4 0 0 0 5.5-3.1l-2 2-1.9-.4-.4-1.9 2-2Z"/></svg>`,
	work: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.2 6.8 8 4 10.8M8.6 11h3.4"/></svg>`,
	copy: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="7" height="7" rx="1.6"/><path d="M10.5 3.6A1.6 1.6 0 0 0 8.9 2.5H5A1.5 1.5 0 0 0 3.5 4v3.9c0 .7.5 1.3 1.1 1.5"/></svg>`,
	check: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6.5"/></svg>`,
	reply: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 4.5 3 8l3.5 3.5"/><path d="M3 8h5a4.5 4.5 0 0 1 4.5 4.5v.5"/></svg>`,
};

/** 一条消息是不是「需要你」。这是顶栏 N 件找你与左侧 2px 竖线的唯一来源。 */
export function isNeed(message) {
	if (!message) return false;
	// 「开始处理…」占位的 status 也是 pending，但它不是待办、不是要老板拍板的东西。
	if (message.processing === true) return false;
	if (message.kind === "pending" || message.status === "pending") return true;
	if (message.fromSlug === "owner") return false;
	// 提问，且点名了老板（owner 的 id 恒为 0）。
	if (message.kind === "question") {
		return Array.isArray(message.mentions) && message.mentions.some((m) => m.id === 0);
	}
	return false;
}

/* ── event 行的人话 ─────────────────────────────────────────────────── */

/** 一行最多多少字。老板的原话是「单行截断 60 字，展开看全文」。 */
export const SUMMARY_LIMIT = 60;

/**
 * 压成一行：折叠换行与连续空白，超长截断。
 *
 * 摘要必须是一行 —— 一条命令带十几个参数时，屏幕上只允许它占一行，
 * 否则「过程行」立刻变回一堵墙。
 */
export function clampLine(text, limit = SUMMARY_LIMIT) {
	const flat = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (flat === "") return "";
	return clipWithEllipsis(flat, limit);
}

/** 一段文字的第一句（句号/问号/叹号/换行切），再截到一行 60 字。 */
export function firstSentence(text, limit = SUMMARY_LIMIT) {
	const raw = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (raw === "") return "";
	const cut = raw.split(/(?<=[。！？!?])/)[0] ?? raw;
	return clampLine(cut, limit);
}

/**
 * 工具参数解析。
 *
 * 真实投影（`src/core/channel/transcript.ts` 的 summarizeArguments）给的不是 JSON，
 * 而是 `code 风格` 的一行：`run command=npm start · cwd=/x`、`read_file path=ui/web/js/rows.js`。
 * 所以先按 ` · ` 拆键值对；万一哪天又回退成 JSON，也认一份，别让摘要重新变成
 * 「执行了命令」这种什么都没说的话。
 */
export function toolArgs(text) {
	const raw = String(text ?? "");
	const space = raw.indexOf(" ");
	if (space < 0) return {};
	const rest = raw.slice(space + 1).trim();
	if (rest.startsWith("{")) {
		try {
			const parsed = JSON.parse(rest);
			return parsed !== null && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}
	const out = {};
	for (const part of rest.split(" · ")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
	}
	return out;
}

/** 命令只留第一行：多行命令的正文是后续输出，不是「运行了什么」。 */
export function firstLine(text) {
	const raw = String(text ?? "");
	const cut = raw.search(/\r?\n/);
	return cut < 0 ? raw : raw.slice(0, cut);
}

const ACTION_LABEL = {
	think: "思考",
	run: "运行",
	bash: "运行",
	read_file: "读文件",
	write_file: "写文件",
	read_skill: "读技能",
	write_skill: "写技能",
	read_project: "读项目",
	write_project: "写项目",
	read_channel: "翻频道",
	read_history: "翻历史",
	recall: "回想",
	remember: "记忆",
	org: "看名册",
	list_skills: "翻技能",
	list_projects: "翻项目",
	hire: "招人",
	update_identity: "改档案",
	say: "说话",
};

/** 过程行中间那一段「动作」：思考 / 运行 / 读文件。 */
export function eventAction(message) {
	if (!message) return "";
	if (message.kind === "think") return ACTION_LABEL.think;
	if (message.kind === "work") return ACTION_LABEL.run;
	const tool = toolNameOf(message);
	return ACTION_LABEL[tool] ?? ACTION_LABEL[tool?.replace(/^list_|^read_|^write_/, "") ?? ""] ?? "工具";
}

/** 过程行的图标种类：think / tool / work。 */
export function eventIconKind(message) {
	if (message?.kind === "think") return "think";
	if (message?.kind === "work") return "work";
	return "tool";
}

/**
 * 过程行右边那段摘要 —— 这一批的核心：每行都要写出「到底做了什么」。
 *
 *   运行命令 → 命令本身（`$` 去掉，单行 60 字）
 *   思考     → 那段思考的第一句（60 字，省略号收尾）
 *   读/写文件 → 文件名（目录太长就截前面，文件名比目录有信息量）
 *   其它工具 → TOOL_PHRASES 里那句人话
 */
export function eventSummary(message) {
	if (!message) return "";
	if (message.kind === "think") return firstSentence(message.text) || "想了一会儿";
	if (message.kind === "work") {
		const text = String(message.text ?? "").trim();
		// work 的正文是「首行 `$ 命令` + 后面的输出」。摘要只要命令那一行 ——
		// 把输出一起压进来，整行会被几十行 stdout 的空白挤满，等于没说。
		if (text.startsWith("$")) return clampLine(text.replace(/^\$\s*/, "").split(/\r?\n/)[0]) || "执行了命令";
		const file = /^(?:已)?(?:写入|读取)\s*(.+)$/.exec(firstLine(text));
		if (file) return clampLine(shortPath(file[1]));
		return clampLine(firstLine(text)) || "执行了命令";
	}
	const name = toolNameOf(message);
	const args = toolArgs(message.text);
	// 运行命令：写命令本身，别写「执行了命令」—— 十四个「执行了命令」等于什么都没说。
	if (name === "run" || name === "bash") {
		const cmd = args.command ?? args.cmd;
		if (cmd) return clampLine(firstLine(cmd));
	}
	// 读/写文件：文件名。`path=` 是真实投影里的键；JSON 只是兜底。
	if (/^(read|write)_(file|skill|project)$/.test(name ?? "")) {
		const arg = args.path ?? args.name ?? firstQuote(message.text);
		if (arg) return clampLine(shortPath(String(arg)));
	}
	return clampLine(TOOL_PHRASES[name] ?? "在做一件事");
}

/** 过程行展开后的原文：work 首行就是 `$ 命令`，think 是完整思考，tool 是完整参数。 */
export function eventDetail(message) {
	return String(message?.text ?? "").trim();
}

/** 组起点：优先消息自带的 `startedAt`，没有就用第一条过程行的 `at`。 */
export function groupSpan(entries) {
	const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
	if (list.length === 0) return { startAt: 0, endAt: 0, count: 0 };
	const first = list[0];
	const startAt = Number(first.startedAt ?? first.at ?? 0);
	const endAt = Number(list[list.length - 1].at ?? startAt);
	return { startAt, endAt: Math.max(startAt, endAt), count: list.length };
}

/** 占位记下的 startedAt 与首条过程行差多远就不再算「同一轮」。 */
export const RUN_START_MAX_GAP_MS = 10 * 60 * 1000;

/**
 * 这一段活**真正**从什么时候开始（ADR-072）。
 *
 * 过程行没有 `startedAt` —— 那是处理中占位在创建时记下的「触发消息到达时刻」。
 * 投影落库的 `at` 比它晚一个首包（实测 1–3 秒），拿 `at` 当起点会让
 * 「正在执行 · 67s」跑出 67s → 55s 这种倒退（一填充占位，起点就跳到后面去了）。
 * 所以只要这个 slug 在**这段活之前**留过 `startedAt`，就用它。
 */
export function runStartAt(all, run) {
	const first = Array.isArray(run) ? run[0] : undefined;
	if (first === undefined) return 0;
	const base = Number(first.startedAt ?? first.at ?? 0);
	const list = Array.isArray(all) ? all : [];
	const stop = list.indexOf(first);
	// 只往前看「最近的一条」：更早的 startedAt 属于上一轮、甚至几小时前的旧占位，
	// 拿它当起点会把计时直接算成 14170s / 20268s（老板实测过）。
	for (let index = (stop < 0 ? 0 : stop) - 1; index >= 0; index -= 1) {
		const item = list[index];
		if (item?.fromSlug !== first.fromSlug) continue;
		if (typeof item.startedAt !== "number") continue;
		// 和首条过程行差太远就不是「这一轮」的占位：宁可退回首条 at，也别算出一个
		// 几小时的总用时。
		if (item.startedAt > base) return base;
		if (base - item.startedAt > RUN_START_MAX_GAP_MS) return base;
		return item.startedAt;
	}
	return base;
}

/**
 * 把一串过程消息切成「连续干活段」：同一个人连着干，中间没人插话就是一段。
 *
 * 一段只画一个组头。以前是逐条画，agent 干一段活留下十四条消息，屏幕上就是
 * 两行一模一样的「14 步过程 命令 14」—— 老板的原话是「多么工整啊」。
 */
export function splitRuns(messages) {
	const runs = [];
	for (const message of messages ?? []) {
		const last = runs[runs.length - 1];
		const slug = message?.fromSlug;
		if (last !== undefined && last[0].fromSlug === slug) last.push(message);
		else runs.push([message]);
	}
	return runs;
}

/** 秒数：只从 `at` 推，永远非负（时钟抖一下也不许倒着走）。 */
export function elapsedSeconds(startAt, endAt) {
	const span = Number(endAt) - Number(startAt);
	if (!Number.isFinite(span) || span <= 0) return 0;
	return Math.round(span / 1000);
}

/**
 * 组头那一句：跑着「正在执行 · 67s」，跑完「已完成，用时 55 秒」。
 *
 * 以前这里是「14 步过程 命令 14」—— 内部术语，读不懂还重复。
 * running 时终点用 now，所以每多跑一秒数字就大一点；定格之后传 endAt，数字不再动。
 */
export function groupStatus({ running = false, startAt = 0, endAt = 0, now = 0 } = {}) {
	const seconds = elapsedSeconds(startAt, running ? now || endAt : endAt);
	return running ? runningStatus(seconds) : `已完成，用时 ${seconds} 秒`;
}

/** 跑着的组头文案：只吃一个秒数。逐秒刷新时用它，别再从文案里反解数字。 */
export function runningStatus(seconds) {
	return `正在执行 · ${Math.max(0, Math.round(Number(seconds) || 0))}s`;
}

/**
 * 底部活动行要不要显示：**只在过程行没画出来时兜底**。
 *
 * 跑着的组头已经写着「正在执行 · 12s + 动点」，底下再挂一条活动行就是同一件事
 * 说两遍。所以页面上已经有一个 running 组头时，这一行不显示。
 */
export function shouldShowActivity(run, { hasRunningGroup = false } = {}) {
	if (run == null) return false;
	return hasRunningGroup !== true;
}

/** 底部活动行：多久没新过程行就不再当它还在跑。 */
export const ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

/**
 * 底部那条活动行要显示哪一段活（纯函数，好测）。
 *
 * 起点和组头用同一套（`runStartAt`，即占位记下的 `startedAt`，没有才退回
 * 第一条过程行的 `at`）。以前这里是「最后一条过程行的 at」—— 每来一条过程就
 * 清零重算，老板看到的是一个永远停在 5s 的表。
 *
 * 老板后来的口径：跑完就直接收掉，不再停 4 秒显示「已完成」。所以最后一条不是
 * 过程行（他开口了、或者老板自己说话）时，这一行就没有要显示的东西。
 */
export function activityRun(messages, now = Date.now()) {
	const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
	if (list.length === 0) return null;
	const last = list[list.length - 1];
	if (last.fromSlug === "owner") return null;
	if (!isEventKind(last.kind)) return null;
	// 往回找同一个人的连续过程行：这一段就是这一轮活。
	const slug = last.fromSlug;
	let startIndex = list.length - 1;
	while (startIndex > 0) {
		const prev = list[startIndex - 1];
		if (!isEventKind(prev.kind) || prev.fromSlug !== slug) break;
		startIndex -= 1;
	}
	const run = list.slice(startIndex);
	const span = groupSpan(run);
	const startAt = runStartAt(list, run);
	if (now - span.endAt > ACTIVITY_WINDOW_MS) return null;
	return { slug, running: true, startAt, endAt: span.endAt };
}

/** 已完成组的可见提示：一句人话 + 箭头，点开看过程。 */
export const DONE_HINT = "查看过程";

/**
 * 逐秒刷新时的「只增不减」判断：上次多少秒、这次该显示多少秒。
 *
 * 以前这里是从组头的**文案**里抠数字（`/(\d+)s/`）：组头一旦改成「用时 67 秒」，
 * 抠出来是 null，比较恒为 false，防倒退逻辑就静默失效了 —— 而且没人会知道。
 * 所以秒数单独存在数值里（DOM 上是 `dataset.seconds`），文案只管显示。
 */
export function advanceSeconds(previous, startAt, now) {
	const seconds = elapsedSeconds(startAt, now);
	const prev = Number(previous);
	// 时钟被拨回时 seconds 会变小：保留上次的值，老板看不到数字倒退。
	if (Number.isFinite(prev) && prev >= 0 && seconds < prev) return prev;
	return seconds;
}

/** 完整组头：名字 + 状态。DOM 里名字单独一个节点，这里给测试和 aria 用。 */
export function groupHeader({ name = "", ...timing } = {}) {
	const status = groupStatus(timing);
	return name ? `${name} ${status}` : status;
}

/**
 * 组头**看得见**的那一段字。
 *
 * 老板的口径：跑完的过程组只留一句「查看过程」+ 展开箭头（不写名字、不写
 * 「已完成，用时 X 秒」；他说光一个空箭头「什么提示都没有」）。只有跑着时才显示
 * 「名字 正在执行 · 67s + 动点」。读屏和 tooltip 仍走 `groupHeader`（带名字和用时）。
 */
export function groupHeaderText({ name = "", running = false, startAt = 0, endAt = 0, now = 0 } = {}) {
	// 跑完的组头只留一句「查看过程」+ 箭头：老板说光一个空箭头「什么提示都没有」，
	// 但名字和「已完成，用时 X 秒」也不再往屏幕上放 —— 那些留在 aria-label 里。
	if (!running) return DONE_HINT;
	// 名字不进可见文案（aria 里仍有）；组头只说「正在执行 · 12s」。
	return groupStatus({ running: true, startAt, endAt, now });
}

function firstQuote(text) {
	const match = /"([^"]{1,64})"/.exec(text ?? "");
	return match ? match[1] : "";
}

/** 路径太长就把前面截掉 —— 文件名比目录名有信息量。 */
function shortPath(path) {
	return path.length > 42 ? `…${path.slice(-40)}` : path;
}

/** 工具名：文本的第一个词。如 `run command="ls"` → `run`。 */
/**
 * 「过程行」：他在想什么、跑了什么。这些行没有头像，缩进对齐在正文左缘，
 * 归属是**紧随其后的那句话**（见 `app.js` 里 `state.tailEvents` 的搬移）。
 */
export function isEventKind(kind) {
	return kind === "think" || kind === "tool" || kind === "work";
}

export function toolNameOf(message) {
	if (message.kind !== "tool") return "";
	return String(message.text ?? "")
		.trim()
		.split(/\s+/)[0]
		.replace(/[^\w-]/g, "");
}

/**
 * event 行要说的话。think 的秒数由 buildStream 合并计算，这里给的是不合并时的默认。
 */
export function eventPhrase(message) {
	return eventSummary(message);
}

/** 活动行的一句话（不含人名）。 */
export function activityPhrase(message) {
	if (!message) return "";
	if (message.kind === "think") return "在想事情";
	return eventPhrase(message);
}

/* ── 小工具 ─────────────────────────────────────────────────────────── */

function toolsBar() {
	return `<div class="row-tools" role="toolbar" aria-label="消息操作"><button class="tool" type="button" data-act="copy" title="复制" aria-label="复制">${ICONS.copy}</button><button class="tool" type="button" data-act="reply" title="引用回复" aria-label="引用回复">${ICONS.reply}</button></div>`;
}

function quoteBlock(replyTo) {
	if (!replyTo) return "";
	const label = escapeHtml(replyTo.fromLabel ?? "");
	const excerpt = escapeHtml(clipText(replyTo.excerpt, 80));
	return `<button class="row-quote" type="button" data-jump="${Number(replyTo.seq) || 0}"><b>${label}</b><span>${excerpt}</span></button>`;
}

/**
 * @名字 只换文字颜色、不加底色。做法是在已渲染的文本节点上包一层 span，
 * 而不是对 HTML 做正则替换 —— 后者会把标签属性里的字符也改掉。
 */
function paintMentions(root, mentions) {
	if (!Array.isArray(mentions) || mentions.length === 0) return;
	// 老板的 slug 是 `owner`，但没人愿意在界面上读到这个词（老板的原话：能不能改成 @老大）。
	// 所以他的三种叫法都认，画出来统一是 `@老大`。老消息里写的 `@owner` 也一起收进来。
	const owner = mentions.find((m) => m.id === 0);
	const labels = [...new Set(mentions.map((m) => m.label).filter(Boolean))].sort(
		(a, b) => b.length - a.length,
	);
	if (owner !== undefined) for (const alias of ["owner", "老板"]) if (!labels.includes(alias)) labels.push(alias);
	if (labels.length === 0) return;
	const pattern = new RegExp(`@(?:${labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
	const shownOf = (token) =>
		owner !== undefined && /^@(?:owner|老板)$/i.test(token) ? "@老大" : token;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const targets = [];
	while (walker.nextNode()) {
		const node = walker.currentNode;
		const parent = node.parentElement;
		if (!parent) continue;
		if (parent.closest("pre, code, a, .mention-name")) continue;
		if (!pattern.test(node.nodeValue ?? "")) continue;
		pattern.lastIndex = 0;
		targets.push(node);
	}
	for (const node of targets) {
		const text = node.nodeValue ?? "";
		const frag = document.createDocumentFragment();
		let last = 0;
		for (const match of text.matchAll(pattern)) {
			const at = match.index ?? 0;
			if (at > last) frag.append(text.slice(last, at));
			const span = document.createElement("span");
			span.className = "mention-name";
			span.textContent = shownOf(match[0]);
			frag.append(span);
			last = at + match[0].length;
		}
		if (last < text.length) frag.append(text.slice(last));
		node.replaceWith(frag);
	}
}

function bodyHtml(message) {
	const raw = String(message.text ?? "");
	// 附件画在正文**之前**：图片是这个人的第一句话，正文是补充说明。
	// 放在 `.md` 外面，因为 `.md` 是排版正文的（段落间距、列表标记），不是排图片的。
	// 纯附件消息的正文是服务端写的占位（文件名），读起来像一句正常的话，不用特判。
	const attachments = attachmentsHtml(message.attachments);
	// 纯附件消息的正文是服务端写的占位（「[图片] 宽图.png」）。图片已经画在图里、
	// 文件名已经在文件卡里，再把占位当正文排一遍就是同一件事说两次。
	const placeholderOnly = Boolean(message.attachments?.length) && /^\[(图片|文件)\]\s/.test(raw.trim());
	const text = renderMarkdown(raw);
	const body =
		placeholderOnly
			? ""
			: !FOLD_KINDS.has(message.kind ?? "say") || raw.length <= FOLD_OVER
			? `<div class="md">${text}</div>`
			: `<div class="md fold" data-folded="true">${text}</div><button class="text-btn fold-btn" type="button" data-fold-btn>展开全文（${raw.length} 字）</button>`;
	return `${attachments}${body}`;
}

/* ── say ────────────────────────────────────────────────────────────── */

function sayRow(message, ctx, grouped, cont = false) {
	const isOwner = message.fromSlug === "owner";
	const person = ctx.bySlug.get(message.fromSlug);
	const role = [person?.title, person?.project].filter(Boolean).join(" · ");
	const need = (ctx.isNeed ?? isNeed)(message) && !isOwner;

	const av = grouped
		? ""
		: `<div class="row-av">${avatarSvg({
				slug: message.fromSlug,
				name: message.fromLabel,
				size: 40,
				state: ctx.stateOf?.(message.fromSlug) ?? "idle",
			})}</div>`;

	const head = grouped
		? ""
		: `<div class="row-head"><span class="row-name">${escapeHtml(
				message.fromLabel ?? "",
			)}</span>${role ? `<span class="row-role">${escapeHtml(role)}</span>` : ""}${
				// 「需要你」放在名字和角色**之后**：一行的读法应该是「谁 · 什么角色 · 要我做什么」，
				// 先喊「需要你」再说谁在说话，读起来像系统的报错。
				need ? '<span class="need-tag">需要你</span>' : ""
			}<span class="row-time">${clockTime(message.at)}</span></div>`;

	const wrap = document.createElement("div");
	wrap.className = "row row-say";
	wrap.dataset.seq = String(message.seq);
	wrap.dataset.grouped = grouped ? "true" : "false";
	if (cont) wrap.dataset.cont = "true";
	if (isOwner) wrap.dataset.owner = "true";
	if (need) wrap.dataset.need = "true";
	wrap.innerHTML = `${av}<div class="row-body">${head}${quoteBlock(message.replyTo)}${bodyHtml(message)}${toolsBar()}</div>`;

	const md = wrap.querySelector(".md");
	if (md) paintMentions(md, message.mentions);
	return wrap;
}

/* ── note ───────────────────────────────────────────────────────────── */

function noteRow(message) {
	const note = document.createElement("div");
	note.className = "row row-note";
	note.dataset.seq = String(message.seq);
	note.innerHTML = `<div class="note-text">${renderMarkdown(String(message.text ?? ""))}</div>`;
	return note;
}

/* ── event（think / tool / work） ──────────────────────────────────── */

const CHEVRON = `<svg class="ev-chevron" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5"/></svg>`;

/**
 * 过程行（想了多久 / 跑了什么命令 / 做了什么）。
 *
 * 一整行都是一句话：句子后面挂细节。所以它是个按钮 —— 点开看原文。
 * 以前这些细节根本看不到：界面上只剩「想了一会儿」，而模型真正在想什么、
 * 那条命令到底跑了什么、输出了多少，全在 `message.text` 里躺着没人给出口。
 *
 * 细节用 `textContent` 写进 `<pre>`，不走 innerHTML：那是原始文本（可能带尖括号），
 * 不是 Markdown，也不该被当成 HTML。
 */
function eventNode(message) {
	const row = document.createElement("div");
	row.className = "row row-event";
	row.dataset.seq = String(message.seq);
	row.dataset.kind = message.kind;
	row.dataset.slug = String(message.fromSlug ?? "");
	// 时间戳留在 DOM 上：逐秒清扫时按它判断有没有超时。
	row.dataset.at = String(message.at ?? "");
	row.dataset.at = String(message.at ?? "");
	// 三段：图标 + 动作 + 摘要。摘要永远一行（60 字），原文在 .ev-body 里。
	const head = `<span class="ev-ico" aria-hidden="true">${ICONS[eventIconKind(message)]}</span><span class="ev-act">${escapeHtml(
		eventAction(message),
	)}</span><span class="ev-txt">${escapeHtml(eventSummary(message))}</span>`;
	const detail = eventDetail(message);
	if (detail === "") {
		row.innerHTML = `<span class="ev">${head}</span>`;
		return row;
	}
	row.innerHTML = `<button class="ev" type="button" data-act="expand" aria-expanded="false" title="展开看原文">${head}</button><div class="ev-body" hidden><pre></pre></div>`;
	row.querySelector("pre").textContent = detail;
	return row;
}

/**
 * 单条过程行节点（增量路径用）。
 *
 * `buildOne` 返回的是 DocumentFragment（一条消息可能还带时间分隔条），SSE 路径
 * 需要的是「这一行」本身：要把它塞进已经开着的组里，fragment 没有类名，判断不了。
 */
export function buildEventRow(message) {
	return eventNode(message);
}

/* ── pending（待办拍板卡，结构见 pending.css 顶部注释） ─────────────── */

function parsePending(message) {
	const given = message.pending;
	if (given && Array.isArray(given.options) && given.options.length > 0) {
		return {
			question: given.question ?? message.text ?? "",
			asker: given.asker ?? message.fromLabel ?? "",
			reviewer: given.reviewer ?? "",
			options: given.options.map((opt, index) => ({
				n: opt.n ?? index + 1,
				text: opt.text ?? String(opt),
				recommended: Boolean(opt.recommended),
			})),
		};
	}
	// 没有结构化字段时从正文里拆：第一行是问题，编号行是选项。
	const lines = String(message.text ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length < 3) return null;
	const options = [];
	for (const line of lines.slice(1)) {
		const match = /^(\d+)[.、)]\s*(.+)$/.exec(line);
		if (!match) continue;
		options.push({ n: Number(match[1]), text: match[2].replace(/\s*（?推荐）?\s*$/, ""), recommended: /推荐/.test(line) });
	}
	if (options.length < 2) return null;
	return { question: lines[0], asker: message.fromLabel ?? "", reviewer: "", options };
}

/**
 * 处理中指示：某人收到 @他 / 直接发给他的消息后，在他所在频道出现的「开始处理…」**气泡**。
 *
 * 它就是一条普通聊天消息 —— 同一个头像、同一个气泡样式，只是文案是「开始处理…」、
 * 末尾多三个跳动的点，气泡整体极轻微呼吸。被该人真实回复原地覆盖（processing 标记消失、
 * status=done）后，同一个 seq 就地变成普通气泡，不是一条孤立的闪烁条（#92）。
 */
function processingRow(message, ctx, grouped, cont) {
	// 文案固定「开始处理」：存量占位落库的是旧文案（「开始处理…」），界面不读 message.text。
	const row = sayRow({ ...message, text: PROCESSING_TEXT }, ctx, grouped, cont);
	row.classList.add("row-processing");
	row.dataset.kind = "processing";
	row.dataset.slug = String(message.fromSlug ?? "");
	const dots = document.createElement("span");
	dots.className = "proc-dots";
	dots.innerHTML = "<i></i><i></i><i></i>";
	// 点跟着文案走：正文最后一段的句尾，不是另起一行。
	const md = row.querySelector(".md");
	const tail = md?.lastElementChild;
	if (tail && tail.tagName === "P") tail.append(dots);
	else if (md) md.append(dots);
	else row.querySelector(".row-body")?.append(dots);
	return row;
}

function pendingRow(message, at, now) {
	const data = parsePending(message);
	if (!data) return null;
	const row = document.createElement("div");
	row.className = "row row-pending";
	row.dataset.seq = String(message.seq);
	row.dataset.need = "true";
	row.dataset.kind = "pending";

	const opts = data.options
		.map(
			(opt) =>
				`<button class="pending-opt" type="button" data-pending="answer" data-opt="${opt.n}"><span class="opt-n">${opt.n}</span><span class="opt-t">${escapeHtml(
					opt.text,
				)}</span>${opt.recommended ? '<span class="opt-rec">推荐</span>' : ""}</button>`,
		)
		.join("");

	const meta = [data.asker ? `${escapeHtml(data.asker)}问` : "", data.reviewer ? `${escapeHtml(data.reviewer)}已看过` : ""]
		.filter(Boolean)
		.join(" · ");

	row.innerHTML = `<article class="pending"><header class="pending-head"><span class="pending-kicker">需要你拍板</span><span class="pending-time" data-at="${at}">${clockTime(
		at,
	)}</span></header><h2 class="pending-q">${escapeHtml(data.question)}</h2>${meta ? `<p class="pending-meta">${meta}</p>` : ""}<div class="pending-opts">${opts}</div><form class="pending-foot"><input class="pending-input" type="text" placeholder="也可以直接写…" aria-label="说点别的"><button class="text-btn" type="button" data-pending="resolve">✓ 标记已解决</button><button class="text-btn" type="button" data-pending="reject">驳回</button></form></article>${toolsBar()}`;
	void now;
	return row;
}

/* ── 组装 ───────────────────────────────────────────────────────────── */

function timeSepNodes(message, prev) {
	const nodes = [];
	if (!prev) {
		if (!sameDay(message.at, Date.now())) nodes.push(sepNode(dayLabel(message.at)));
		return nodes;
	}
	if (!sameDay(prev.at, message.at)) {
		nodes.push(sepNode(dayLabel(message.at)));
	} else if (message.at - prev.at > 30 * 60 * 1000) {
		nodes.push(sepNode(clockTime(message.at)));
	}
	return nodes;
}

function sepNode(label) {
	const node = document.createElement("div");
	node.className = "time-sep";
	node.textContent = label;
	return node;
}

/** 过程行的短标签，用来做「15 步过程 · 想 3 · 命令 8」这行摘要。 */
export function eventLabel(message) {
	if (message.kind === "think") return "想";
	if (message.kind === "work") return "命令";
	const tool = toolNameOf(message);
	// `run` 的 stdout 会另存一条 `work`（同一次命令），两条都数就会变成「跑 6 · run 6」。
	if (tool === "run" || tool === "bash") return "命令";
	return tool ?? "用工具";
}

/**
 * 把 source 这个已完成组的行并进 target，只留 target 一个箭头。
 *
 * 老板要的是「相邻同名的已完成组能并就并」：同一段活被一句话打断、又接着干，
 * 屏幕上不该出现两个一模一样的箭头。起点取更早的那个，终点取更晚的那个。
 */
export function mergeDoneGroups(target, source) {
	if (!target || !source || target === source) return target;
	const list = target.querySelector(".evs-list");
	if (!list) return target;
	for (const row of [...source.querySelectorAll(".evs-list > .row-event")]) list.append(row);
	const start = Math.min(
		Number(target.dataset.start ?? 0) || Number.POSITIVE_INFINITY,
		Number(source.dataset.start ?? 0) || Number.POSITIVE_INFINITY,
	);
	if (Number.isFinite(start)) target.dataset.start = String(start);
	target.dataset.end = String(Math.max(Number(target.dataset.end ?? 0), Number(source.dataset.end ?? 0)));
	source.remove();
	return target;
}

/**
 * 把一个还在跑的组定格成「已完成」。
 *
 * 老板的口径是「跑完就收掉」：定格之后组头只剩一个箭头（`groupHeaderText` 在
 * 不跑的时候返回空串），不再跳秒、不再有动点 —— 那种「已完成但还在闪」的样子
 * 会让人以为它没结束。
 *
 * 只改这一个节点，不重建：重建会吃掉展开状态，而老板可能正开着它在看细节。
 */
export function markGroupDone(group, endAt) {
	if (!group || group.dataset.state !== "running") return group;
	const startAt = Number(group.dataset.start ?? 0);
	const end = Number(endAt) || Date.now();
	const name = group.dataset.name ?? "";
	group.dataset.state = "done";
	group.dataset.end = String(end);
	group.dataset.seconds = String(elapsedSeconds(startAt, end));
	const button = group.querySelector(".evs");
	if (!button) return group;
	button.setAttribute("aria-label", groupHeader({ name, running: false, startAt, endAt: end }));
	// 定格 = 换成「查看过程」+ 箭头（和 wrapEvents 画完成态时同一套字）。
	// 光留一个空箭头老板说「什么提示都没有」；名字和用时仍在 aria-label 里。
	button.innerHTML =
		`<span class="evs-what">${DONE_HINT}</span>` +
		'<svg class="ev-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
	return group;
}

/**
 * 把一串过程行收成一个可展开的组。
 *
 * 一个人干一件事能留下十几条 think/tool。全都平铺出来，一屏全是「想了 1s」，
 * 把他真正说的那句话埋掉了 —— 老板的原话是「沟通内容太多了，根本不像正常人之间沟通」。
 * 收成一行，想看细节再点开。
 */
export function wrapEvents(slug, name, nodes, timing = {}) {
	const rows = nodes.filter((node) => node.classList?.contains("row-event"));
	if (rows.length === 0) return nodes;
	const startAt = Number(timing.startAt ?? rows[0].dataset.at ?? 0);
	const endAt = Number(timing.endAt ?? startAt);
	const now = Number(timing.now ?? endAt);
	const running = timing.running === true;
	const wrap = document.createElement("div");
	wrap.className = "row row-events";
	wrap.dataset.slug = slug ?? "";
	wrap.dataset.name = name ?? "";
	wrap.dataset.state = running ? "running" : "done";
	wrap.dataset.start = String(startAt);
	wrap.dataset.end = String(endAt);
	// 秒数的数值真相存在这里：只增不减的比较读它，不读文案。
	wrap.dataset.seconds = String(elapsedSeconds(startAt, running ? now : endAt));
	// 组头是唯一的开关：展开/收起只在这里，行自己不再挂 chevron。
	const button = document.createElement("button");
	button.className = "evs";
	button.type = "button";
	button.dataset.act = "expand";
	button.setAttribute("aria-expanded", "false");
	button.setAttribute("aria-label", groupHeader({ name, running, startAt, endAt, now }));
	// 跑着的组头不写名字（老板的口径）：正文那块已经有头像和名字，组头再写一遍就是重复。
	// 名字留在 aria-label 里（groupHeader），读屏仍然知道是谁在跑。
	button.innerHTML = running
		? `<span class="evs-ico" aria-hidden="true">${ICONS.work}</span><span class="evs-what">${escapeHtml(
				groupStatus({ running: true, startAt, endAt, now }),
			)}</span><span class="evs-live" aria-hidden="true"><i></i><i></i><i></i></span><svg class="ev-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`
		: `<span class="evs-what">${DONE_HINT}</span><svg class="ev-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;
	const body = document.createElement("div");
	body.className = "evs-body";
	body.hidden = true;
	const inner = document.createElement("div");
	inner.className = "evs-list";
	for (const node of rows) {
		// 组里的时间分隔线没有意义（本来就在一段连续干活里），只留过程行本身
		if (node.classList?.contains("row-time-divider")) continue;
		inner.append(node);
	}
	body.append(inner);
	wrap.append(button, body);
	return [wrap];
}

/**
 * @param {Array<object>} messages 已按时间正序
 * @param {{people?:Array<object>, now?:number, stateOf?:(slug:string)=>string}} ctx
 * @returns {DocumentFragment}
 */
export function buildStream(messages, ctx = {}) {
	const list = Array.isArray(messages) ? messages : [];
	const bySlug = new Map((ctx.people ?? []).map((person) => [person.slug, person]));
	const full = { bySlug, stateOf: ctx.stateOf, isNeed: ctx.isNeed ?? isNeed };
	const now = ctx.now ?? Date.now();
	const frag = document.createDocumentFragment();

	let prevSay = ctx.prev ?? null; // 上一条 say（判断是否同人连发）
	let lastAt = ctx.prev?.at ?? 0; // 上一条被画出来的行的时间
	// 过程行先攒着，等「它产出的那句话」出现再一起放。
	//
	// 不攒的话：agent 先想、先执行命令、最后才说，于是「沈舟 想了 1s」出现在沈舟的**头像上方**
	// —— 读起来像是上一句的尾巴，也确实让人认错发言人。攒到他开口之后再放，
	// 三行过程就落在他那句话底下、和正文左缘对齐。
	// 过程行先攒着，等「它产出的那句话」出现再一起放。攒的粒度是**消息**，
	// 分组在 flushEvents 里按「同一个人连续干活」切，切出来的一段就是一个组。
	const pendingEvents = [];
	const queueEvent = (message, nodes) => pendingEvents.push({ message, nodes });
	// 跑着的组：只有整列最后一段、且离现在够近才算还在跑（不然历史里的旧尾巴永远在跳秒）。
	const RUNNING_WINDOW_MS = 5 * 60 * 1000;
	const emitRun = (entries, { running = false, endAt } = {}) => {
		if (entries.length === 0) return;
		const slug = entries[0].message.fromSlug;
		const span = groupSpan(entries.map((entry) => entry.message));
		const startAt = runStartAt(list, entries.map((entry) => entry.message));
		const lastAt = endAt ?? span.endAt;
		for (const node of wrapEvents(
			slug,
			bySlug.get(slug)?.label ?? slug,
			entries.flatMap((entry) => entry.nodes),
			{ startAt, endAt: lastAt, now, running },
		)) {
			// 相邻同名的已完成组并成一个箭头：中间只隔了一句话，屏幕上不该出现两个。
			const prev = frag.lastElementChild;
			if (
				!running &&
				prev?.classList?.contains("row-events") &&
				prev.dataset.state === "done" &&
				prev.dataset.slug === String(slug ?? "")
			) {
				mergeDoneGroups(prev, node);
				continue;
			}
			frag.append(node);
		}
	};
	/**
	 * 把攒着的过程行按「相邻同一个人」切段，逐段画成组。
	 * `keepSlug` 的那一份留在队列里（他就要开口了，那几句过程属于他下面那句话）。
	 * `open` 表示这是整列的收尾：最后一段可能还在跑，交给 running 判断。
	 */
	const flushEvents = (keepSlug, { open = false } = {}) => {
		if (pendingEvents.length === 0) return;
		const kept = pendingEvents.filter((entry) => keepSlug !== undefined && entry.message.fromSlug === keepSlug);
		const rest = pendingEvents.filter((entry) => !kept.includes(entry));
		// 分组规则和「整列重建」走同一个纯函数，两条路的组头才对得上。
		const runs = splitRuns(rest.map((entry) => entry.message)).map((messages) =>
			messages.map((message) => rest.find((entry) => entry.message === message)),
		);
		runs.forEach((run, index) => {
			const span = groupSpan(run.map((entry) => entry.message));
			const isLast = index === runs.length - 1;
			const running = open && isLast && now - span.endAt <= RUNNING_WINDOW_MS;
			emitRun(run, { running });
		});
		pendingEvents.length = 0;
		pendingEvents.push(...kept);
	};
	/** 他开口了：这一轮攒下的过程行收成一组，落在他说的话下面，计时定格在他开口那一刻。 */
	const takeEvents = (slug, endAt) => {
		const taken = [];
		for (let i = pendingEvents.length - 1; i >= 0; i -= 1) {
			if (pendingEvents[i].message.fromSlug !== slug) continue;
			taken.unshift(pendingEvents[i]);
			pendingEvents.splice(i, 1);
		}
		if (taken.length === 0) return [];
		const span = groupSpan(taken.map((entry) => entry.message));
		return wrapEvents(slug, bySlug.get(slug)?.label ?? slug, taken.flatMap((entry) => entry.nodes), {
			startAt: runStartAt(list, taken.map((entry) => entry.message)),
			endAt: endAt ?? span.endAt,
			now,
			running: false,
		});
	};

	for (let cursor = 0; cursor < list.length; cursor += 1) {
		const message = list[cursor];
		if (!message) continue;

		if (isEventKind(message.kind)) {
			// 跨天 / 隔了半小时的换一批时间分隔条：顺带把上一段过程收口，
			// 不然两段隔着半小时的活会被合成一个组，用时直接翻倍。
			const seps = timeSepNodes(message, lastAt ? { at: lastAt } : null);
			if (seps.length > 0) {
				flushEvents();
				for (const sep of seps) frag.append(sep);
			}
			queueEvent(message, [eventNode(message)]);
			lastAt = message.at;
			prevSay = null;
			continue;
		}

		if (message.kind === "note") {
			flushEvents();
			frag.append(noteRow(message));
			lastAt = message.at;
			prevSay = null;
			continue;
		}

		// B（处理中指示）：processing 占位按一条普通聊天消息画（头像 + 气泡，见 processingRow）。
		// 必须在 pending 分支之前拦：占位的 status 也是 pending，不拦就会被画成拍板卡。
		if (message.processing === true) {
			// 本人已经说过话、或者放了十分钟没人来收：这条占位是残留，不画
			// （不然屏幕上永远停在「开始处理」）。
			if (isStalePlaceholder(message, list, cursor) || isExpiredPlaceholder(message, now)) continue;
			const gap = prevSay === null ? Number.POSITIVE_INFINITY : message.at - prevSay.at;
			const grouped = prevSay !== null && prevSay.fromSlug === message.fromSlug && gap < GROUP_MS && gap >= 0;
			const cont = grouped && gap <= CONT_MS;
			flushEvents(message.fromSlug);
			if (!grouped) {
				for (const sep of timeSepNodes(message, lastAt ? { at: lastAt } : null)) frag.append(sep);
			}
			frag.append(processingRow(message, full, grouped, cont));
			for (const node of takeEvents(message.fromSlug, message.at)) frag.append(node);
			flushEvents();
			prevSay = message;
			lastAt = message.at;
			continue;
		}

		if (message.kind === "pending" || message.status === "pending") {
			const row = pendingRow(message, message.at, now);
			if (!row) continue;
			flushEvents();
			for (const sep of timeSepNodes(message, lastAt ? { at: lastAt } : null)) frag.append(sep);
			frag.append(row);
			lastAt = message.at;
			prevSay = null;
			continue;
		}

		// 未登记的 kind：不画。
		if (message.kind != null && !SAY_KINDS.has(message.kind)) continue;

		const gap = prevSay === null ? Number.POSITIVE_INFINITY : message.at - prevSay.at;
		const grouped =
			prevSay !== null &&
			prevSay.fromSlug === message.fromSlug &&
			gap < GROUP_MS &&
			gap >= 0;
		// 比「同一人连发」更紧的一档：半分钟内。再远就不是一段话，是两次说话了。
		const cont = grouped && gap <= CONT_MS;

		flushEvents(message.fromSlug);
		if (!grouped) {
			for (const sep of timeSepNodes(message, lastAt ? { at: lastAt } : null)) frag.append(sep);
		}

		frag.append(sayRow(message, full, grouped, cont));
		// 他自己的过程行跟在他这句话下面（见上面 `pendingEvents` 的注释）。
		for (const node of takeEvents(message.fromSlug, message.at)) frag.append(node);
		flushEvents();
		prevSay = message;
		lastAt = message.at;
	}

	// 收尾：最后一段如果离现在够近就是「正在跑」，组头显示递增计时。
	flushEvents(undefined, { open: true });
	return frag;
}

/**
 * 只画一条（SSE 推来新消息时用）。
 *
 * `prev` 是这条之前最后一条消息：连发合并、30 分钟时间分隔都靠它判断，
 * 不传的话每条新消息都会重新画一次头像和名字。
 */
export function buildOne(message, ctx = {}, prev = null) {
	return buildStream([message], { ...ctx, prev });
}
