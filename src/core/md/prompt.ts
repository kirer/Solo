/**
 * 提示词：**读模板 → 填插槽 → 按前缀拼段**。
 *
 * V3 之前那版渲染器有 353 行，其中 32 段中文散文写在代码里，而且和工具名死死咬住
 * （文案里写「用 `skills(action=write)` 自己写一份」）—— 工具一改名，提示词就在教错的东西。
 * V3 把这些全搬进 `seed/prompt/*.md`，代码只剩排版。
 *
 * 三条设计约束（和 V2 完全一致，是黄金测试的对象）：
 *
 * 1. **确定性**：同一组文件必须渲染出逐字节相同的提示词。模板按文件名排序读，
 *    不碰时间、不碰 locale、不碰目录顺序 —— 否则每轮 prompt cache 都被打穿。
 * 2. **一个 md = 一段 = 一个 cache section**：文件名前缀定序，前缀后面那段就是段名
 *    （`10-rules.md` → `rules`）。加一段就是加个文件，不改代码。
 * 3. **不哄人**：填不上的事实写「（未设置）」并报出来，不替 agent 编一个合理的答案。
 *
 * 模板可以带一个可选的头（`doc.ts` 那套）：
 *
 * ```
 * ---
 * skip-empty: rules     # 这个插槽为空时整段消失（不写「规矩：（未设置）」——那会被当成许可）
 * use: delivery         # 这段不进系统提示词，是每轮贴给模型的回话规矩
 * ---
 * ```
 */
import { dirname, join } from "node:path";
import type { Fsx } from "../fsx.ts";
import { parseDoc } from "./doc.ts";
import { hasSlot, renderSlots, type SlotIssue, type Slots } from "./text.ts";

export type { SlotIssue } from "./text.ts";

/** 模板目录（相对工作区根）。播种机制把它从 `seed/prompt/` 拷过来。 */
export const PROMPT_DIR = "prompt";

/** 模板目录的绝对路径。`agentsRoot` 是 `<workspace>/agents`（和 `uploadsRootOf` 同一个约定）。 */
export function promptDirOf(agentsRoot: string): string {
	return join(dirname(agentsRoot), PROMPT_DIR);
}

/** 一段的用处：进系统提示词，还是每轮贴在投递正文里。 */
export type PromptUse = "system" | "delivery";

export type PromptTemplate = {
	/** 文件名（排序与报错都用它，不是路径）。 */
	readonly file: string;
	/** 文件名前缀，定序。 */
	readonly order: number;
	/** 段名，也是 cache section 的 key。 */
	readonly segment: string;
	readonly use: PromptUse;
	/** 这个插槽为空 → 整段不出现。`undefined` = 永远出现。 */
	readonly skipEmpty: string | undefined;
	/** 去掉头之后的正文（未填插槽）。 */
	readonly body: string;
};

export type PromptSegmentText = {
	readonly segment: string;
	readonly text: string;
};

export type RenderedPrompt = {
	/** 进系统提示词的那些段，已按顺序、已剔除空段。 */
	readonly segments: readonly PromptSegmentText[];
	/** 系统提示词全文（段之间空行分隔，无结尾换行）。 */
	readonly text: string;
	/** `use: delivery` 的段（段名 → 正文）。缺省时为空对象。 */
	readonly delivery: Readonly<Record<string, string>>;
	/** 渲染时发现的问题，按首次出现去重。空数组 = 干净。 */
	readonly issues: readonly SlotIssue[];
};

const FILENAME = /^(\d{2,})-([a-z][a-z0-9-]*)\.md$/;

/**
 * 解析一个模板文件。
 *
 * 文件名不合法就抛：模板的**顺序**是语义（规矩要排在能力前面），允许乱名就等于允许
 * 「顺序取决于文件系统怎么排」—— 那正是确定性最容易被破坏的地方。
 */
export function parseTemplate(file: string, source: string): PromptTemplate {
	const match = FILENAME.exec(file);
	if (match === null) {
		throw new Error(`提示词模板文件名必须是 \`NN-段名.md\`：${file}`);
	}
	const order = Number(match[1]);
	const doc = parseDoc(file, source);
	const segment = doc.front["segment"] ?? match[2] ?? "";
	if (!/^[a-z][a-z0-9-]*$/.test(segment)) {
		throw new Error(`提示词段名不合法（小写 kebab-case）：${file} → ${segment}`);
	}
	const use = doc.front["use"] ?? "system";
	if (use !== "system" && use !== "delivery") {
		throw new Error(`提示词模板的 use 只能是 system / delivery：${file} → ${use}`);
	}
	return { file, order, segment, use, skipEmpty: doc.front["skip-empty"], body: doc.body };
}

/**
 * 读一整个目录的模板。按 `(order, file)` 排序 —— 前缀相同就按文件名，绝不留「取决于
 * readdir 顺序」的口子。段名重复直接抛：两段同名会让其中一段悄悄不生效。
 */
export async function loadTemplates(fsx: Fsx, dir: string = PROMPT_DIR): Promise<readonly PromptTemplate[]> {
	const entries = await fsx.list(dir);
	const files = entries.filter((entry) => entry.kind === "file" && entry.name.endsWith(".md"));
	const templates: PromptTemplate[] = [];
	for (const entry of files) {
		const source = await fsx.readText(`${dir}/${entry.name}`);
		if (source === undefined) continue;
		templates.push(parseTemplate(entry.name, source));
	}
	templates.sort((a, b) => a.order - b.order || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

	const seen = new Set<string>();
	for (const template of templates) {
		if (seen.has(template.segment)) throw new Error(`提示词段名重复：${template.segment}（${template.file}）`);
		seen.add(template.segment);
	}
	return templates;
}

/** 填插槽、拼段。纯函数。 */
export function renderPrompt(templates: readonly PromptTemplate[], slots: Slots): RenderedPrompt {
	const issues: SlotIssue[] = [];
	const noted = new Set<string>();
	const note = (issue: SlotIssue): void => {
		if (noted.has(issue.slot)) return;
		noted.add(issue.slot);
		issues.push(issue);
	};

	const ordered = [...templates].sort((a, b) => a.order - b.order || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
	const system: PromptSegmentText[] = [];
	const delivery: Record<string, string> = {};

	for (const template of ordered) {
		const skip = template.skipEmpty;
		if (skip !== undefined) {
			// 键不存在 = 装配漏了这个插槽（缺陷，报出来）；键存在但空 = 现在确实没有。
			// 装配漏了这个键 = unknown（该改代码）；给了但空 = 事实就是没有，整段消失。
			if (!Object.hasOwn(slots, skip)) note({ slot: skip, reason: "unknown" });
			if (!hasSlot(slots, skip)) continue;
		}
		const rendered = renderSlots(template.body, slots);
		for (const issue of rendered.issues) note(issue);
		const text = rendered.text.trim();
		if (text === "") continue;
		if (template.use === "delivery") delivery[template.segment] = text;
		else system.push({ segment: template.segment, text });
	}

	return {
		segments: system,
		text: system.map((item) => item.text).join("\n\n"),
		delivery,
		issues,
	};
}

/** 一步到位：读目录 + 渲染。装配层用这个。 */
/** 整目录渲染（`prompt:check` 与测试用）。 @internal 仅供校验工具 */
export async function renderPromptDir(
	fsx: Fsx,
	slots: Slots,
	dir: string = PROMPT_DIR,
): Promise<RenderedPrompt> {
	return renderPrompt(await loadTemplates(fsx, dir), slots);
}
