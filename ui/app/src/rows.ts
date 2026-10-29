import { clipWithEllipsis } from "./lib/format.ts";
/**
 * 「一条消息该怎么说清」—— 从旧前端 `ui/web/js/rows.js` **原样搬过来**的纯规则。
 *
 * 这些不是排版偏好，是产品口径，每条都有来历：
 * - 17 个工具名翻成人话（`read_file` → 「读了一个文件」），未命中的一律「在做一件事」，
 *   绝不把工具原名给老板看；
 * - `run` 的摘要必须是**命令本身**（十几个参数也只占一行），写成「执行了命令」等于没说；
 * - 占位（「开始处理…」）有「过期」与「失效」两种死法，判据是顺序不是文案；
 * - 计时起点用 `startedAt` 不是 `at`（`at` 晚一个首包，会跑出 67s → 55s 的倒退）。
 *
 * 重构的边界：**渲染交给 React，规则一行不改**。函数体整段搬来、参数类型按调用点后补。
 */

import type { Message } from "./api/types.ts";

/** 过程行/说话行只用到这几个字段。 */
export type MsgLike = {
	kind?: string | undefined;
	text?: string | undefined;
	at?: number | undefined;
	startedAt?: number | undefined;
	fromSlug?: string | undefined;
	seq?: number | undefined;
	processing?: boolean | undefined;
	status?: "pending" | "done" | "error" | undefined;
	mentions?: { id: number }[] | undefined;
};

export type AnyMsg = MsgLike | Message | undefined;
/**
 * 四种行。这个文件就是「信息密度」的定义。
 *
 * 一张表定死能画什么：say / event / note / pending。未命中的 kind 一律 return null
 * —— 不画、不占高、不显示「不支持的消息类型」。宁可少一行，也不给界面添一种新卡片。
 *
 * 这里只产出 DOM 字符串/节点，不碰 fetch、不碰全局状态：事件全部交给 app.js 的委托。
 */


/**
 * 17 个工具 → 人话。这是产品语气的一部分：用户看到的是「他读了一个文件」，
 * 不是 `read_file({"path":"x"})`。未命中的工具名画「在做一件事」，绝不显示原名。
 */
export const TOOL_PHRASES: Record<string, string> = {
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
export function isExpiredPlaceholder(message: AnyMsg, now = Date.now(), ttl = PLACEHOLDER_TTL_MS) {
	if (message?.processing !== true) return false;
	const at = Number(message.at);
	if (!Number.isFinite(at) || at <= 0) return false;
	return now - at > ttl;
}

export function isStalePlaceholder(message: AnyMsg, messages: readonly AnyMsg[], index: number) {
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




/** 一条消息是不是「需要你」。这是顶栏 N 件找你与左侧 2px 竖线的唯一来源。 */
export function isNeed(message: AnyMsg) {
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
export function clampLine(text: unknown, limit = SUMMARY_LIMIT) {
	const flat = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (flat === "") return "";
	return clipWithEllipsis(flat, limit);
}

/** 一段文字的第一句（句号/问号/叹号/换行切），再截到一行 60 字。 */
export function firstSentence(text: unknown, limit = SUMMARY_LIMIT) {
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
export function toolArgs(text: unknown) {
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
	const out: Record<string, string> = {};
	for (const part of rest.split(" · ")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
	}
	return out;
}

/** 命令只留第一行：多行命令的正文是后续输出，不是「运行了什么」。 */
export function firstLine(text: unknown) {
	const raw = String(text ?? "");
	const cut = raw.search(/\r?\n/);
	return cut < 0 ? raw : raw.slice(0, cut);
}

const ACTION_LABEL: Record<string, string> = {
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
export function eventAction(message: AnyMsg) {
	if (!message) return "";
	if (message.kind === "think") return ACTION_LABEL.think;
	if (message.kind === "work") return ACTION_LABEL.run;
	const tool = toolNameOf(message);
	return ACTION_LABEL[tool] ?? ACTION_LABEL[tool?.replace(/^list_|^read_|^write_/, "") ?? ""] ?? "工具";
}

/** 过程行的图标种类：think / tool / work。 */
export function eventIconKind(message: AnyMsg) {
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
export function eventSummary(message: AnyMsg) {
	if (!message) return "";
	if (message.kind === "think") return firstSentence(message.text) || "想了一会儿";
	if (message.kind === "work") {
		const text = String(message.text ?? "").trim();
		// work 的正文是「首行 `$ 命令` + 后面的输出」。摘要只要命令那一行 ——
		// 把输出一起压进来，整行会被几十行 stdout 的空白挤满，等于没说。
		if (text.startsWith("$")) return clampLine(text.replace(/^\$\s*/, "").split(/\r?\n/)[0]) || "执行了命令";
		const file = /^(?:已)?(?:写入|读取)\s*(.+)$/.exec(firstLine(text));
		if (file) return clampLine(shortPath(file[1] ?? ""));
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
export function eventDetail(message: AnyMsg) {
	return String(message?.text ?? "").trim();
}

/** 组起点：优先消息自带的 `startedAt`，没有就用第一条过程行的 `at`。 */
export function groupSpan(entries: readonly AnyMsg[]) {
	const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
	if (list.length === 0) return { startAt: 0, endAt: 0, count: 0 };
	const first = list[0];
	const startAt = Number(first.startedAt ?? first.at ?? 0);
	const endAt = Number(list[list.length - 1].at ?? startAt);
	return { startAt, endAt: Math.max(startAt, endAt), count: list.length };
}

/** 占位记下的 startedAt 与首条过程行差多远就不再算「同一轮」。 */
export const RUN_START_MAX_GAP_MS = 10 * 60 * 1000;
/** 说话行离首条过程行多近才算「这一轮开头那句」（而不是上一轮的结尾）。 */
export const LEAD_SAY_GAP_MS = 60 * 1000;

/**
 * 这一段活**真正**从什么时候开始（ADR-072）。
 *
 * 过程行没有 `startedAt` —— 那是处理中占位在创建时记下的「触发消息到达时刻」。
 * 投影落库的 `at` 比它晚一个首包（实测 1–3 秒），拿 `at` 当起点会让
 * 「正在执行 · 67s」跑出 67s → 55s 这种倒退（一填充占位，起点就跳到后面去了）。
 * 所以只要这个 slug 在**这段活之前**留过 `startedAt`，就用它。
 */
export function runStartAt(all: readonly AnyMsg[], run: readonly AnyMsg[]) {
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
		if (!isEventKind(item.kind)) {
			// 碰到同一个人**说的一句话**：它可能是这一轮的开头（先说话再干活），也可能
			// 是上一轮的结尾（含「被填充的上一轮回复」—— 那种带 startedAt，靠有没有
			// startedAt 分辨不出来）。判据只看距离：`at` 离首条过程行 60 秒内才算
			// 这一轮的开头，否则就是上一轮，直接退回首条过程行的 at。
			const at = Number(item.at ?? 0);
			const near = Number.isFinite(at) && at > 0 && base - at <= LEAD_SAY_GAP_MS;
			if (!near) return base;
			// 这一轮的开头是「占位」时就带上它的 startedAt（真正的开跑时刻）。
			const started = typeof item.startedAt === "number" ? item.startedAt : at;
			if (started > base) return base;
			if (base - started > RUN_START_MAX_GAP_MS) return base;
			return started;
		}
	}
	return base;
}

/**
 * 把一串过程消息切成「连续干活段」：同一个人连着干，中间没人插话就是一段。
 *
 * 一段只画一个组头。以前是逐条画，agent 干一段活留下十四条消息，屏幕上就是
 * 两行一模一样的「14 步过程 命令 14」—— 老板的原话是「多么工整啊」。
 */
export function splitRuns(messages: readonly AnyMsg[]) {
	const runs: AnyMsg[][] = [];
	for (const message of messages ?? []) {
		const last = runs[runs.length - 1];
		const slug = message?.fromSlug;
		if (last !== undefined && last[0]?.fromSlug === slug) last.push(message);
		else runs.push([message]);
	}
	return runs;
}

/** 秒数：只从 `at` 推，永远非负（时钟抖一下也不许倒着走）。 */
export function elapsedSeconds(startAt: unknown, endAt: unknown) {
	const span = Number(endAt) - Number(startAt);
	if (!Number.isFinite(span) || span <= 0) return 0;
	return Math.round(span / 1000);
}

/**
 * 组头/aria 那一句：跑着「正在执行 · 67s」，跑完「已完成，用时 55 秒」。
 * 注意可见文案里跑着也只用「查看过程」—— 这个串只出现在 aria-label 与活动行。
 *
 * 以前这里是「14 步过程 命令 14」—— 内部术语，读不懂还重复。
 * running 时终点用 now，所以每多跑一秒数字就大一点；定格之后传 endAt，数字不再动。
 */
export function groupStatus({ running = false, startAt = 0, endAt = 0, now = 0 } = {}) {
	const seconds = elapsedSeconds(startAt, running ? now || endAt : endAt);
	return running ? runningStatus(seconds) : `已完成，用时 ${seconds} 秒`;
}

/** 跑着的组头文案：只吃一个秒数。逐秒刷新时用它，别再从文案里反解数字。 */
export function runningStatus(seconds: number) {
	return `正在执行 · ${Math.max(0, Math.round(Number(seconds) || 0))}s`;
}

/**
 * 底部活动行要不要显示：**有活跃轮次就显示**。
 *
 * 过程组头现在只说「查看过程」（不写名字、不写计时、不带动点），活跃状态只有
 * 这一条活动行负责 —— 所以它不再因为「组头在跑」而隐藏。`hasRunningGroup` 这个
 * 入参保留着只为兼容调用点，不影响判断。
 */
export function shouldShowActivity(run: unknown) {
	return run != null;
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
export function activityRun(messages: readonly AnyMsg[], now = Date.now()) {
	const list: AnyMsg[] = Array.isArray(messages) ? messages.filter(Boolean) : [];
	if (list.length === 0) return null;
	const last = list[list.length - 1];
	if (last === undefined) return null;
	if (last.fromSlug === "owner") return null;
	if (!isEventKind(last.kind)) return null;
	// 往回找同一个人的连续过程行：这一段就是这一轮活。
	const slug = last.fromSlug;
	let startIndex = list.length - 1;
	while (startIndex > 0) {
		const prev = list[startIndex - 1];
		if (prev === undefined || !isEventKind(prev.kind) || prev.fromSlug !== slug) break;
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
export function advanceSeconds(previous: unknown, startAt: unknown, now: number) {
	const seconds = elapsedSeconds(startAt, now);
	const prev = Number(previous);
	// 时钟被拨回时 seconds 会变小：保留上次的值，老板看不到数字倒退。
	if (Number.isFinite(prev) && prev >= 0 && seconds < prev) return prev;
	return seconds;
}

/** 完整组头：名字 + 状态。DOM 里名字单独一个节点，这里给测试和 aria 用。 */
export function groupHeader({ name = "", ...timing }: { name?: string; running?: boolean; startAt?: number; endAt?: number; now?: number }) {
	const status = groupStatus(timing);
	return name ? `${name} ${status}` : status;
}

/**
 * 组头**看得见**的那一段字。
 *
 * 老板的口径：跑完的过程组只留一句「查看过程」+ 展开箭头（不写名字、不写
 * 「已完成，用时 X 秒」；他说光一个空箭头「什么提示都没有」）。只有跑着时才显示
 * 「查看过程」。读屏和 tooltip 仍走 `groupHeader`（带名字和用时）。
 */
export function groupHeaderText(_props: { name?: string; running?: boolean; startAt?: number; endAt?: number; now?: number }) {
	// 跑完的组头只留一句「查看过程」+ 箭头：老板说光一个空箭头「什么提示都没有」，
	// 但名字和「已完成，用时 X 秒」也不再往屏幕上放 —— 那些留在 aria-label 里。
	// 跑着和跑完都一样：组头只说「查看过程」。活跃状态由底部活动行负责显示。
	return DONE_HINT;
}

function firstQuote(text: string | undefined) {
	const match = /"([^"]{1,64})"/.exec(text ?? "");
	return match ? match[1] : "";
}

/** 路径太长就把前面截掉 —— 文件名比目录名有信息量。 */
function shortPath(path: string) {
	return path.length > 42 ? `…${path.slice(-40)}` : path;
}

/** 工具名：文本的第一个词。如 `run command="ls"` → `run`。 */
export function isEventKind(kind: string | undefined) {
	return kind === "think" || kind === "tool" || kind === "work";
}

export function toolNameOf(message: AnyMsg) {
	if (message?.kind !== "tool") return "";
	// `split()` 至少返回一段，`[0]` 必然有值；`?? ""` 只为把 `string | undefined` 收窄。
	const word = String(message?.text ?? "")
		.trim()
		.split(/\s+/)[0] ?? "";
	return word.replace(/[^\w-]/g, "");
}

/**
 * event 行要说的话。think 的秒数由 buildStream 合并计算，这里给的是不合并时的默认。
 */
export function eventPhrase(message: AnyMsg) {
	return eventSummary(message);
}

/** 活动行的一句话（不含人名）。 */
export function activityPhrase(message: AnyMsg) {
	if (!message) return "";
	if (message.kind === "think") return "在想事情";
	return eventPhrase(message);
}

/* ── 小工具 ─────────────────────────────────────────────────────────── */

/** 过程行的短标签，用来做「15 步过程 · 想 3 · 命令 8」这行摘要。 */
export function eventLabel(message: AnyMsg) {
	if (message?.kind === "think") return "想";
	if (message?.kind === "work") return "命令";
	const tool = toolNameOf(message);
	// `run` 的 stdout 会另存一条 `work`（同一次命令），两条都数就会变成「跑 6 · run 6」。
	if (tool === "run" || tool === "bash") return "命令";
	return tool ?? "用工具";
}

/**
 * 这一组要不要默认展开。
 *
 * 老板要在私聊里看得见过程：过程组头现在只有「查看过程」，如果全折叠，刷新后
 * 屏幕上就没有新东西了。所以**私聊里最后一段（还在跑的那组）**默认展开；历史组
 * 和项目/公司频道保持折叠 —— 项目频道放的是结论，过程不该占正文。
 */
export function shouldOpenByDefault({
	channelKind,
	running = false,
	isLast = false,
}: {
	channelKind?: string;
	running?: boolean;
	isLast?: boolean;
}): boolean {
	return channelKind === "dm" && running === true && isLast === true;
}
