/**
 * 新前端（世代 2 频道页）的共享小工具。
 *
 * 与 `ui/js/format.js` 的关系：那个文件是旧前端（组织图 / 看板 / 设置 / 档案 / 流水）
 * 共用的，里面有大量本页用不到的东西（token 格式化、状态色、工具图标映射）。
 * 这里只留本页真正用到的：转义、截断、时间、剪贴板、字节、排序。
 *
 * 为什么新开一份而不是抽公共：旧前端的这些函数与它的 CSS 变量、图标表绑在一起，
 * 抽出来会连带把旧概念搬进新页面。等旧前端删掉，这两份自然合一。
 *
 * 类型上的约定：凡是「要被转成字符串」的入参一律收 `unknown`（模型文本、后端缺字段、
 * 本地占位都可能进来，函数体第一件事就是 `String(x ?? "")`），时间戳收 `number`
 * （要直接喂 `new Date`）。这样调用点不必为了过编译去写 `?? ""`。
 */

export function escapeHtml(text: unknown): string {
	return String(text ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function escapeAttr(text: unknown): string {
	return escapeHtml(text).replace(/`/g, "&#96;");
}

/**
 * 按「字素簇」截断文本，不把 emoji / 扩展区汉字切成半个。
 *
 * `String.prototype.slice` 切的是 UTF-16 码元：`🚀`（两个码元）会被切出孤立代理，
 * 屏幕上就是一个 `�`；`𠮷` 这类扩展 B 区汉字同理。这里优先用 Intl.Segmenter 按字素簇切
 * （连「👨‍👩‍👧」这种 ZWJ 组合也不会拆开），环境不支持就退回按码点切。
 */
function graphemes(text: string): string[] {
	const segmenter =
		typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
			? new Intl.Segmenter("zh", { granularity: "grapheme" })
			: null;
	return segmenter ? [...segmenter.segment(text)].map((part) => part.segment) : [...text];
}

export function clipText(text: unknown, limit: number): string {
	const raw = String(text ?? "");
	const max = Math.max(0, Math.floor(Number(limit) || 0));
	if (raw === "" || max === 0) return "";
	// 快路径：UTF-16 长度都不超，就一定不超字素数。
	if (raw.length <= max) return raw;
	const units = graphemes(raw);
	if (units.length <= max) return raw;
	return units.slice(0, max).join("");
}

/** 列表里的相对时间：「刚刚 / 3 分钟前 / 昨天 14:05」。 */
export function relTime(at: number, now: number = Date.now()): string {
	const diff = now - at;
	if (!Number.isFinite(diff)) return "";
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	if (diff < 172_800_000) return "昨天";
	if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)} 天前`;
	return new Date(at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** 消息气泡上的时间：`HH:MM`。 */
export function clockTime(at: number): string {
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) return "";
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 耗时说人话：`0.4s` / `3.2s` / `1m 12s` / `2h 03m`。
 *
 * 规则来自 DESIGN §2.3：10 秒以内留一位小数（「3.2s」比「3s」更能看出快慢），
 * 一分钟以上进位到分，小时以上进位到小时 —— 一个步骤跑到几小时是异常，不需要秒。
 */
export function humanDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const seconds = ms / 1000;
	// 不到一秒写 `<1s`：`0.0s` 读起来像「没跑」，而它其实跑了。
	if (seconds < 1) return "<1s";
	if (seconds < 10) return `${seconds.toFixed(1)}s`;
	if (seconds < 60) return `${String(Math.round(seconds))}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${String(minutes)}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${String(hours)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** 同一天的时刻分隔条：`今天 14:05` / `10月26日 14:05`。 */
export function dayLabel(at: number, now: number = Date.now()): string {
	const date = new Date(at);
	const today = new Date(now);
	const sameDay =
		date.getFullYear() === today.getFullYear() &&
		date.getMonth() === today.getMonth() &&
		date.getDate() === today.getDate();
	if (sameDay) return "今天";
	const day = `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
	return date.getFullYear() === today.getFullYear() ? day : `${date.getFullYear()} 年 ${day}`;
}

export function sameDay(a: number, b: number): boolean {
	const left = new Date(a);
	const right = new Date(b);
	return (
		left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate()
	);
}

/** 复制到剪贴板，失败时返回 false（页面自己决定怎么提示）。 */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// 无 https / 无权限时退回 execCommand（老浏览器与 http:// 局域网访问都走这条）。
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.append(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	}
}

/**
 * 会话列表的未读数文案：0 → 空，1–99 → 数字，>99 → 「99+」。
 *
 * 为什么要在这里截断而不是让 CSS 去缩：徽标是定宽的，三位数一进来整行的
 * 名字就被挤窄一档（实测 1234 会把标题压掉两个字）。数字本身对我的价值
 * 到「有几十条」就饱和了，99+ 既说了量级又不改变行宽。
 */
const UNITS: readonly string[] = ["B", "KB", "MB", "GB"];

/** 文件大小说人话：1536 → `1.5 KB`。整数不留小数点，`0 B` 也不写成 `0 GB`。 */
export function humanBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(value < 10 ? 1 : 0);
	return `${rounded} ${UNITS[unit] ?? "B"}`;
}

export function unreadLabel(count: number): string {
	const value = Number(count);
	if (!Number.isFinite(value) || value <= 0) return "";
	if (value > 99) return "99+";
	return String(Math.floor(value));
}

/**
 * 顶栏副标题只用得上这两样：团队在干什么、人数。
 *
 * 单独声明而不是直接要 `Channel`：这个投影在私聊、团队频道、搜索结果上都要能跑，
 * 而那些地方手里未必有一条完整的 `Channel`（见 `api/types.ts`）。
 */
export type ChannelHead = {
	doing?: string | undefined;
	memberCount?: number | undefined;
};

/** 频道详情顶栏副标题的组成部分（非私聊）。团队频道把 doing 放最前面。 */
export function headParts(channel: ChannelHead | null | undefined): string[] {
	if (!channel) return [];
	const parts: string[] = [];
	// doing 是「这个团队现在在干什么」，比人数更能回答「我该不该点进去」，
	// 所以放在最前面；没有就不占位。
	if (channel.doing) parts.push(String(channel.doing));
	// 不写团队 slug：标题已经是团队名，`weekly` 只是目录名（DESIGN §1.4）。
	if (channel.memberCount) parts.push(`${channel.memberCount} 人`);
	return parts;
}

/**
 * 会话列表的排序：**助理恒第一**，其余按最后说话时间倒序。
 *
 * 为什么要在这里排而不是靠后端顺序：列表每次刷新（含重启后重新拉
 * `/api/channels`）都会重画，`lastAt` 一变助理就沉下去了 —— 我的助理
 * 不该因为「今天没说话」掉到列表底下。所以排序时先比「是不是助理的私聊」，
 * 再比时间，pin 与刷新顺序无关。
 */

/** 助理 = 身份在应用根下的那个人（后端按目录判定，这里只认这个标记）。 */
export function assistantSlug(people: readonly { slug: string; assistant?: true | undefined }[]): string | undefined {
	return people.find((person) => person.assistant === true)?.slug;
}

/**
 * 排序与置顶只认这三样：`id`（认出「助理的私聊」）、`kind`（只对私聊置顶）、
 * `lastAt`（比时间）。同样不直接要 `Channel`，因为侧栏与搜索结果都往这里塞。
 */export type ChannelPin = {
	id?: string | undefined;
	kind?: string | undefined;
	lastAt?: number | undefined;
};

export function isPinnedChannel(channel: ChannelPin | null | undefined, assistant: string | undefined): boolean {
	// 形态只看 `kind`（后端按成员推的 dm/group），不再从 id 前缀猜。
	if (channel?.kind !== "dm" || assistant === undefined) return false;
	return String(channel.id ?? "").endsWith(`-${assistant}`);
}

/** 泛型只为「排完还是原来那种频道对象」，不把字段裁成 `ChannelPin`。 */
export function sortChannels<T extends ChannelPin>(channels: readonly T[], assistant: string | undefined): T[] {
	return [...channels].sort((left, right) => {
		const leftPinned = isPinnedChannel(left, assistant);
		const rightPinned = isPinnedChannel(right, assistant);
		if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
		return (right.lastAt ?? 0) - (left.lastAt ?? 0);
	});
}
