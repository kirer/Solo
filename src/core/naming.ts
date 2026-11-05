/**
 * 名字 → 目录名的规则，**只有这一份**。
 *
 * agent、团队、技能三种东西都是文件夹，名字都会被拼成路径（`members/<slug>/`、
 * `teams/<slug>/`、`skills/<名字>/`），而名字有一部分来自模型写的自由文本。
 * 所以「什么字符能进名字」不能各写一份 —— 三处正则稍有出入时，最松的那一处
 * 就是路径穿越的入口。
 *
 * 两个方向：
 * - `slugifyName` / `skillDirName`：把人类给的名字**清洗**成可用的目录名；
 * - `assertName` / `isSafeName`：对已经算好的名字**校验**，不合法就拒绝。
 */

import { fill, type TextCatalog } from "./documents/base/catalog.ts";

export type NameKind = "agent" | "team" | "skill";

/** 允许的字符：字母、数字（含中文）、`-`、`_`。别的一律不是名字。 */
const NAME = /^[\p{L}\p{N}_-]+$/u;

/**
 * 保留名：`owner` 是对话的另一端，不是 agent（见 `documents/member/identity.ts` 的 `OWNER_SLUG`）。
 * 写在这里而不是 import 过来，是因为 `naming.ts` 不能依赖任何领域模块。
 */
const RESERVED: Record<NameKind, readonly string[]> = {
	agent: ["owner"],
	team: [],
	skill: [],
};

/** 这个名字能直接用吗（不做清洗）。 */
export function isSafeName(value: string): boolean {
	return NAME.test(value) && value !== "." && value !== "..";
}

/** 校验一个名字；不合法抛错。错误文案是给人/模型看的。 */
export function assertName(value: string, kind: NameKind, catalog?: TextCatalog): string {
	if (!isSafeName(value) || RESERVED[kind].includes(value)) {
		const what = fill(catalog, `org.name.what.${kind}`);
		const message = fill(catalog, "org.name.invalid", { what, value });
		throw new Error(message === "" ? `invalid ${kind}: ${value}` : message);
	}
	return value;
}

/**
 * 名字 → 目录名。中文保留（`林越` → `林越`），空白与其他符号换成 `-`。
 *
 * 点号一律去掉：`.` / `..` 会让 `join(agentsRoot, slug)` 跳出 agents 目录
 * （实测 `hire(name="..")` 会把身份写到工作区根），而以点开头的目录又会被
 * `listAgentSlugs` 跳过，等于建了一个永不可见的人。
 */
export function slugifyName(name: string): string {
	const flat = name
		.trim()
		.replace(/[\s/\\:*?"<>|]+/gu, "-")
		.replace(/\.+/gu, "")
		// 剩下的非 slug 字符（`#` `@` `!` 之类）也换掉：生成出来的 slug 必须能过
		// `assertName`，否则一个奇怪的名字会让 `hire` 直接失败。
		.replace(/[^\p{L}\p{N}_-]+/gu, "-")
		.replace(/-+/gu, "-")
		.replace(/^-|-$/gu, "");
	return flat === "" ? "agent" : flat;
}

/**
 * 技能名 → 目录名。与 agent 不同，这里**替换**而不是拒绝：技能名是模型随手写的
 * 一句话，`a/b` 变成 `a-b` 比让整次写入失败有用。
 */
export function skillDirName(name: string): string {
	const clean = name.trim().replace(/[/\\]/gu, "-");
	if (clean === "" || clean === "." || clean === "..") throw new Error("技能名不能为空");
	return clean;
}
