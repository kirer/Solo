/**
 * 文案目录的升级：按**键**同步 —— 没改过的跟到新版，改过的留着，缺的追加。
 *
 * 这一条挡的是两件事：
 * 1. 「新文案永远进不了老工作区」—— 工具描述会变成空串，模型看不见约束；
 * 2. 「改过的措辞被出厂文案盖掉」—— 文案是模型每轮都读的话，我可能亲手改过。
 *
 * 2026-11-08 实测踩的是第一种的变体：键在，但值改了，老工作区永远读旧句（ADR-114）。
 */
import { describe, expect, it } from "vitest";
import { mergeCatalog, parseCatalog } from "../../src/core/documents/base/catalog.ts";

const SEED = `# 文案

## say.description
在频道里说话。

## say.param.options
要我选：2–6 个选项。只在你直接问我时用。
`;

const hash = (value: string): string => `h:${value}`;

/** 账本里没有这条、也不是历史出厂内容 = 用户改过。 */
const noLegacy = (): boolean => false;

function merge(current: string, seeded: ReadonlyMap<string, string> = new Map(), legacy = noLegacy) {
	return mergeCatalog(current, SEED, { seeded, legacy, hash });
}

describe("mergeCatalog", () => {
	it("缺的键追加到末尾，已有的原样", () => {
		const current = "# 我改过的文案\n\n## say.description\n我自己改的措辞。\n";
		const merged = merge(current);
		expect(merged).toBeDefined();
		const keys = parseCatalog("merged", merged!.text);
		expect(keys.get("say.description")).toBe("我自己改的措辞。");
		expect(keys.get("say.param.options")).toBe("要我选：2–6 个选项。只在你直接问我时用。");
	});

	it("一个键都不缺、值也一样：不写盘", () => {
		expect(merge(SEED)).toBeUndefined();
	});

	it("账本记着上次写进去的就是旧值 → 没改过，升到新版", () => {
		const old = "要我选：2–6 个选项。";
		const current = SEED.replace("要我选：2–6 个选项。只在你直接问我时用。", old);
		const merged = merge(current, new Map([["say.param.options", hash(old)]]));
		expect(parseCatalog("merged", merged!.text).get("say.param.options")).toBe(
			"要我选：2–6 个选项。只在你直接问我时用。",
		);
		// 账本跟着升到新值
		expect(merged!.seeded.get("say.param.options")).toBe(hash("要我选：2–6 个选项。只在你直接问我时用。"));
	});

	it("账本对不上（用户改过）→ 一个字不动，也不记账", () => {
		const current = SEED.replace("要我选：2–6 个选项。只在你直接问我时用。", "我自己写的选项说明。");
		const merged = merge(current, new Map([["say.param.options", hash("上一版出厂内容")]]));
		expect(merged).toBeUndefined();
	});

	it("老工作区没有账本：值命中历史出厂 hash → 升到新版", () => {
		const old = "要我选：2–6 个选项。";
		const current = SEED.replace("要我选：2–6 个选项。只在你直接问我时用。", old);
		const merged = merge(current, new Map(), (valueHash) => valueHash === hash(old));
		expect(parseCatalog("merged", merged!.text).get("say.param.options")).toBe(
			"要我选：2–6 个选项。只在你直接问我时用。",
		);
	});

	it("追加过一遍之后再跑：不写盘（幂等）", () => {
		const once = merge("## say.description\n在频道里说话。\n")!.text;
		expect(merge(once)).toBeUndefined();
	});

	it("只换值，不动排版：小节之间的空行原样保留", () => {
		const old = "要我选：2–6 个选项。";
		const current = `# 文案\n\n## say.description\n在频道里说话。\n\n## say.param.options\n${old}\n`;
		const merged = merge(current, new Map([["say.param.options", hash(old)]]));
		expect(merged!.text.startsWith("# 文案\n\n## say.description\n在频道里说话。\n\n## say.param.options\n")).toBe(true);
	});
});
