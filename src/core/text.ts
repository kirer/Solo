/**
 * 插槽渲染：把 `{{名字}}` 换成事实。
 *
 * 这是「提示词外置」的**最小机械件**。它只做替换，不认识任何具体插槽 —— 有哪些名字由
 * 调用方决定。所以加一段提示词、加一个插槽，都不用来改这个文件。
 *
 * 一条硬规矩：**未知插槽不许静默变空**。
 *
 * 静默空会让提示词里出现「你的上级：」这样一句话的半截 —— 模型不会报错，它会照着半截
 * 自己补一个听起来合理的答案（V2 实测补出过不存在的汇报线）。所以填不上就写
 * `（未设置）`，并且把问题**报出去**，让装配层 warn 或者直接失败。
 *
 * 报出去的东西分两种，因为**该谁去修**不同：
 *
 * - `unknown`：模板写了、装配没给 —— 模板与代码脱节，是缺陷；
 * - `unset`：装配给了、现在确实是空的 —— 是事实，不是缺陷（`skip-empty` 靠它整段消失）。
 *
 * 两个入口，一个实现：
 *
 * - `renderSlots` 是**主入口**，返回 `{ text, issues }`（装配层要区分两种错）；
 * - `renderTemplate` 是便捷壳，只返回文本、用回调报名字（投递那两句用它）。
 *
 * 三个刻意的性质：
 *
 * 1. **不二次展开**：值里带 `{{x}}` 原样留着。否则记忆里写一句 `{{rules}}` 就能改写
 *    自己的提示词 —— 记忆是模型自己写得动的文件，那等于给了一条提权路径。
 * 2. **确定性**：纯函数，不碰时间、不碰 locale、不碰随机数；报问题的顺序只由模板决定。
 *    同一份输入必须逐字节相同，否则每轮 prompt cache 都被打穿（ADR-005）。
 * 3. **空串 = 没填**：`""` 与 `"  "` 都算没填。调用方想表达「现在没有」，要显式给
 *    「（目前没有）」这种看得见的文字，不能拿空串糊过去。
 */

/** 填不上时写这个。不写空串：空串会让一句话只剩半截，模型会自己补。 */
export const UNSET = "（未设置）";

/** 插槽的值。`undefined` = 这个事实现在没有。 */
export type SlotValue = string | number | undefined;

/** 一张插槽表。**键存在但值为空**与**键不存在**都算没填，但报出来的原因不同。 */
export type Slots = Readonly<Record<string, SlotValue>>;

/** 渲染时发现的问题。 */
export type SlotIssue = {
	readonly slot: string;
	readonly reason: "unknown" | "unset";
};

export type Rendered = {
	readonly text: string;
	/** 按**模板里首次出现**的顺序去重（不用对象键顺序，那玩意儿不保证）。 */
	readonly issues: readonly SlotIssue[];
};

/** 插槽回调：模板里出现了填不上的名字。装配层拿它 warn / 抛。 */
export type MissingHandler = (name: string) => void;

/**
 * 只认 `{{名字}}`，名字允许 `a-zA-Z0-9_.:-`。
 *
 * 允许 `:` 是为了 `{{tool:say}}` —— 契约里工具名只能这么写，别的一律自然语言。
 * 不匹配的 `{{` 原样留着，所以模板里可以写插槽语法本身，也不必转义。
 */
const SLOT = /\{\{\s*([A-Za-z0-9_.:-]+)\s*\}\}/g;

/** 一个值怎么落成文本。空串/纯空白按「没有」处理。 */
export function slotText(value: SlotValue): string {
	if (value === undefined) return UNSET;
	const text = typeof value === "number" ? String(value) : value;
	return text.trim() === "" ? UNSET : text;
}

/** 文本里出现了哪些插槽名（按首次出现，去重）。装配层靠它只填用得上的事实。 */
export function slotsIn(text: string): readonly string[] {
	const names: string[] = [];
	for (const match of text.matchAll(SLOT)) {
		const name = match[1];
		if (name !== undefined && !names.includes(name)) names.push(name);
	}
	return names;
}

/**
 * `{{tool:say}}` 这类插槽的值：**名字本身就是答案**。
 *
 * delivery 段（回话规矩、插话、沉淀指令）在投递层渲染，那里没有工具注册表可查。
 * 而 `{{tool:X}}` 的语义就是「把 X 这个工具名写出来」—— 工具改名时 seed 里那一行
 * 跟着改名，两边一致。所以这里按后缀填，不查表：宁可让写错的名字**原样出现在正文里**
 * （一眼看得见，模型会调失败再回头），也不让它渲染成「（未设置）」把一句话变成半截。
 *
 * 名字对不对由 seed 侧的检查兜（模板里的 `{{tool:X}}` 必须是真的工具名）。
 */
export function toolSlots(template: string): Record<string, string> {
	const slots: Record<string, string> = {};
	for (const name of slotsIn(template)) {
		if (name.startsWith("tool:")) slots[name] = name.slice("tool:".length);
	}
	return slots;
}

/** 这个值算不算「有」。`skip-empty` 判它，和渲染时的判据必须一致（数字 0 算有）。 */
export function hasSlot(slots: Slots, name: string): boolean {
	const value = slots[name];
	if (value === undefined) return false;
	return (typeof value === "number" ? String(value) : value).trim() !== "";
}

/**
 * 渲染一段模板。替换是**单趟**的：值里的 `{{…}}` 不会再被展开一次。
 *
 * 同一个插槽写三遍只报一次，顺序是模板里首次出现的顺序。
 */
export function renderSlots(template: string, slots: Slots): Rendered {
	const issues: SlotIssue[] = [];
	const reported = new Set<string>();

	const text = template.replace(SLOT, (_whole, name: string) => {
		if (!reported.has(name)) {
			if (!Object.hasOwn(slots, name)) {
				reported.add(name);
				issues.push({ slot: name, reason: "unknown" });
			} else if (!hasSlot(slots, name)) {
				reported.add(name);
				issues.push({ slot: name, reason: "unset" });
			}
		}
		return slotText(slots[name]);
	});

	return { text, issues };
}

/** 只要文本的便捷壳：填不上的名字走回调（不给回调就是「写（未设置）、不报」）。 */
export function renderTemplate(template: string, values: Slots, onMissing?: MissingHandler): string {
	const rendered = renderSlots(template, values);
	if (onMissing !== undefined) for (const issue of rendered.issues) onMissing(issue.slot);
	return rendered.text;
}
