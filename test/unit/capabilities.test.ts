/**
 * 能力目录的自检。
 *
 * 最重要的一条：**目录里的每个能力都必须真的能装上**。
 * 这条检查能抓到一类真实 bug —— 工具实现了、也注入了，但没进
 * `CAPABILITY_TO_TOOL` 映射表，于是任何 agent 都拿不到，只有 HTTP 入口能用
 * （`dispose_pending` / `take_over_pending` 就踩过这个坑）。
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CAPABILITIES,
	capabilitiesOfLayer,
	capabilityOf,
	describeCatalog,
	splitCore,
} from "../../src/company/capabilities.ts";

const ROOT = join(import.meta.dirname, "../..");

/** 从 tools.ts 里抽出 `CAPABILITY_TO_TOOL` 映射表的键。 */
function mappedCapabilities(): Set<string> {
	const source = readFileSync(join(ROOT, "src/company/tools.ts"), "utf8");
	const start = source.indexOf("const CAPABILITY_TO_TOOL");
	const end = source.indexOf("};", start);
	const block = source.slice(start, end);
	return new Set([...block.matchAll(/^\t([a-z_]+):/gm)].map((match) => match[1] as string));
}

/** 从 management-tools.ts / dispatch.ts 里抽出真正定义了的工具名。 */
function definedTools(): Set<string> {
	const names = new Set<string>();
	for (const file of [
		"src/company/management-tools.ts",
		"src/company/tools/dispatch.ts",
		"src/company/tools/universal.ts",
		"src/company/roundtable-tools.ts",
		"src/company/memory.ts",
	]) {
		const source = readFileSync(join(ROOT, file), "utf8");
		for (const match of source.matchAll(/name: "([a-z_]+)"/g)) names.add(match[1] as string);
	}
	return names;
}

describe("能力目录必须能真的装上", () => {
	test("目录里的每个能力都在 CAPABILITY_TO_TOOL 映射表里", () => {
		const mapped = mappedCapabilities();
		const missing = CAPABILITIES.map((capability) => capability.name).filter((name) => !mapped.has(name));
		expect(missing, `这些能力在目录里但装不上：${missing.join("、")}`).toEqual([]);
	});

	test("目录里的每个能力都有真实实现", () => {
		const defined = definedTools();
		const missing = CAPABILITIES.map((capability) => capability.name).filter((name) => !defined.has(name));
		expect(missing, `这些能力在目录里但没有实现：${missing.join("、")}`).toEqual([]);
	});

	test("映射表里没有目录之外的工具（避免悄悄长出新工具）", () => {
		const catalog = new Set(CAPABILITIES.map((capability) => capability.name));
		const extra = [...mappedCapabilities()].filter((name) => !catalog.has(name));
		expect(extra, `这些工具在映射表里但没进目录：${extra.join("、")}`).toEqual([]);
	});

	test("能力名唯一", () => {
		const names = CAPABILITIES.map((capability) => capability.name);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe("核心 / 延迟分层", () => {
	test("每层都有核心能力（否则模型面前什么都没有）", () => {
		for (const layer of ["universal", "staff"] as const) {
			const core = CAPABILITIES.filter((capability) => capability.layer === layer && capability.core);
			expect(core.length, `${layer} 层没有核心能力`).toBeGreaterThan(0);
		}
	});

	test("核心能力数量克制（<= 14）：工具越多选错越多", () => {
		// 12 个通用/协作类 + my_capabilities（自查入口，必须核心，否则自举悖论）。
		// 上限存在的意义是「别把长尾工具塞进核心」，不是精确到个位。
		const core = CAPABILITIES.filter((capability) => capability.core);
		expect(core.length).toBeLessThanOrEqual(14);
	});

	test("高频工具必须是核心", () => {
		const mustBeCore = ["whoami", "say", "ask", "read_channel", "inbox", "task_list", "task_update"];
		for (const name of mustBeCore) {
			expect(capabilityOf(name)?.core, `${name} 应该默认给模型`).toBe(true);
		}
	});

	test("低频危险工具必须延迟加载", () => {
		const mustBeDeferred = ["project_delete", "staff_hire", "project_create", "roundtable"];
		for (const name of mustBeDeferred) {
			expect(capabilityOf(name)?.core, `${name} 应该延迟加载`).toBe(false);
		}
	});

	test("splitCore 正确分组", () => {
		const { core, deferred } = splitCore(["whoami", "say", "project_delete", "staff_hire"]);
		expect(core).toEqual(["whoami", "say"]);
		expect(deferred).toEqual(["project_delete", "staff_hire"]);
	});

	test("未知能力名按核心处理（新工具不会突然消失）", () => {
		const { core, deferred } = splitCore(["brand_new_tool"]);
		expect(core).toEqual(["brand_new_tool"]);
		expect(deferred).toEqual([]);
	});
});

describe("分层统计", () => {
	test("按层取能力名", () => {
		expect(capabilitiesOfLayer("universal")).toContain("say");
		expect(capabilitiesOfLayer("ceo")).toContain("take_over_pending");
	});

	test("describeCatalog 给出可读统计", () => {
		const text = describeCatalog();
		expect(text).toContain("能力目录");
		expect(text).toContain("universal");
		expect(text).toContain("延迟");
	});
});

/**
 * 岗位声明与目录必须一致。
 *
 * 这是 `profile.ts:130` 那个真实 bug 的机制性防线：员工档案页曾经漏传
 * `universalTools` 第三参，展示的工具清单比员工实际拿到的少 7 个，而
 * 34==34==34 的目录比对恰好通过，测试抓不到。
 *
 * 这里不比对「数量」，比对的是**声明名 → 映射 → 工具实现**这条链每一环都通。
 */
describe("岗位声明必须能全部映射成真实工具", () => {
	test("roles.ts 里每个岗位的每个 capabilityNames 都在映射表里", async () => {
		const { ROLE_DEFINITIONS, MANAGEMENT_ROLES } = await import("../../src/company/roles.ts");
		void MANAGEMENT_ROLES;
		const mapped = mappedCapabilities();
		const problems: string[] = [];
		for (const [role, definition] of Object.entries(ROLE_DEFINITIONS)) {
			for (const name of definition.capabilityNames) {
				if (!mapped.has(name)) problems.push(`${role} → ${name}`);
			}
		}
		expect(problems, `这些声明无法映射成工具：${problems.join("、")}`).toEqual([]);
	});

	test("tools.ts 里内联的负责人能力数组也全部在映射表里", () => {
		const source = readFileSync(join(ROOT, "src/company/tools.ts"), "utf8");
		const mapped = mappedCapabilities();
		const catalog = new Set(CAPABILITIES.map((capability) => capability.name));
		// 抽出所有 `const capabilityNames = [ ... ]` 块里的字符串字面量
		const problems: string[] = [];
		for (const match of source.matchAll(/const capabilityNames = \[([\s\S]*?)\];/g)) {
			for (const name of match[1]?.matchAll(/"([a-z_]+)"/g) ?? []) {
				const value = name[1] as string;
				if (!catalog.has(value) || !mapped.has(value)) problems.push(value);
			}
		}
		expect(problems, `负责人能力数组里有目录外或映射不上的名字：${problems.join("、")}`).toEqual([]);
	});
});
