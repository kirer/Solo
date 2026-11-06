/**
 * 规矩必须每轮都出现在提示词里。
 *
 * 这一份测试盯的是审计里最贵的一条 bug：`seed/skills/工作规矩/SKILL.md` 写了 5766 字节的
 * 规矩，但技能正文从不进系统提示词（只进「名字 + 一句描述」），于是「先给结论」「只在叫
 * 你的频道回」这些规矩，agent 每轮一条都看不到。规矩的载体因此换成 `<workspace>/rules.md`。
 *
 * V3 起断言走 `renderAgentSection()` —— 那是**模型真会读到的那段字**（装配层用的同一个函数），
 * 不是另一个渲染器。V2 的 `agent/prompt.ts` 已删。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRules, renderRulesSection } from "../../src/core/documents/rules.ts";
import { renderAgentSection } from "../../src/core/documents/prompt.ts";
import { createRegistry } from "../../src/core/runtime/index.ts";
import { resolveLayout } from "../../src/core/layout.ts";
import { seedPromptTemplates } from "../../src/shell/seed.ts";

const RULES = [
	"- 只在叫你的那个频道回话。群里叫你就群里回，我私聊你就私聊回。",
	"- 交付前先跑一遍测试，结果写进回复里。",
].join("\n");

let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "core-rules-"));
	await mkdir(join(root, "members", "dev"), { recursive: true });
	await writeFile(
		join(root, "members", "dev", "identity.md"),
		"---\nname: 林越\ntitle: 开发\n---\n\n我写代码。\n",
		"utf8",
	);
	// 提示词模板也要播种：生产里 `main.ts` 先播种再装配。
	await seedPromptTemplates(resolveLayout({ appRoot: root, userRoot: root }));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const render = (): Promise<string> =>
	renderAgentSection(
		createRegistry(),
		{ layout: resolveLayout({ appRoot: root, userRoot: root }), chats: async () => [] },
		"dev",
	);

describe("规矩：workspace/rules.md 进提示词", () => {
	it("有 rules → 提示词里有「## 规矩」，且带上文件里的原话", async () => {
		await writeFile(join(root, "rules.md"), `${RULES}\n`, "utf8");
		const text = await render();
		expect(text).toContain("## 规矩");
		expect(text).toContain("先跑一遍测试");
		expect(text).toContain("只在叫你的那个频道回话");
	});

	it("规矩排在身份之后、能力之前（它决定怎么用能力，不是脚注）", async () => {
		await writeFile(join(root, "rules.md"), `${RULES}\n`, "utf8");
		const text = await render();
		const rulesAt = text.indexOf("## 规矩");
		expect(rulesAt).toBeGreaterThan(text.indexOf("我写代码。"));
		expect(rulesAt).toBeLessThan(text.indexOf("## 你能做的事"));
	});

	it("没有 rules → 整段消失（不留空标题）", async () => {
		expect(await render()).not.toContain("## 规矩");
		await writeFile(join(root, "rules.md"), "   \n", "utf8");
		expect(await render()).not.toContain("## 规矩");
	});

	it("同一份 rules 渲染两次逐字节相同（ADR-005 确定性）", async () => {
		await writeFile(join(root, "rules.md"), `${RULES}\n`, "utf8");
		expect(await render()).toBe(await render());
	});

	it("loadRules 读工作区根，缺文件 / 空文件 → undefined", async () => {
		expect(await loadRules(root)).toBeUndefined();
		await writeFile(join(root, "rules.md"), "  \n", "utf8");
		expect(await loadRules(root)).toBeUndefined();
		await writeFile(join(root, "rules.md"), `${RULES}\n`, "utf8");
		expect(await loadRules(root)).toContain("先跑一遍测试");
		expect(renderRulesSection(await loadRules(root))).toContain("## 规矩");
	});

	it("仓库自带的 seed/rules.md 覆盖了这些硬规矩（其中三条是硬事故）", async () => {
		const seed = await readFile(new URL("../../seed/rules.md", import.meta.url), "utf8");
		// 1. 只在该回的频道回；2. 一两句先给结论；3. 不写英文独白。
		expect(seed).toContain("只在叫你的那个频道回话");
		expect(seed).toContain("一两句");
		expect(seed).toContain("英文");
		// 拍不了板先找助理，助理再找我（ADR-091 取代「没有中间层」）；组织变动归助理（ADR-058）。
		// 要写成正文里的 `@`：只写「你」叫不醒人（ADR-060 的真机教训）。
		expect(seed).toContain("拍不了板");
		expect(seed).toContain("在正文里 @助理");
		expect(seed).toContain("助理自己拍不了再 @我");
		expect(seed).toContain("只有助理能做");
		// 「只有助理能直接找我」只对助理成立，家在助理身份里（全局规矩不写个案）。
		const assistant = await readFile(new URL("../../seed/assistant/identity.md", import.meta.url), "utf8");
		expect(assistant).toContain("@我");
	});
});

describe("密钥：写进记忆也发不出去（ADR-034 的渲染出口）", () => {
	it("memory.md 里的密钥在提示词里被换掉，明文的 key 不出现", async () => {
		const key = "sk-live-abcdef123456";
		await writeFile(join(root, ".secrets.json"), JSON.stringify({ OPENAI_API_KEY: key }), "utf8");
		// 直接写进记忆（绕过 remember 的写入脱敏）：这一道守的正是「已经写进去了」。
		await writeFile(
			join(root, "members", "dev", "memory.md"),
			`# 记忆\n\n## 2026-10-30\n用这个 key 调接口：${key}\n`,
			"utf8",
		);
		const text = await render();
		expect(text).not.toContain(key);
		expect(text).toContain("[密钥已隐藏]");
	});
});
