/**
 * 提示词装配：**一个 md = 一段 = 一个 cache section**（`SEED-CONTRACT.md` §4 硬规矩 3）。
 *
 * 这里钉三件 V2 用 353 行代码硬编码才换来、V3 想用「读文件 + 填插槽 + 排序」换来的性质：
 *
 * 1. **顺序只由文件名前缀决定**。允许「取决于 readdir 怎么排」就等于允许提示词每台机器不一样，
 *    而 prompt cache 是按字节命中的。
 * 2. **同一组文件两次渲染逐字节相同**（ADR-005）。这条一旦破，每轮都按全价重算。
 * 3. **段与插槽对不上要看得见**：`skip-empty` 的插槽装配漏给，报 `unknown`；填不上写
 *    「（未设置）」，不许出现「## 规矩」下面空一片。
 *
 * 另外守一条**文档与代码一致**：模板里用的插槽必须登记在契约 §4 的插槽表里。契约是插槽
 * 名字唯一的家；表里没有的名字，写模板的人只能靠猜。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SAMPLE_SLOTS } from "../../scripts/prompt-fixture.ts";
import { createFsx } from "../../src/core/fsx.ts";
import { loadTemplates, parseTemplate, renderPrompt, renderPromptDir, type PromptTemplate } from "../../src/core/md/prompt.ts";
import { UNSET } from "../../src/core/md/text.ts";

const SEED = fileURLToPath(new URL("../../seed/", import.meta.url));
const CONTRACT = fileURLToPath(new URL("../../docs/design/SEED-CONTRACT.md", import.meta.url));

const SAMPLE = SAMPLE_SLOTS as unknown as Readonly<Record<string, string | number | undefined>>;

/** 模板正文里出现的插槽名（按首次出现排序）。 */
function slotsIn(text: string): readonly string[] {
	const names = [...text.matchAll(/\{\{\s*([A-Za-z0-9_.:-]+)\s*\}\}/g)].map((match) => match[1] ?? "");
	return [...new Set(names)];
}

/** 契约 §4 插槽表里登记的名字。 */
function documentedSlots(markdown: string): ReadonlySet<string> {
	const start = markdown.indexOf("## 4.");
	const end = markdown.indexOf("## 5.");
	const section = markdown.slice(start, end < 0 ? undefined : end);
	return new Set([...section.matchAll(/\{\{\s*([A-Za-z0-9_.:-]+)\s*\}\}/g)].map((match) => match[1] ?? ""));
}

let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "core-prompt-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function write(rel: string, text: string): Promise<void> {
	const target = join(root, rel);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, text, "utf8");
}

describe("parseTemplate：文件名就是段序", () => {
	it("`10-rules.md` → order 10 / segment rules / use system", () => {
		const template = parseTemplate("10-rules.md", "## 规矩\n\n{{rules}}\n");
		expect(template.order).toBe(10);
		expect(template.segment).toBe("rules");
		expect(template.use).toBe("system");
		expect(template.skipEmpty).toBeUndefined();
		expect(template.body).toBe("## 规矩\n\n{{rules}}");
	});

	it("头里可以覆盖段名、声明用途、声明空则消失", () => {
		const template = parseTemplate("80-reply.md", "---\nsegment: reply\nuse: delivery\nskip-empty: rules\n---\n\n正文\n");
		expect(template.segment).toBe("reply");
		expect(template.use).toBe("delivery");
		expect(template.skipEmpty).toBe("rules");
		expect(template.body).toBe("正文");
	});

	it("文件名不合规就抛（顺序是语义，不许乱名）", () => {
		for (const file of ["rules.md", "10_rules.md", "10-Rules.md", "abc.md", "10-rules.txt"]) {
			expect(() => parseTemplate(file, "x"), file).toThrow();
		}
	});

	it("use 只认 system / delivery", () => {
		expect(() => parseTemplate("10-x.md", "---\nuse: other\n---\nx")).toThrow();
	});

	it("段名必须是小写 kebab-case", () => {
		expect(() => parseTemplate("10-x.md", "---\nsegment: Rules\n---\nx")).toThrow();
	});
});

describe("loadTemplates：排序与去重", () => {
	it("从 seed/prompt 读到的顺序由前缀决定", async () => {
		const templates = await loadTemplates(createFsx(SEED), "prompt");
		expect(templates.map((template) => template.file)).toEqual([
			"00-who.md",
			"05-body.md",
			"10-rules.md",
			"20-position.md",
			"30-team.md",
			"40-tools.md",
			"50-memory.md",
			"60-skills.md",
			"70-directory.md",
			"80-reply.md",
			"81-alone.md",
			"82-shared.md",
			"83-colleagues.md",
			"84-dm.md",
			"85-multi.md",
			"86-digest.md",
			"87-merged.md",
			"88-task.md",
			"90-interrupted.md",
			"95-settle.md",
		]);
	});

	it("前缀相同时按文件名排（不许取决于 readdir 顺序）", async () => {
		await write("prompt/10-b.md", "b");
		await write("prompt/10-a.md", "a");
		const templates = await loadTemplates(createFsx(root), "prompt");
		expect(templates.map((template) => template.file)).toEqual(["10-a.md", "10-b.md"]);
	});

	it("段名重复直接抛（两段同名 = 一段悄悄不生效）", async () => {
		await write("prompt/10-x.md", "一");
		await write("prompt/20-x.md", "二");
		await expect(loadTemplates(createFsx(root), "prompt")).rejects.toThrow(/段名重复/);
	});

	it("非 .md 文件不算模板", async () => {
		await write("prompt/10-x.md", "一");
		await write("prompt/notes.txt", "不是模板");
		expect((await loadTemplates(createFsx(root), "prompt")).map((template) => template.file)).toEqual(["10-x.md"]);
	});

	it("目录不存在 = 空（缺席是常态，不是错误）", async () => {
		expect(await loadTemplates(createFsx(root), "prompt")).toEqual([]);
	});
});

const template = (file: string, body: string): PromptTemplate => parseTemplate(file, body);

describe("renderPrompt：拼段", () => {
	it("按 order 拼，段之间一个空行，结尾不带换行", () => {
		const rendered = renderPrompt([template("20-b.md", "乙"), template("10-a.md", "甲")], {});
		expect(rendered.text).toBe("甲\n\n乙");
		expect(rendered.segments.map((segment) => segment.segment)).toEqual(["a", "b"]);
	});

	it("delivery 段不进系统提示词", () => {
		const rendered = renderPrompt(
			[template("10-a.md", "甲"), template("80-reply.md", "---\nuse: delivery\n---\n回话规矩")],
			{},
		);
		expect(rendered.text).toBe("甲");
		expect(rendered.delivery).toEqual({ reply: "回话规矩" });
	});

	it("skip-empty：插槽为空 → 整段消失，不留空标题也不留「（未设置）」", () => {
		const rules = template("10-rules.md", "---\nskip-empty: rules\n---\n## 规矩\n\n{{rules}}");
		const rendered = renderPrompt([rules], { rules: "" });
		expect(rendered.segments).toEqual([]);
		expect(rendered.text).toBe("");
		expect(rendered.text).not.toContain(UNSET);
	});

	it("skip-empty：插槽有值 → 正常出现", () => {
		const rules = template("10-rules.md", "---\nskip-empty: rules\n---\n## 规矩\n\n{{rules}}");
		expect(renderPrompt([rules], { rules: "- 说话短。" }).text).toBe("## 规矩\n\n- 说话短。");
	});

	it("skip-empty 的插槽装配根本没给 → 报 unknown（装配漏了，不是事实为空）", () => {
		const rules = template("10-rules.md", "---\nskip-empty: rules\n---\n{{rules}}");
		expect(renderPrompt([rules], {}).issues).toEqual([{ slot: "rules", reason: "unknown" }]);
	});

	it("模板里的未知插槽：文本里看得见，问题里报出来", () => {
		const rendered = renderPrompt([template("10-a.md", "上级：{{boss}}")], {});
		expect(rendered.text).toBe(`上级：${UNSET}`);
		expect(rendered.issues).toEqual([{ slot: "boss", reason: "unknown" }]);
	});

	it("问题跨段去重（同一段插槽错一次就够，别每段报一遍）", () => {
		const rendered = renderPrompt([template("10-a.md", "{{x}}"), template("20-b.md", "{{x}}")], {});
		expect(rendered.issues).toEqual([{ slot: "x", reason: "unknown" }]);
	});

	it("空正文的段不占位置", () => {
		expect(renderPrompt([template("10-a.md", "甲"), template("20-b.md", "  \n")], {}).text).toBe("甲");
	});

	it("只改一个插槽 → 只有那一段的正文变（缓存的最小 patch 才不会整块重写）", () => {
		// 这条是从 V2 的 `prompt-segments.test.ts` 搬过来的唯一有价值的断言：分段的全部意义
		// 就是「只有真的变了的段失效」。段一变就整块重写，prompt cache 每轮都白算。
		const templates = [
			template("10-a.md", "甲：{{self.name}}"),
			template("20-b.md", "乙：{{count}}"),
			template("30-c.md", "丙：{{manager}}"),
		];
		const before = renderPrompt(templates, { "self.name": "林越", count: 3, manager: "我" });
		const after = renderPrompt(templates, { "self.name": "林越", count: 4, manager: "我" });
		const changed = after.segments.filter((segment, index) => segment.text !== before.segments[index]?.text);
		expect(changed.map((segment) => segment.segment)).toEqual(["b"]);
	});

	it("同一组模板渲染两次逐字节相同（ADR-005）", () => {
		const templates = [template("10-a.md", "{{self.name}}"), template("20-b.md", "{{count}}")];
		const slots = { "self.name": "林越", count: 3 };
		expect(renderPrompt(templates, slots).text).toBe(renderPrompt(templates, slots).text);
	});
});

describe("seed/prompt 真实渲染（契约 §6 的 prompt:check，测试版）", () => {
	it("样例插槽表能填满：未知插槽 0 个", async () => {
		const rendered = await renderPromptDir(createFsx(SEED), SAMPLE, "prompt");
		const unknown = rendered.issues.filter((issue) => issue.reason === "unknown");
		expect(unknown, "模板与样例表脱节：模板写了没人给").toEqual([]);
	});

	it("渲染结果里没有残留的 {{ 和「（未设置）」", async () => {
		const rendered = await renderPromptDir(createFsx(SEED), SAMPLE, "prompt");
		expect(rendered.text).not.toContain("{{");
		expect(rendered.text).not.toContain(UNSET);
	});

	it("系统段 9 段 + 投递段 11 段（回话片段全部来自 md）", async () => {
		const rendered = await renderPromptDir(createFsx(SEED), SAMPLE, "prompt");
		expect(rendered.segments.map((segment) => segment.segment)).toEqual([
			"who",
			"body",
			"rules",
			"position",
			"team",
			"tools",
			"memory",
			"skills",
			"directory",
		]);
		expect(Object.keys(rendered.delivery).sort()).toEqual([
			"alone",
			"colleagues",
			"digest",
			"dm",
			"interrupted",
			"merged",
			"multi",
			"reply",
			"settle",
			"shared",
			"task",
		]);
	});

	it("两次渲染逐字节相同（整组文件，真实 seed）", async () => {
		const first = await renderPromptDir(createFsx(SEED), SAMPLE, "prompt");
		const second = await renderPromptDir(createFsx(SEED), SAMPLE, "prompt");
		expect(first.text).toBe(second.text);
		expect(JSON.stringify(first.segments)).toBe(JSON.stringify(second.segments));
	});

	it("整句插槽（reply.*）只许出现在 delivery 段（契约 §4 硬规矩 4）", async () => {
		// `reply.alone` / `reply.colleagues` 是**条件句**（这一轮只有你被叫醒 / 还有别人在），
		// 不是事实值。放进系统提示词就得给 md 发明一套条件语法，所以只许进投递段。
		const templates = await loadTemplates(createFsx(SEED), "prompt");
		const bad: string[] = [];
		for (const item of templates) {
			for (const slot of slotsIn(item.body)) {
				if (slot.startsWith("reply.") && item.use !== "delivery") bad.push(`${item.file}（${item.use}）：{{${slot}}}`);
			}
		}
		expect(bad, `整句插槽只许进 80-reply / 90-interrupted：\n${bad.join("\n")}`).toEqual([]);
	});

	it("模板用到的插槽都登记在契约 §4 的插槽表里", async () => {
		const markdown = await import("node:fs/promises").then(({ readFile }) => readFile(CONTRACT, "utf8"));
		const documented = documentedSlots(markdown);
		const templates = await loadTemplates(createFsx(SEED), "prompt");
		const used = templates.flatMap((item) => slotsIn(item.body));
		const undocumented = [...new Set(used)].filter((slot) => !documented.has(slot) && !/^tool:/.test(slot));
		expect(
			undocumented,
			`契约 §4 没有登记这些插槽，写模板的人只能猜：${undocumented.join("、")}\n` +
				"补进 §4 的插槽表（值 + 来源），或者从模板里删掉。",
		).toEqual([]);
	});
});
