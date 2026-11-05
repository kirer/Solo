/**
 * 代码里不许再有模型看得见的中文。
 *
 * 这一条是「文案外置」的闸：工具的 description、参数说明、拒绝话术、投递头、附件说明、
 * 提示词兜底句，全部住在 `seed/text/*.md`。留一句在代码里，就等于又多了一个家 ——
 * 改文案要动 TS、要重跑测试，而且 `prompt:check` 看不见它。
 *
 * 白名单只有三类：
 * 1. `console.*` / `throw new Error(...)`：运维诊断，不是给模型看的；
 * 2. 渲染哨兵（`md/text.ts` 的 `（未设置）`、`agent/secrets.ts` 的 `[密钥已隐藏]`）；
 * 3. 显示名的默认值（没有文件名的附件叫「附件」、owner 的显示名叫「我」）。
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** 文案外置点名的模块。加一个模块改了文案，就把它加进来。 */
const MODULES = [
	"src/core/channel/tools/say.ts",
	"src/core/channel/tools/chats.ts",
	"src/core/channel/tools/history.ts",
	"src/core/channel/tools/remember.ts",
	"src/core/channel/tools/hire.ts",
	"src/core/channel/tools/run.ts",
	"src/core/channel/tools/file.ts",
	"src/core/channel/tools/context.ts",
	"src/core/channel/tools/channel-choice.ts",
	"src/core/channel/tools/recall.ts",
	"src/core/channel/tools/guards.ts",
	"src/core/channel/delivery.ts",
	"src/core/channel/attachments.ts",
	"src/core/channel/unanswered.ts",
	"src/core/channel/post.ts",
	"src/core/flow/publish.ts",
	"src/core/flow/forward.ts",
	"src/core/flow/runner.ts",
	"src/core/flow/policies.ts",
	"src/core/agent/sections.ts",
	"src/core/agent/memory.ts",
	"src/core/agent/identity.ts",
	"src/core/team/doc.ts",
	"src/core/team/memory.ts",
	"src/core/naming.ts",
];

/** 按行放行：这一行上的中文不是「给模型的一句话」。 */
const ALLOWED = [
	"console.",
	"process.stderr.write",
	// 多行日志的续行：前缀已经说明了它是 stderr。
	"`[core] ",
	"`[沉淀] ",
	"`[flow] ",
	"`[投递失败] ",
	"`[投递通报失败] ",
	"`[wake] ",
	"throw new Error",
	// 上传超限的异常文案：走 HTTP 错误码，不是给模型的。
	"super(`附件超过上限",
	// 附件没有文件名时的兜底显示名。
	'capped === "" ? "附件"',
	// owner 的显示名（名册与界面共用，不是一句提示词）。
	'return "我";',
];

const CJK = /[一-龥]/;

/** 这一行是不是注释（`//`、`*`、`/*`）。注释里的中文是写给人的，不算。 */
function isComment(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

describe("代码里不留模型看得见的文案", () => {
	it("点名的模块里没有中文字符串字面量（注释与白名单除外）", async () => {
		const offenders: string[] = [];
		for (const file of MODULES) {
			const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
			source.split("\n").forEach((line, index) => {
				if (isComment(line) || !CJK.test(line)) return;
				if (ALLOWED.some((allowed) => line.includes(allowed))) return;
				// 只看「字符串里的中文」：行里有引号或模板串，才算文案。
				if (!/["'`]/.test(line)) return;
				offenders.push(`${file}:${index + 1} ${line.trim()}`);
			});
		}
		expect(offenders, `这些句子该搬进 seed/text/*.md：\n${offenders.join("\n")}`).toEqual([]);
	});
});
