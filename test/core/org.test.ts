import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createAgent, slugify, uniqueSlug } from "../../src/core/agent/create.ts";
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
			team: "alpha",
			body: "我管技术。",
		});
		const identity = await readIdentity(agents, "林越");
		expect(identity?.name).toBe("林越");
		expect(identity?.title).toBe("技术负责人");
		expect(identity?.manager).toBe("owner");
		expect(identity?.team).toBe("alpha");
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
