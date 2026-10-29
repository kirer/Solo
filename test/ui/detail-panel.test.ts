/**
 * 详情面板的两块 HTML（私聊看人、群看群）。
 *
 * 和 `memory-panel.test.ts` 一样只测纯函数：`environment: "node"`，没有 jsdom。
 * 这里要盯住的是一件事 —— **界面不画后端没有的东西**（AGENTS.md 第 6 条边界）。
 * 所以断言的重点不是「长得对不对」，而是：
 *   1. 没技能就明说没有，不画空标题；没记忆同理。
 *   2. 后端给的每个字段都出现了（不然加了后端字段界面白给）。
 *   3. 用户可控的字符串（名字、标题、提示词正文）不会变成标签。
 */
import { describe, expect, it } from "vitest";
import { channelDetailHtml, personDetailHtml } from "../../ui/web/js/detail.js";

const PERSON = {
	slug: "shen-zhou",
	label: "沈舟",
	title: "前端开发",
	project: "小恐龙",
	manager: "zhiyan",
	managerLabel: "知言",
	body: "## 你负责什么\n写游戏代码。",
	skills: [{ name: "自测单文件小游戏", description: "用 vm 造假 DOM", scope: "personal", overrides: false }],
	memory: { exists: true, entries: 3, digest: "- 喜欢朴素\n- 不要紫色" },
	channels: [
		{ id: "all", kind: "company", title: "全员" },
		{ id: "proj:dino", kind: "project", title: "小恐龙" },
	],
};

describe("personDetailHtml", () => {
	it("后端给的字段全都出现在界面上", () => {
		const html = personDetailHtml(PERSON, { statusLabel: "在做" });
		for (const text of ["沈舟", "前端开发", "小恐龙", "知言", "自测单文件小游戏", "用 vm 造假 DOM", "在做"]) {
			expect(html).toContain(text);
		}
		expect(html).toContain(">全员<");
		expect(html).toContain(">3 条记忆");
		// 预置提示词走 Markdown 渲染，标题变成 <h2>
		expect(html).toContain("你负责什么");
	});

	it("没有技能 / 没有记忆就说没有，不画空块", () => {
		const html = personDetailHtml({ ...PERSON, skills: [], memory: { exists: false, entries: 0 } });
		expect(html).toContain("还没有技能");
		expect(html).toContain("还没有记忆");
		expect(html).not.toContain("detail-skill\"");
		// 「打开记忆」只在真有记忆时给按钮 —— 点进去看空列表是白跑一趟
		expect(html).not.toContain("data-open-memory");
	});

	it("没有标题/项目就不画那两个标签，也不留空的分隔", () => {
		const html = personDetailHtml({ ...PERSON, title: null, project: null });
		expect(html).not.toContain("detail-tag\">null");
		expect(html).toContain("detail-name");
	});

	it("用户可控的字串不会变成标签", () => {
		const html = personDetailHtml({
			...PERSON,
			label: "<img src=x onerror=alert(1)>",
			title: "<script>alert(1)</script>",
			channels: [{ id: "a\"><b>", kind: "dm", title: "<i>x</i>" }],
		});
		expect(html).not.toContain("<img src=x");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<i>x</i>");
	});

	it("空对象返回空串（面板不画半截）", () => {
		expect(personDetailHtml(null)).toBe("");
		expect(channelDetailHtml(null)).toBe("");
	});
});

describe("channelDetailHtml", () => {
	it("群：类型、项目、负责人、成员都画出来", () => {
		const html = channelDetailHtml(
			{ id: "proj:dino", title: "小恐龙", project: "小恐龙", ownerLabel: "林越" },
			{
				kind: "project",
				members: [{ slug: "linyue", label: "林越", title: "项目负责人" }],
				preview: "刚合了音效",
				lastAt: Date.now(),
			},
		);
		expect(html).toContain("小恐龙");
		expect(html).toContain("项目");
		expect(html).toContain("负责人 林越");
		expect(html).toContain("成员 1");
		expect(html).toContain("林越");
		expect(html).toContain("项目负责人");
	});

	it("没有成员就说还没有成员", () => {
		const html = channelDetailHtml({ id: "proj:x", title: "空项目" }, { kind: "project", members: [] });
		expect(html).toContain("还没有成员");
	});
});
