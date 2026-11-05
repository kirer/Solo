/**
 * 文案目录的升级：只追加工作区还没有的键。
 *
 * 这一条挡的是「新文案永远进不了老工作区」—— 工具描述会变成空串，模型看不见约束，
 * 而服务起得来、测试全绿，只有行为慢慢变差。实测踩过两次，都是手工去补的。
 */
import { describe, expect, it } from "vitest";
import { appendMissingKeys, parseCatalog } from "../../src/core/documents/base/catalog.ts";

const SEED = `# 文案

## say.description
在频道里说话。

## say.param.options
要我选：2–6 个选项。
`;

describe("appendMissingKeys", () => {
	it("工作区缺的键追加到末尾，正文一字不差", () => {
		const current = "# 我改过的文案\n\n## say.description\n我自己改的措辞。\n";
		const merged = appendMissingKeys(current, SEED);
		expect(merged).toBeDefined();
		const keys = parseCatalog("merged", merged as string);
		// 改过的句子不动
		expect(keys.get("say.description")).toBe("我自己改的措辞。");
		// 新键补上了
		expect(keys.get("say.param.options")).toBe("要我选：2–6 个选项。");
	});

	it("一个键都不缺：返回 undefined（不写盘、不重复追加）", () => {
		const merged = appendMissingKeys(SEED, SEED);
		expect(merged).toBeUndefined();
	});

	it("追加过一遍之后再追：还是 undefined（幂等）", () => {
		const once = appendMissingKeys("## say.description\n在频道里说话。\n", SEED) as string;
		expect(appendMissingKeys(once, SEED)).toBeUndefined();
	});
});
