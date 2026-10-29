/**
 * 规矩必须每轮都出现在提示词里。
 *
 * 这一份测试盯的是审计里最贵的一条 bug：`seed/skills/工作规矩/SKILL.md` 写了 5766 字节的
 * 规矩，但技能正文从不进系统提示词（只进「名字 + 一句描述」），于是「先给结论」「只在叫
 * 你的频道回」这些规矩，agent 每轮一条都看不到。规矩的载体因此换成 `<workspace>/rules.md`。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRules, renderRulesSection } from "../../src/core/agent/rules.ts";
import { renderAgentPrompt } from "../../src/core/agent/prompt.ts";
import type { Identity } from "../../src/core/agent/identity.ts";

const RULES = [
	"- 只在叫你的那个频道回话。群里叫你就群里回，老大私聊你就私聊回。",
	"- 群里一条消息最多 3 句。汇报先给结论一句话，再给要点。",
].join("\n");

const self: Identity = {
	slug: "dev",
	name: "林越",
	title: "开发",
	manager: "owner",
	body: "我写代码。",
	dir: "/tmp/x/agents/dev",
};
const all: readonly Identity[] = [self];

let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "core-rules-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("规矩：workspace/rules.md 进提示词", () => {
	it("有 rules → 提示词里有「## 规矩」，且带上文件里的原话", () => {
		const text = renderAgentPrompt({ self, all, rules: RULES });
		expect(text).toContain("## 规矩");
		expect(text).toContain("3 句");
		expect(text).toContain("只在叫你的那个频道回话");
	});

	it("规矩排在身份之后、能力之前（它决定怎么用能力，不是脚注）", () => {
		const text = renderAgentPrompt({
			self,
			all,
			rules: RULES,
			capabilities: [{ name: "say", summary: "在频道里说一句" }],
		});
		const rulesAt = text.indexOf("## 规矩");
		expect(rulesAt).toBeGreaterThan(text.indexOf("我写代码。"));
		expect(rulesAt).toBeLessThan(text.indexOf("## 你能做的事"));
	});

	it("没有 rules → 整段消失（不留空标题）", () => {
		expect(renderAgentPrompt({ self, all })).not.toContain("## 规矩");
		expect(renderAgentPrompt({ self, all, rules: "   \n" })).not.toContain("## 规矩");
	});

	it("同一份 rules 渲染两次逐字节相同（ADR-005 确定性）", () => {
		const input = { self, all, rules: RULES } as const;
		expect(renderAgentPrompt(input)).toBe(renderAgentPrompt(input));
	});

	it("loadRules 读工作区根，缺文件 / 空文件 → undefined", async () => {
		expect(await loadRules(root)).toBeUndefined();
		await writeFile(join(root, "rules.md"), "  \n", "utf8");
		expect(await loadRules(root)).toBeUndefined();
		await writeFile(join(root, "rules.md"), `${RULES}\n`, "utf8");
		expect(await loadRules(root)).toContain("3 句");
		expect(renderRulesSection(await loadRules(root))).toContain("## 规矩");
	});

	it("仓库自带的 seed/rules.md 覆盖了八条规矩（其中三条是硬事故）", async () => {
		const seed = await readFile(new URL("../../seed/rules.md", import.meta.url), "utf8");
		// 1. 只在该回的频道回；2. 群里最多 3 句；6. 不写英文独白。
		expect(seed).toContain("只在叫你的那个频道回话");
		expect(seed).toContain("3 句");
		expect(seed).toContain("英文");
		// 3. 拿不准问老大；4. 先说要去找谁；5. 拍板用 @老大。
		expect(seed).toContain("问老大");
		expect(seed).toContain("我要去问 X 关于 Y");
		expect(seed).toContain("@owner");
	});
});
