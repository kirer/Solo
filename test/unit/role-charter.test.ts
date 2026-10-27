/**
 * 岗位职责文案与真实工具集的一致性。
 *
 * 为什么需要这组测试：小恐龙验收里 CPO 和 CHRO 花了 4 条长消息来回对齐
 * 「我没有 read/bash，只能按材料审」（`docs/roundtable/ACCEPTANCE-dino.md` §2.2）。
 * 根因不是它们理解错，而是**职责文案让它们以为自己能做**——管理层被要求
 * 「定义验收标准 / 审核交付」，文案里就容易冒出「亲自打开看」「跑一遍」这种
 * 它们根本没有工具去做的动作，然后它们只能在频道里反复解释做不到。
 *
 * 这组测试钉的不是「文案长什么样」，而是「文案不许承诺工具集里没有的能力」。
 * 改文案可以随便改，但一旦写出做不到的动作就会红。
 */
import { describe, expect, test } from "vitest";
import { COMMON_GUIDE, ROLE_DEFINITIONS } from "../../src/company/roles.ts";
import { PROJECT_LEADER_CHARTER } from "../../src/company/tools.ts";

/** 执行类工具：只有拿到它们才能「打开文件看」「跑一遍命令」。 */
const EXEC_TOOLS = ["read", "write", "edit", "bash"] as const;

/** 断言「你能亲自做某事」的措辞。命中这些词就意味着在承诺执行能力。 */
const PROMISES_EXECUTION = [
	/你(能|可以|要)?(亲自|直接|自己)?(打开|读取|读一下|跑一遍|跑一下|执行)/,
	/(亲自|直接)(确认|验证|核验|核实|看一眼|打开)/,
];

/**
 * 否定语境：命中词所在的这一小句里带「不 / 别 / 禁止」，那就是在禁止这个动作。
 *
 * 为什么会需要它：我写完 CPO 的新守则后，这条测试立刻报了一个 offender——
 * 命中的正是「不要写『你亲自确认一下』」里的「亲自确认」。一个不知道「禁止」
 * 和「承诺」区别的检查器，会逼着人把守则改得模糊才能变绿——那比没测试更坏。
 * 小句边界取句号/分号/冒号/换行：否定作用域不会跨过这些。
 */
const NEGATION = /[不别禁止]/;
const CLAUSE_BOUNDARY = /[。；;：:\n]/;

function inNegatedClause(line: string, index: number): boolean {
	const before = line.slice(0, index);
	let start = 0;
	for (const match of before.matchAll(new RegExp(CLAUSE_BOUNDARY.source, "g"))) {
		start = (match.index ?? 0) + 1;
	}
	return NEGATION.test(before.slice(start));
}

describe("管理层职责文案不承诺执行能力", () => {
	test("没有任何岗位拿到 read/write/edit/bash（权限靠工具不存在）", () => {
		for (const definition of Object.values(ROLE_DEFINITIONS)) {
			const exec = EXEC_TOOLS.filter((tool) => definition.capabilityNames.includes(tool));
			expect(exec, `${definition.label} 不该有执行类工具`).toEqual([]);
		}
	});

	test("既然没有执行工具，职责文案里就不能写「亲自打开看 / 跑一遍」这类动作", () => {
		const offenders: string[] = [];
		for (const definition of Object.values(ROLE_DEFINITIONS)) {
			for (const line of definition.charter.split("\n")) {
				for (const pattern of PROMISES_EXECUTION) {
					const match = line.match(pattern);
					if (match === null) continue;
					// 同一小句里带「不 / 别」——那是在禁止这个动作，不是在承诺它。
					if (inNegatedClause(line, match.index ?? 0)) continue;
					offenders.push(`${definition.label}: 「${match[0]}」`);
				}
			}
		}
		expect(offenders, "这些岗位在承诺自己没有的执行能力，请改成「要求对方贴原始输出」").toEqual([]);
	});

	test("通用准则显式说明「你看不到文件、也跑不了命令」", () => {
		// 这一句是给小恐龙验收那 4 条长消息的根治：与其让每个岗位自己发现，
		// 不如在所有人共用的准则里写一次。
		expect(COMMON_GUIDE).toContain("你看不到文件、也跑不了命令");
	});

	test("CPO 的职责里写明验收标准要「贴得出证据」，而不是「亲自确认」", () => {
		expect(ROLE_DEFINITIONS.cpo.charter).toContain("贴得出证据");
	});

	test("CHRO 的职责里写明「能力只看 tools，角色名不决定能力」", () => {
		// B1 之后这是招聘唯一的真实约束，不写会被误以为还能按角色名自动配工具。
		expect(ROLE_DEFINITIONS.chro.charter).toContain("能力只看");
		expect(ROLE_DEFINITIONS.chro.charter).toContain("tools");
	});
});

describe("项目负责人职责文案与它的工具集一致", () => {
	test("负责人确实有执行工具，所以文案可以承诺「自己动手改文件、跑命令」", () => {
		// 反向断言：负责人是唯一被允许承诺执行能力的岗位，文案里必须有这句，
		// 否则它会以为验收只能靠材料审——而它明明能自己跑。
		expect(PROJECT_LEADER_CHARTER).toContain("read / write / edit / bash");
		expect(PROJECT_LEADER_CHARTER).toContain("由你自己确认");
	});
});
