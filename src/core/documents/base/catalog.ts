/**
 * 文案目录：模型看得见的话，一句都不写在代码里。
 *
 * 为什么要有这一层：工具的 description、参数说明、拒绝话术、投递头、附件说明，全是
 * **行为约束**，和系统提示词同性质。以前它们散在 `channel/tools/*.ts` 里，改一句
 * 「PASS 什么时候合法」要动代码、重跑五个测试文件；同一件事还在 `rules.md`、技能里各写
 * 一遍，改一处漏两处。
 *
 * 现在只有一种形状：`## <key>` 分节，节体就是文案（可多行、可带 `{{插槽}}`）。
 *
 * ```markdown
 * ## say.refuse.pass
 * 这一轮只有你被叫醒，不能 PASS：回一句结果，或者说明卡在哪。
 * ```
 *
 * 代码里只留**键名**（`say.refuse.pass`）和机械规则（数字、正则、条件）。
 * 键缺失时返回空串而不是抛：工具不能因为一句话没配就整个坏掉；缺哪个键由
 * `npm run prompt:check` 直接报出来。
 *
 * 文件按名字排序读 —— 文案不影响确定性，但重复键必须能复现地报出来。
 */
import type { Fsx } from "../../fsx.ts";
import { renderSlots, type Slots } from "./slots.ts";

/** 一份文案目录。键是 `say.description` 这种点分名字。 */
export type TextCatalog = {
	/** 取一条。没有就返回空串。 */
	get(key: string): string;
	has(key: string): boolean;
	keys(): readonly string[];
};

/** 文案目录名（`<appRoot>/text`，相对工作区就是 `text`）。 */
export const TEXT_DIR = "text";

const HEADING = /^##[ \t]+([A-Za-z0-9_.:-]+)[ \t]*$/;

/** 解析一份文案文件。`## key` 之前的内容是给人看的说明，不参与。 */
export function parseCatalog(path: string, source: string): ReadonlyMap<string, string> {
	const entries = new Map<string, string>();
	const lines = source.replace(/\r\n/g, "\n").split("\n");
	let key: string | undefined;
	let body: string[] = [];
	const flush = (): void => {
		if (key === undefined) return;
		if (entries.has(key)) throw new Error(`文案键重复：${key}（${path}）`);
		// 只去掉首尾的空行：首行的缩进（例如 ` — {{text}}` 前那个空格）是文案的一部分。
		entries.set(key, body.join("\n").replace(/^\n+/, "").replace(/\s+$/, ""));
	};
	for (const line of lines) {
		const match = HEADING.exec(line);
		if (match === null) {
			if (key !== undefined) body.push(line);
			continue;
		}
		flush();
		key = match[1];
		body = [];
	}
	flush();
	return entries;
}

/** 把一份文案切成 `[键, 原始小节]`（含 `## key` 那一行），按文件里的顺序。 */
function sectionsOf(source: string): readonly (readonly [string, string])[] {
	const lines = source.replace(/\r\n/g, "\n").split("\n");
	const sections: [string, string][] = [];
	let key: string | undefined;
	let body: string[] = [];
	const flush = (): void => {
		if (key !== undefined) sections.push([key, `## ${key}\n${body.join("\n").trim()}`]);
	};
	for (const line of lines) {
		const match = HEADING.exec(line);
		if (match === null) {
			if (key !== undefined) body.push(line);
			continue;
		}
		flush();
		key = match[1];
		body = [];
	}
	flush();
	return sections;
}

/**
 * 按**键**把出厂文案同步进工作区：没改过的升到新版、改过的原样留着、缺的追加。
 *
 * 以前是「只补不改」：已有的键一个字不动。结果是出厂修正永远进不来 —— 2026-11-08
 * 实测，`say.param.options` 改了措辞，已经在跑的工作区永远读旧句（ADR-114）。
 *
 * 判据与 prompt / rules 同一套（ADR-031）：
 * - 当前值 == 出厂值 → 不用动；
 * - 账本（`seeded`）里记着「上次写进去的就是这个值」→ 没改过，覆盖成新版；
 * - 账本里没有这条，但这个值命中历史出厂 hash（`legacy`）→ 老工作区，覆盖成新版；
 * - 以上都不成立 → 用户改过，原样留着。
 *
 * 返回 `undefined` = 文件不用动。`seeded` 里是合并后与出厂一致的键（写回账本）。
 */
export function mergeCatalog(
	current: string,
	source: string,
	options: {
		/** 账本：键 → 上次播种时写进去的值 hash。 */
		readonly seeded: ReadonlyMap<string, string>;
		/** 账本里没有这条时，判断这个值是不是历史出厂内容。 */
		readonly legacy: (valueHash: string) => boolean;
		readonly hash: (value: string) => string;
	},
): { readonly text: string; readonly seeded: ReadonlyMap<string, string> } | undefined {
	const before = parseCatalog("current", current);
	const after = parseCatalog("seed", source);
	const sourceRaw = new Map(sectionsOf(source));
	const seeded = new Map<string, string>();
	let text = "";
	let cursor = 0;
	let changed = false;
	for (const span of headingSpans(current)) {
		text += current.slice(cursor, span.start);
		cursor = span.end;
		const oldRaw = current.slice(span.start, span.end);
		const next = after.get(span.key);
		if (next === undefined) {
			text += oldRaw;
			continue;
		}
		const now = before.get(span.key) ?? "";
		const mine = options.seeded.get(span.key);
		const unmodified =
			now === next ||
			(mine !== undefined ? mine === options.hash(now) : options.legacy(options.hash(now)));
		if (!unmodified) {
			text += oldRaw;
			continue;
		}
		seeded.set(span.key, options.hash(next));
		const raw = sourceRaw.get(span.key);
		if (raw === undefined) {
			text += oldRaw;
			continue;
		}
		// 保留这一节后面原有的空行：小节之间怎么隔开是文件的排版，不归同步管。
		const replacement = `${raw}${oldRaw.slice(oldRaw.trimEnd().length)}`;
		if (replacement !== oldRaw) changed = true;
		text += replacement;
	}
	text += current.slice(cursor);

	const missing = [...sourceRaw].filter(([key]) => !before.has(key));
	if (missing.length > 0) {
		text = `${text.replace(/\s+$/, "")}\n\n${missing.map(([, raw]) => raw).join("\n\n")}\n`;
		changed = true;
		for (const [key] of missing) seeded.set(key, options.hash(after.get(key) ?? ""));
	}
	return changed ? { text, seeded } : undefined;
}

/** 每个 `## key` 小节在原文里的位置：从标题行到下一个标题行之前。 */
function headingSpans(source: string): readonly { readonly key: string; readonly start: number; readonly end: number }[] {
	const spans: { key: string; start: number; end: number }[] = [];
	let offset = 0;
	let current: { key: string; start: number } | undefined;
	for (const line of source.split("\n")) {
		const match = HEADING.exec(line);
		if (match !== null) {
			if (current !== undefined) spans.push({ ...current, end: offset });
			current = { key: match[1] ?? "", start: offset };
		}
		offset += line.length + 1;
	}
	if (current !== undefined) spans.push({ ...current, end: source.length });
	return spans;
}

/** 读一整个目录（`.md`），合成一份目录。同键在第二个文件里出现就抛。 */
export async function loadTextCatalog(fsx: Fsx, dir: string = TEXT_DIR): Promise<TextCatalog> {
	const entries = await fsx.list(dir);
	const merged = new Map<string, string>();
	for (const entry of entries) {
		if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
		const source = await fsx.readText(`${dir}/${entry.name}`);
		if (source === undefined) continue;
		for (const [key, value] of parseCatalog(entry.name, source)) {
			if (merged.has(key)) throw new Error(`文案键重复：${key}（${entry.name}）`);
			merged.set(key, value);
		}
	}
	return {
		get: (key) => merged.get(key) ?? "",
		has: (key) => merged.has(key),
		keys: () => [...merged.keys()],
	};
}

/** 取一条并填插槽。目录缺失/键缺失 → 空串（调用方自己决定怎么降级）。 */
export function fill(catalog: TextCatalog | undefined, key: string, slots: Slots = {}): string {
	const template = catalog?.get(key) ?? "";
	if (template === "") return "";
	return renderSlots(template, slots).text.trim();
}
