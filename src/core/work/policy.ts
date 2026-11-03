/**
 * 策略：`<userRoot>/policy.md` **就是**那套派活的判据。
 *
 * 为什么是 md 而不是配置项：这套东西天天改，改它的人是「我」，不是开发者。写在代码里
 * 意味着每改一条规矩都要重新部署；写成 md，存盘就生效，而且模型和人都读同一份 ——
 * 提示词里贴的是它，闸门判的也是它，不会出现「说的是这样、做的是那样」。
 *
 * 文件形状（`##` 小节是名单，`# 规矩` 下面的 `##` 是规矩）：
 *
 * ```md
 * ---
 * mode: observe
 * ---
 *
 * # 谁能派活
 *
 * ## 明确 @ 我 / 私聊
 * - 所有人
 *
 * ## 不 @ 也能派
 * - owner
 *
 * # 规矩
 *
 * ## 改代码先跑测试
 * 改完要跑 `npm test`。
 * ```
 *
 * 解析是**宽容**的：没有文件 = 默认策略（只认明说的）；写坏的小节跳过而不是抛错 ——
 * 一份写歪的 md 不该让整个服务起不来。但**版本号**对全文取哈希，写歪也看得见版本变了。
 */
import { parseDoc } from "../md/doc.ts";
import { readTextOrUndefined } from "../runtime/io.ts";
import type { AcceptMode, Policy } from "./types.ts";

/** 默认策略：只认明说的（@ 我 / 私聊 / 追问）。 */
export const DEFAULT_POLICY: Policy = {
	mode: "off",
	version: "default",
	addressed: ["*"],
	inferred: [],
};

const MODES: readonly AcceptMode[] = ["off", "observe", "auto"];

/**
 * 内容版本：FNV-1a 的 32 位十六进制。
 *
 * 不用 `crypto`：版本要**确定性**、要能在纯函数测试里算，而且它只要「改了就变」，
 * 不需要抗碰撞。8 位够用，撞了也只是多一次重校验。
 */
export function policyVersion(source: string): string {
	let hash = 0x811c9dc5;
	const bytes = new TextEncoder().encode(source.replace(/\r\n/g, "\n").trim());
	for (const byte of bytes) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 解析一份策略正文。纯函数：给什么算什么，不读盘。 */
export function parsePolicy(source: string): Policy {
	const doc = parseDoc("policy.md", source);
	const raw = (doc.front["mode"] ?? "").trim().toLowerCase();
	const mode: AcceptMode = MODES.includes(raw as AcceptMode) ? (raw as AcceptMode) : DEFAULT_POLICY.mode;

	let section: "addressed" | "inferred" | undefined;
	const addressed: string[] = [];
	const inferred: string[] = [];

	for (const line of doc.body.split("\n")) {
		const heading = /^(#{1,2})\s+(.+?)\s*$/.exec(line);
		if (heading !== null) {
			const level = heading[1]?.length ?? 1;
			const title = heading[2] ?? "";
			if (level === 1) {
				// 一级标题选段落。别的标题把上下文清掉（写到别处去的字不算数）。
				section = title.includes("派活") ? "addressed" : undefined;
			} else if (section !== undefined && title.includes("不")) {
				// `## 不 @ 也能派` 与 `## 明确 @ 我`：谁不需要点名也能派。
				section = "inferred";
			} else if (section !== undefined) {
				section = "addressed";
			}
			continue;
		}
		const item = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
		if (item === null) continue;
		const name = (item[1] ?? "").replace(/^`|`$/g, "").trim();
		if (name === "") continue;
		if (section === "inferred") inferred.push(name);
		else if (section === "addressed") addressed.push(name === "所有人" ? "*" : name);
	}
	return {
		mode,
		version: policyVersion(source),
		addressed: addressed.length === 0 ? [...DEFAULT_POLICY.addressed] : [...new Set(addressed)],
		inferred: [...new Set(inferred)],
	};
}

/** 读策略。文件不在就用默认策略（不是错误：没写就是「只认明说的」）。 */
export async function readPolicy(path: string): Promise<Policy> {
	const source = await readTextOrUndefined(path);
	return source === undefined ? DEFAULT_POLICY : parsePolicy(source);
}

/** 这份策略允不允许这个人说话算数。 */
export function allows(list: readonly string[], who: string): boolean {
	return list.includes("*") || list.includes(who);
}

/**
 * 把策略渲染成提示词里的一段。
 *
 * 逐行照抄人写的样子，只补上「现在是哪种模式」。**代码不替人组织语言** ——
 * 规则是人写的，模型读到的就是原文。
 */
export function renderPolicy(policy: Policy): string {
	// 只给人话，不写 `off` / `observe` 这种词：模型会把「模式：off」读成「工单关掉了」。
	const mode =
		policy.mode === "auto"
			? "点名和按规矩推出来的活都接"
			: policy.mode === "observe"
				? "点名的活接；按规矩推出来的只记下来，不动手"
				: "只接点名的活（@ 我 / 私聊 / 跟着既有工单追问）";
	const lines = [`模式：${mode}`, ""];
	lines.push(`明着派活的人：${policy.addressed.join("、") || "（无）"}`);
	lines.push(`不 @ 也能派活的人：${policy.inferred.join("、") || "（无）"}`);
	return lines.join("\n");
}
