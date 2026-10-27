import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createAgent, renderOrgChart, slugify, uniqueSlug } from "../../src/core/company/org.ts";
import { listAgentSlugs, readAllIdentities, readIdentity } from "../../src/core/agent/identity.ts";

const dirs: string[] = [];

async function root(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "core-org-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("slug", () => {
	test("中文保留，空白与符号变连字符", () => {
		expect(slugify("林越")).toBe("林越");
		expect(slugify("Head of  Ops")).toBe("Head-of-Ops");
		expect(slugify("a/b:c")).toBe("a-b-c");
	});
	test("全是符号时退化成 agent", () => {
		expect(slugify("  ")).toBe("agent");
	});
	test("重名自动加后缀", async () => {
		const agents = await root();
		expect(await uniqueSlug(agents, "林越")).toBe("林越");
		await createAgent({ root: agents, name: "林越" });
		expect(await uniqueSlug(agents, "林越")).toBe("林越-2");
	});
});

describe("新建 agent", () => {
	test("建完就能读回来，字段无损", async () => {
		const agents = await root();
		await createAgent({
			root: agents,
			name: "林越",
			title: "技术负责人",
			manager: "owner",
			project: "alpha",
			body: "我管技术。",
		});
		const identity = await readIdentity(agents, "林越");
		expect(identity?.name).toBe("林越");
		expect(identity?.title).toBe("技术负责人");
		expect(identity?.manager).toBe("owner");
		expect(identity?.project).toBe("alpha");
		expect(identity?.body).toBe("我管技术。");
	});

	test("不写正文时留一句占位，而不是空文件", async () => {
		const agents = await root();
		await createAgent({ root: agents, name: "无名" });
		const identity = await readIdentity(agents, "无名");
		expect(identity?.body).toContain("我可以随时改这里");
	});

	test("公司人数 = 目录数", async () => {
		const agents = await root();
		await createAgent({ root: agents, name: "CEO" });
		await createAgent({ root: agents, name: "CTO", manager: "CEO" });
		expect((await listAgentSlugs(agents)).length).toBe(2);
		expect((await readAllIdentities(agents)).map((item) => item.slug)).toEqual(["CEO", "CTO"]);
	});
});

describe("组织架构投影", () => {
	test("按汇报关系缩进，标出自己", async () => {
		const agents = await root();
		await createAgent({ root: agents, name: "总经理", manager: "owner" });
		await createAgent({ root: agents, name: "技术", title: "CTO", manager: "总经理" });
		await createAgent({ root: agents, name: "财务", manager: "总经理" });
		const all = await readAllIdentities(agents);
		const chart = renderOrgChart(all, "技术");
		expect(chart).toContain("- 总经理");
		expect(chart).toContain("  - 技术（CTO）  ← 你");
		expect(chart).toContain("  - 财务");
	});

	test("断链的人不会凭空消失", async () => {
		const agents = await root();
		await createAgent({ root: agents, name: "孤儿", manager: "不存在的人" });
		const chart = renderOrgChart(await readAllIdentities(agents));
		expect(chart).toContain("汇报线断了");
		expect(chart).toContain("孤儿");
	});

	test("空公司给一句话，不是空字符串", async () => {
		expect(renderOrgChart([])).toContain("还没有其他人");
	});
});
