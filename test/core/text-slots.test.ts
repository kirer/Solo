/**
 * 插槽语义：**未知插槽不许静默变空**（`docs/design/SEED-CONTRACT.md` §3 硬规矩 1）。
 *
 * 静默变空为什么是硬 bug：模板里写「你的上级：{{manager}}」，manager 拼错一个字母，
 * 模型看到的就是「你的上级：」—— 一句话只剩半截。它不会报错，只会照着上下文补一个
 * 听起来合理的答案（V2 实测补出过不存在的汇报线）。
 *
 * 这里**只经 `renderPrompt` 测行为**，不直接测 `text.ts` 的渲染函数：那个函数在施工期间
 * 换过名字（`renderSlots` / `renderTemplate`），而契约约束的是「模型最终看到什么、装配层
 * 收到什么」，不是内部函数叫什么。判据只有两条：
 *
 * - 文本里出现看得见的「（未设置）」，不许留 `{{...}}`、不许变空；
 * - 问题里区分 `unknown`（模板写了、装配没给 → 改代码）与 `unset`（给了、现在为空 → 事实）。
 */
import { describe, expect, it } from "vitest";
import { parseTemplate, renderPrompt } from "../../src/core/md/prompt.ts";
import { hasSlot, slotText, type Slots } from "../../src/core/md/text.ts";

/** 契约里写死的那个字面量。测试钉字面量，不钉符号名（符号改过名）。 */
const NOT_SET = "（未设置）";

/** 一段模板 + 一张插槽表 → 渲染结果。走的是装配层真正用的那条路。 */
function render(body: string, slots: Slots): { text: string; issues: readonly string[] } {
	const rendered = renderPrompt([parseTemplate("10-x.md", body)], slots);
	return {
		text: rendered.text,
		issues: rendered.issues.map((issue) => `${issue.reason}:${issue.slot}`),
	};
}

describe("插槽：填得进去", () => {
	it("已知插槽换成值", () => {
		expect(render("你叫{{self.name}}。", { "self.name": "林越" }).text).toBe("你叫林越。");
	});

	it("同一个插槽出现几次都换（不是只换第一处）", () => {
		const { text } = render("{{self.name}} 负责前端；{{self.name}} 的上级是{{manager}}。", {
			"self.name": "林越",
			manager: "我",
		});
		expect(text).toBe("林越 负责前端；林越 的上级是我。");
	});

	it("插槽名可以带点、冒号、下划线（self.name / tool:say）", () => {
		expect(render("{{tool:say}}", { "tool:say": "say" }).text).toBe("say");
		expect(render("{{self.slug}}", { "self.slug": "lin" }).text).toBe("lin");
		expect(render("{{team.brief}}", { "team.brief": "做网页" }).text).toBe("做网页");
	});

	it("括号里带空格也认（{{ self.name }}）", () => {
		expect(render("{{ self.name }}", { "self.name": "林越" }).text).toBe("林越");
	});

	it("数字插槽渲染成十进制（{{count}}）", () => {
		expect(render("全员 {{count}} 个 agent。", { count: 3 }).text).toBe("全员 3 个 agent。");
	});

	it("没有插槽的文本原样返回（落单的括号也不许吃掉）", () => {
		const text = "普通的一句话，带一个 { 和 } 还有 {{ 未闭合。";
		expect(render(text, {})).toEqual({ text, issues: [] });
	});
});

describe("插槽：填不进去时必须看得见", () => {
	it("未知插槽 → 「（未设置）」，不留 {{...}}", () => {
		const { text } = render("你的上级：{{boss}}", {});
		expect(text).toBe(`你的上级：${NOT_SET}`);
		expect(text).not.toContain("{{");
	});

	it("未知插槽报 unknown（模板写了、装配没给）", () => {
		expect(render("{{a}}{{b}}", { a: "甲" }).issues).toEqual(["unknown:b"]);
	});

	it("值是 undefined → 报 unset，不是 unknown", () => {
		expect(render("你的上级：{{manager}}", { manager: undefined })).toEqual({
			text: `你的上级：${NOT_SET}`,
			issues: ["unset:manager"],
		});
	});

	it("值是空串 → 也算没填（空串同样是半句话）", () => {
		expect(render("向你汇报的人：{{reports}}", { reports: "" })).toEqual({
			text: `向你汇报的人：${NOT_SET}`,
			issues: ["unset:reports"],
		});
	});

	it("值是纯空白 → 也算没填", () => {
		expect(render("{{reports}}", { reports: "  \n\t" })).toEqual({ text: NOT_SET, issues: ["unset:reports"] });
	});

	it("同一个插槽写三遍只报一次（不是每处报一遍）", () => {
		expect(render("{{x}}/{{x}}/{{x}}", {}).issues).toEqual(["unknown:x"]);
	});

	it("两种错同时出现时都要报（一个改代码，一个是事实）", () => {
		expect(render("{{a}}{{b}}", { b: undefined }).issues).toEqual(["unknown:a", "unset:b"]);
	});
});

describe("插槽：不许二次展开", () => {
	it("值里带 {{...}} 不递归渲染（否则记忆里一句话就能改写提示词）", () => {
		// 记忆是模型自己写得动的文件：能二次展开就等于给它一条改写自己提示词的路径。
		const { text } = render("{{memory}}", { memory: "他写了 {{rules}}", rules: "- 我是规矩" });
		expect(text).toBe("他写了 {{rules}}");
	});
});

describe("插槽：确定性", () => {
	it("同一份输入渲染两次逐字节相同（ADR-005，否则 prompt cache 每轮打穿）", () => {
		const body = "{{self.name}} / {{manager}} / {{chain}} / {{tool:say}}";
		const slots = { "self.name": "林越", manager: "我", chain: "我", "tool:say": "say" };
		expect(render(body, slots).text).toBe(render(body, slots).text);
	});

	it("问题顺序只由模板顺序决定（不靠对象键顺序）", () => {
		expect(render("{{b}}{{a}}", {}).issues).toEqual(["unknown:b", "unknown:a"]);
	});
});

describe("hasSlot / slotText：装配层判「有没有」的唯一口径", () => {
	it("undefined / 空串 / 纯空白 = 没有", () => {
		expect(hasSlot({}, "x")).toBe(false);
		expect(hasSlot({ x: undefined }, "x")).toBe(false);
		expect(hasSlot({ x: "" }, "x")).toBe(false);
		expect(hasSlot({ x: " \n" }, "x")).toBe(false);
	});

	it("有字面内容 = 有（数字 0 也算有，它不是空）", () => {
		expect(hasSlot({ x: "甲" }, "x")).toBe(true);
		expect(hasSlot({ x: 0 }, "x")).toBe(true);
	});

	it("slotText 把「没有」统一落成同一个字面量，调用方不用各写一份兜底", () => {
		expect(slotText(undefined)).toBe(NOT_SET);
		expect(slotText("")).toBe(NOT_SET);
		expect(slotText("  ")).toBe(NOT_SET);
		expect(slotText("甲")).toBe("甲");
		expect(slotText(0)).toBe("0");
	});
});
