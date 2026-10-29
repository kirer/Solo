/**
 * 「这一轮已经说过结果了」的记录。
 *
 * 为什么需要它：ds-bot 的一轮分两种话 —— 过程话（`said`，立刻发、可以多次）和
 * 结果（回合末只交一次，见 `groups.js` 的 `roomTurn` / `turns.js:532`）。我们原来
 * 没有这个区分，于是同一轮里 agent 会把结论堆成一段，或者拆成几条互相重复的汇报
 * —— 前者读起来像报告，后者读起来像刷屏。
 *
 * 拆成 `step` / `result` 之后：「一次只说一段就交棒」在代码层就有了等价物，
 * 第二句结果会被拒（并提示它改发过程话，或等下一轮）。
 *
 * 存在进程内 Map 里，是**纯建议性质**的：重启后清空只会让规则松一点（多允许一句），
 * 不会丢消息、不会让谁答不上话。所以不必落盘，也不必跨进程同步。
 */
const spoken = new Map<number, string>();

/** 记下这一轮已经说过的结果全文（拒第二句时要把开头还给它看，否则它不知道为什么被拒）。 */
export function markSpoken(conversationId: number, text: string): void {
	spoken.set(conversationId, text);
}

/** 这一轮已经说过的结果；没说过是 undefined。 */
export function spokenResult(conversationId: number): string | undefined {
	return spoken.get(conversationId);
}

/**
 * 新一轮开始：别人叫它了，它又可以重新说一句结果。
 *
 * 由 `deliver()` 在提交输入之前调用 —— 投递是「一轮」的唯一入口，
 * 放在别处（比如 `say` 里按时间过期）会让「一轮」的定义变成猜测。
 */
export function clearSpoken(conversationId: number): void {
	spoken.delete(conversationId);
}
