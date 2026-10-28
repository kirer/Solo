/**
 * 记忆面板的纯逻辑。
 *
 * 为什么这里没有 DOM 测试：`vitest.config.ts` 里 `environment: "node"`，全仓 29 个测试
 * 文件都是纯逻辑（`test/core/`），没有 jsdom 依赖。为了这一个面板往 devDependencies
 * 里塞 jsdom 是给整套测试加一个新环境 —— 收益只有「断言 DOM 结构」这一件事。
 * 所以界面文件 `ui/web/js/memory.js` 把可测的部分（转义 / 切段 / 筛选 / 文案）
 * 抽成纯函数导出，DOM 那半靠真浏览器看（`scripts/ui-shot.mjs`）。
 *
 * 唯一不能只靠字符串证明的（`<img onerror>` 不执行）用「转义后的字符串里不可能
 * 出现 `<`」来证明：没有尖括号就构造不出标签，也就没有事件处理器能挂上去。
 */
import { describe, expect, it } from "vitest";
import {
	MAX_ADD,
	clampAdd,
	countLabel,
	entryFilter,
	errorText,
	escapeHtml,
	forgetPrompt,
	isLongEntry,
	lineCount,
	linesOf,
	memoryMeta,
	parseEntries,
	todayHeading,
} from "../../ui/web/js/memory.js";

describe("escapeHtml：记忆是不可信模型写的", () => {
	it("把标签转成文字，注入的 <img onerror> 构造不出元素", () => {
		const hostile = '<img src=x onerror="alert(1)">';
		const safe = escapeHtml(hostile);
		expect(safe).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
		// 没有 `<` 就没有标签开始；这条是「不会被执行」的机械证明。
		expect(safe.includes("<")).toBe(false);
		expect(/<[a-zA-Z!/]/.test(safe)).toBe(false);
	});

	it("引号、单引号、& 都转 —— 同一个函数也要能安全进属性值", () => {
		expect(escapeHtml(`"'&<>`)).toBe("&quot;&#39;&amp;&lt;&gt;");
	});

	it("反引号与中文原样保留：它们在 HTML 里没有特殊含义，转了只会让正文变形", () => {
		expect(escapeHtml("`ls -la` 和 知言")).toBe("`ls -la` 和 知言");
	});

	it("null / undefined 变成空串，不是字符串 \"null\"", () => {
		expect(escapeHtml(null)).toBe("");
		expect(escapeHtml(undefined)).toBe("");
	});
});

describe("parseEntries：和后端 sectionsOf 同一条规矩", () => {
	const raw = ["# 记忆", "", "导语不算一条。", "", "## 2026-10-28", "第一条", "续行", "", "## 2026-10-29", "第二条", ""].join("\n");

	it("按 `## ` 切段，第一段导语丢掉", () => {
		expect(parseEntries(raw)).toEqual([
			{ heading: "2026-10-28", body: "第一条\n续行" },
			{ heading: "2026-10-29", body: "第二条" },
		]);
	});

	it("没有小节（只有导语 / 空文件）时是空数组", () => {
		expect(parseEntries("# 记忆\n\n还没记过。\n")).toEqual([]);
		expect(parseEntries("")).toEqual([]);
		expect(parseEntries(null)).toEqual([]);
	});

	it("空小节留一条空正文，不吞掉标题（老板要看得见它）", () => {
		expect(parseEntries("## 2026-10-28\n\n## 2026-10-29\n记了\n")).toEqual([
			{ heading: "2026-10-28", body: "" },
			{ heading: "2026-10-29", body: "记了" },
		]);
	});
});

describe("entryFilter：本地筛，不发请求", () => {
	const entries = [
		{ heading: "2026-10-28", body: "频道 id：dm:owner-知言" },
		{ heading: "2026-10-29", body: "跑 npm test 之前先 npm run check" },
	];

	it("按正文子串筛，不区分大小写", () => {
		expect(entryFilter(entries, "NPM")).toEqual([entries[1]]);
		expect(entryFilter(entries, "dm:owner")).toEqual([entries[0]]);
	});

	it("标题也参与匹配（老板可以按日期找）", () => {
		expect(entryFilter(entries, "10-29")).toEqual([entries[1]]);
	});

	it("空查询返回副本：调用方改不到原数组", () => {
		const copy = entryFilter(entries, "   ");
		expect(copy).toEqual(entries);
		expect(copy).not.toBe(entries);
	});

	it("筛不到就是空数组，不是回退成全量", () => {
		expect(entryFilter(entries, "不存在的词")).toEqual([]);
		expect(entryFilter(null, "x")).toEqual([]);
	});
});

describe("isLongEntry：超过 4 行就折", () => {
	it("4 行不折，5 行折", () => {
		expect(isLongEntry("1\n2\n3\n4")).toBe(false);
		expect(isLongEntry("1\n2\n3\n4\n5")).toBe(true);
	});

	it("没有换行的长单行也折 —— 它一样会占满页面", () => {
		expect(isLongEntry("字".repeat(181))).toBe(true);
		expect(isLongEntry("字".repeat(180))).toBe(false);
	});
});

describe("lineCount / linesOf：界面上说的「条」是行", () => {
	it("空行不算，前后空白不算", () => {
		expect(lineCount("a\n\n b \n")).toBe(2);
		expect(lineCount("")).toBe(0);
		expect(lineCount(undefined)).toBe(0);
	});

	it("空小节也算一条：标题本身是一条记录，不是零", () => {
		expect(linesOf([{ heading: "2026-10-28", body: "" }])).toBe(1);
		expect(linesOf([{ body: "a\nb" }, { body: "c" }])).toBe(3);
		expect(linesOf(null)).toBe(0);
	});
});

describe("clampAdd：300 字上限", () => {
	it("去首尾空白并截到上限", () => {
		expect(clampAdd("  记一笔  ")).toBe("记一笔");
		expect(clampAdd("字".repeat(400)).length).toBe(MAX_ADD);
		expect(MAX_ADD).toBe(300);
	});

	it("只有空白等于没写", () => {
		expect(clampAdd("   \n ")).toBe("");
	});
});

describe("todayHeading：和后端 toISOString().slice(0,10) 对齐", () => {
	it("用 UTC，不用本地时区（跨零点才不会切出两个小节）", () => {
		expect(todayHeading(new Date("2026-10-28T23:30:00Z"))).toBe("2026-10-28");
		expect(todayHeading(new Date("2026-10-29T00:30:00Z"))).toBe("2026-10-29");
	});

	it("无效时间给空串，不抛", () => {
		expect(todayHeading(new Date(Number.NaN))).toBe("");
	});
});

describe("memoryMeta：头部那行", () => {
	it("空记忆说实话", () => {
		expect(memoryMeta({ entries: [] })).toBe("还没记过东西");
		expect(memoryMeta(null)).toBe("还没记过东西");
	});

	it("有条目时给条数 + 最近那个小节（文件顺序，最新的在最后）", () => {
		expect(memoryMeta({ entries: [{ heading: "2026-10-28" }, { heading: "2026-10-29" }] })).toBe(
			"记了 2 条 · 最近 2026-10-29",
		);
	});

	it("「条」是行数不是小节数：一天记了三件事就是三条", () => {
		expect(memoryMeta({ entries: [{ heading: "2026-10-28", body: "a\nb\nc" }] })).toBe("记了 3 条 · 最近 2026-10-28");
	});

	it("小节标题不是日期也照实显示", () => {
		expect(memoryMeta({ entries: [{ heading: "关于部署" }] })).toBe("记了 1 条 · 最近 关于部署");
	});
});

describe("countLabel：筛过要说得清", () => {
	it("没筛只说总数，筛了说总数里的几条", () => {
		expect(countLabel(3, 3)).toBe("3 条");
		expect(countLabel(2, 7)).toBe("7 条中的 2 条");
		expect(countLabel(0, 0)).toBe("0 条");
	});
});

describe("forgetPrompt：后端按小节标题删，文案必须说实话", () => {
	const entries = [
		{ heading: "2026-10-28", body: "a" },
		{ heading: "2026-10-29", body: "b" },
	];

	it("普通一条就是那句固定的问法", () => {
		expect(forgetPrompt("2026-10-29", entries)).toBe("确定删掉这条？");
	});

	it("同一天有多条时说清会一起删掉（后端按 heading 删）", () => {
		const shared = [...entries, { heading: "2026-10-28", body: "c" }];
		expect(forgetPrompt("2026-10-28", shared)).toBe("确定删掉「2026-10-28」这 2 条？");
	});

	it("一个小节里挤了三行时说三条，不是一条", () => {
		expect(forgetPrompt("2026-10-28", [{ heading: "2026-10-28", body: "a\nb\nc" }])).toBe(
			"确定删掉「2026-10-28」这 3 条？",
		);
	});

	it("没数据时退回单条问法，不抛", () => {
		expect(forgetPrompt("x", undefined)).toBe("确定删掉这条？");
	});
});

describe("errorText：失败要说人话", () => {
	it("断网 / 服没起来", () => {
		expect(errorText(new TypeError("Failed to fetch"))).toBe("连不上服务，检查一下它是否还在跑。");
		expect(errorText(new Error(""))).toBe("连不上服务，检查一下它是否还在跑。");
	});

	it("后端的 {error} 原样转达（api.js 已经翻好了）", () => {
		expect(errorText(new Error("没有这一条记忆（可能已经被删掉）"))).toBe("没有这一条记忆（可能已经被删掉）");
		expect(errorText(new Error("这条记忆已经有了。"))).toBe("这条记忆已经有了。");
	});
});
