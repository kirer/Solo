/**
 * 「规矩」：`<workspace>/rules.md` 的读取与排版。
 *
 * 为什么规矩是文件不是代码：规矩是**语义**，天天要改（「群里最多三句」「别用英文
 * 自言自语」都是被人骂出来的），而且改它的人不该会 TypeScript。写进 `.ts` 就等于
 * 每次调一句措辞都要重新编译、重启、走一遍发布。
 *
 * 为什么不放进技能正文：技能正文只在 `skills(action=read)` 时进上下文 —— 也就是**它必须记得
 * 去读**，而最该守规矩的那一刻恰恰是它在忙的时候。规矩每轮都要看见，所以它进提示词。
 */
import { join } from "node:path";
import { readTextOrUndefined } from "../runtime/io.ts";

/** 规矩文件（工作区根）。改名等于换契约，别改。 */
export const RULES_FILE = "rules.md";

/**
 * 读 `<workspace>/rules.md`。
 *
 * 不存在 / 读失败 / 空文件 → `undefined`（提示词里整段不出现）。宁可没有这一节，
 * 也不要一节能让模型照着自己的想象补的「（未设置）」—— 那会被它当成许可。
 */
export async function loadRules(workspaceRoot: string): Promise<string | undefined> {
	const text = await readTextOrUndefined(join(workspaceRoot, RULES_FILE));
	return text === undefined || text.trim() === "" ? undefined : text;
}

/**
 * 把规矩渲染成一节。空 → `undefined`（整段消失，不留空标题）。
 *
 * 纯函数、无时间戳、无随机量：同一份文件必须渲染出逐字节相同的字符串，否则每轮
 * system 段都变，prefix cache 全废（ADR-005）。
 */
export function renderRulesSection(text: string | undefined): string | undefined {
	if (text === undefined || text.trim() === "") return undefined;
	return `## 规矩\n\n${text.trim()}`;
}
