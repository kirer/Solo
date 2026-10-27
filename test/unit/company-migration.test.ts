/**
 * 迁移：`app.company` v1 → v2 → v3。
 *
 * v1 → v2：员工从「角色名决定能力」改成「招聘时显式声明 tools / duty」。
 * v2 → v3：工具名多了一段可选的目录范围（`write:src/`，ADR-035），但**不动数据**。
 *
 * 为什么这条测试必须存在：`CompanyDoc.migrate` 是**唯一**在老库上跑的代码路径，
 * 而它只在「库里有老版数据」时触发——本地开发库可能是新建的，CI 也是新建的，
 * 于是它天然没有覆盖。等真跑生产库时才发现崩，代价是档案页 500 + 员工装配空工具。
 *
 * 这里直接喂一段老形状的 JSON 给 `migrate`，不依赖任何历史数据库文件。
 */
import { describe, expect, test } from "vitest";
import { CompanyDoc } from "../../src/company/docs.ts";
import { staffCharterOf } from "../../src/company/prompts.ts";
import { toolsForNames } from "../../src/company/staff-tools.ts";

/** 一段 v1 形状的组织文档：员工只有 `role`，没有 `tools` / `duty`。 */
function v1State(staff: Record<string, { role: string }>): Record<string, unknown> {
	const people: Record<string, unknown> = {};
	for (const [key, person] of Object.entries(staff)) {
		people[key] = {
			name: key.split("/")[1],
			role: person.role,
			conversationId: 7,
			project: "p",
			manager: "cto",
			model: { provider: "faux", modelId: "f" },
			hiredAt: 1,
			archived: false,
		};
	}
	return {
		company: { name: "老公司", createdAt: 1 },
		roles: {},
		projects: { p: { slug: "p" } },
		staff: people,
		archived: [],
		defaultModel: { provider: "faux", modelId: "f" },
		modelCatalog: [],
		workspaceRoot: "/tmp",
	};
}

const migrate = (value: unknown, fromVersion: number) =>
	CompanyDoc.definition.migrate!(value as never, fromVersion) as unknown as {
		staff: Record<string, { readonly role: string; readonly tools: string[]; readonly duty: string }>;
	};

describe("app.company v1 → v2 迁移", () => {
	test("v1 员工补上 tools 与 duty，且不崩", () => {
		const out = migrate(v1State({ "p/开发": { role: "开发" } }), 1);
		const dev = out.staff["p/开发"];
		expect(dev).toBeDefined();
		// 老员工的工具按**当年的表**推出来，不是给空：迁移不该悄悄卸掉能力
		expect(dev?.tools).toEqual(["read", "write", "edit", "bash"]);
		expect(dev?.duty).toContain("开发工程师");
	});

	test("v1 里表外的角色（当年被静默变只读的「前端」）迁移后依然是只读，行为不变", () => {
		const out = migrate(v1State({ "p/前端": { role: "前端" } }), 1);
		const person = out.staff["p/前端"];
		// 迁移只补字段，不改行为：它迁以前就是 ["read"]，迁之后还是 ["read"]
		expect(person?.tools).toEqual(["read"]);
		expect(person?.duty).toContain("前端");
	});

	test("迁移后的字段能直接喂给下游（这正是当年不迁会崩的两处）", () => {
		const out = migrate(v1State({ "p/开发": { role: "开发" } }), 1);
		const dev = out.staff["p/开发"]!;
		// ① 档案页：staffCharterOf 里有 input.duty.trim()，undefined 会直接 TypeError
		expect(() =>
			staffCharterOf({ duty: dev.duty, projectName: "p", managerLabel: "CTO" }),
		).not.toThrow();
		// ② 装配：employeeToolsFor → toolsForNames，undefined 会一路传下去
		expect(() => toolsForNames(dev.tools)).not.toThrow();
		expect(toolsForNames(dev.tools).map((tool) => tool.name)).toEqual(["read", "write", "edit", "bash"]);
	});

	test("v2 数据原样返回（迁移可重复执行）", () => {
		const v2 = migrate(v1State({ "p/开发": { role: "开发" } }), 1);
		const again = migrate(v2, 2);
		expect(again.staff["p/开发"]?.tools).toEqual(["read", "write", "edit", "bash"]);
	});

	test("v2 → v3 不缩权：老的 write 仍是 write，不会被加上目录范围", () => {
		// 这是 ADR-035 的关键约束：收紧权限会让已派出的任务突然失败，
		// 所以迁移只升版本号，不碰 tools。
		const v2 = { ...v1State({ "p/开发": { role: "开发" } }), staff: {} } as Record<string, unknown>;
		(v2 as { staff: Record<string, unknown> }).staff = {
			"p/开发": {
				name: "开发",
				role: "开发",
				duty: "你是开发工程师。",
				tools: ["write"],
				conversationId: 7,
				project: "p",
				manager: "cto",
				model: { provider: "faux", modelId: "f" },
				hiredAt: 1,
				archived: false,
			},
		};
		const out = migrate(v2, 2);
		expect(out.staff["p/开发"]?.tools).toEqual(["write"]);
	});

	test("v3 数据原样返回（迁移可重复执行）", () => {
		const v3 = migrate(v1State({ "p/开发": { role: "开发" } }), 1);
		const again = migrate(v3, 3);
		expect(again.staff["p/开发"]?.tools).toEqual(["read", "write", "edit", "bash"]);
	});
});
