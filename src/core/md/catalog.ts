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
import type { Fsx } from "../fsx.ts";
import { renderSlots, type Slots } from "./text.ts";

/** 一份文案目录。键是 `say.description` 这种点分名字。 */
export type TextCatalog = {
	/** 取一条。没有就返回空串。 */
	get(key: string): string;
	has(key: string): boolean;
	keys(): readonly string[];
};

/** 空目录：装配没给文案时的兜底（测试、以及文案目录还没播种的老工作区）。 */
export const EMPTY_CATALOG: TextCatalog = {
	get: () => "",
	has: () => false,
	keys: () => [],
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
 * 把出厂文案里**工作区还没有的键**追加到文件末尾；已有的键一个字不动。
 *
 * 为什么不是整份覆盖：`text/` 里的句子是可以被手改的（那是「我的组织」的一部分）。
 * 为什么不能只补缺失的文件：那样每次新增一个键，老工作区永远拿不到 —— 工具描述变成
 * 空串，模型看不见任何约束（实测踩过两次，都是手工去补的）。
 *
 * 返回 `undefined` = 没有新键，不用写盘。
 */
export function appendMissingKeys(current: string, source: string): string | undefined {
	const have = parseCatalog("current", current);
	const missing = sectionsOf(source).filter(([key]) => !have.has(key));
	if (missing.length === 0) return undefined;
	const tail = missing.map(([, raw]) => raw).join("\n\n");
	return `${current.replace(/\s+$/, "")}\n\n${tail}\n`;
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
