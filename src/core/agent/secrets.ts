/**
 * 密钥脱敏：**密钥永远不进提示词**。
 *
 * 这个项目没有密钥管理，也不该有 —— 一人公司不需要审批流。但 agent 手里有
 * `write_file` / `run` / `remember`，它随时可能把一把 key 写进 `memory.md`、
 * `identity.md` 或者某份 SKILL.md。那几个文件每一轮都会被渲染进 system 段，
 * 于是这把 key 就永久地、每一轮都发给模型。这是**不可逆**的泄露：写进去容易，
 * 谁也不会想到去查那里。
 *
 * 所以这里只做一件最小的事：知道哪些串是密钥，在**渲染出口**把它们换掉。
 * 不做 `.secrets.json` 的界面、不给 agent `request_secret` 工具、不做 `$SECRET_x`
 * 引用替换 —— 那都是「密钥要参与工作」的场景，而这里的目标恰恰是「密钥根本不
 * 参与对话」。要真需要某个 key，由人在 shell 里配、由 `run` 在进程里用。
 *
 * 密钥放 `<workspace>/.secrets.json`，一个扁平的 `{ "NAME": "value" }`。
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const SECRETS_FILE = ".secrets.json";

/** 太短的值不配叫密钥（也没法安全地做全文替换，会把正常字眼打碎）。 */
const MIN_LENGTH = 8;

/** 短值做边界匹配的门槛：比这短的一概要求两侧不是字母数字，避免把普通词打成马赛克。 */
const BOUNDARY_LENGTH = 16;

const REPLACEMENT = "[密钥已隐藏]";

/** 读 `<workspaceRoot>/.secrets.json` 里的全部值。文件不在、格式不对都返回空数组 —— 绝不 throw。 */
export function loadSecrets(workspaceRoot: string): readonly string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(workspaceRoot, SECRETS_FILE), "utf8"));
	} catch {
		return [];
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
	return Object.values(parsed as Record<string, unknown>).filter(
		(value): value is string => typeof value === "string" && value.length >= MIN_LENGTH,
	);
}

function escapeRe(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 造一个脱敏函数。
 *
 * 两个坑：
 * 1. **长值必须先替换** —— 否则一个长 key 会被它自己的前缀切碎，剩下的后半截照样漏出去。
 * 2. **一次 pass** —— 把所有形态拼成一个 alternation 一次 replace，而不是逐条
 *    `replace` 循环：循环里第二次替换看到的是**已经替换过的文本**，替换进去的
 *    `[密钥已隐藏]` 可能又被下一条规则咬到。
 *
 * 三种形态都要覆盖：原值、JSON 里转义后的样子（`"` → `\"`）、URL 编码后的样子
 * （agent 常常是拼 URL/拼命令的时候把它带出来的，尤其中含有 `/` `+` `=` 的 key）。
 */
export function redactor(values: readonly string[]): (text: string) => string {
	if (values.length === 0) return (text) => text;
	// 去重后按长度降序：alternation 是「左边先匹配」，顺序就是优先级。
	const ordered = [...new Set(values)].sort((left, right) => right.length - left.length);
	const shapes: string[] = [];
	for (const value of ordered) {
		const boundary = value.length < BOUNDARY_LENGTH;
		for (const shape of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]) {
			if (shape === "") continue;
			const escaped = escapeRe(shape);
			shapes.push(boundary ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped);
		}
	}
	const pattern = new RegExp([...new Set(shapes)].join("|"), "gu");
	return (text) => (text === "" ? text : text.replace(pattern, REPLACEMENT));
}

/**
 * 按 workspace 缓存脱敏函数。
 *
 * 提示词每次发送前重渲染一次，每次都重读文件、重编正则太浪费；但缓存又不能缓存到
 * 永远 —— 人新加了一个 key，得下一秒就生效。用 mtime + size 当版本号。
 */
const cache = new Map<string, { readonly stamp: string; readonly apply: (text: string) => string }>();

export function redact(text: string, workspaceRoot: string | undefined): string {
	if (workspaceRoot === undefined || text === "") return text;
	const file = join(workspaceRoot, SECRETS_FILE);
	let stamp = "absent";
	try {
		const stat = statSync(file);
		stamp = `${stat.mtimeMs}:${stat.size}`;
	} catch {
		// 没有 .secrets.json 是最常见的情况，不该每次都重试解析。
	}
	const hit = cache.get(workspaceRoot);
	if (hit !== undefined && hit.stamp === stamp) return hit.apply(text);
	const apply = redactor(loadSecrets(workspaceRoot));
	cache.set(workspaceRoot, { stamp, apply });
	return apply(text);
}
