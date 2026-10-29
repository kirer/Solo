import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	listProjects,
	membersOfProject,
	readProject,
	renderProjectFile,
	writeProject,
} from "../../src/core/project/doc.ts";

let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "core-project-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("项目：一份 README.md 就是全部事实", () => {
	it("没有目录时返回 undefined，列表为空", async () => {
		expect(await readProject(root, "demo")).toBeUndefined();
		expect(await listProjects(root)).toEqual([]);
	});

	it("写进去能读出来，头部字段正确", async () => {
		const written = await writeProject(root, {
			slug: "demo",
			name: "演示项目",
			owner: "linyue",
			status: "active",
			body: "目标：能跑通。验收：输入 A 得到 B。",
		});
		expect(written.name).toBe("演示项目");
		expect(written.owner).toBe("linyue");
		expect(written.status).toBe("active");

		const read = await readProject(root, "demo");
		expect(read?.body).toBe("目标：能跑通。验收：输入 A 得到 B。");
	});

	it("重复写只换正文时，name/owner/status 保留", async () => {
		await writeProject(root, { slug: "demo", name: "演示", owner: "linyue", status: "paused", body: "v1" });
		const second = await writeProject(root, { slug: "demo", body: "v2" });
		expect(second.name).toBe("演示");
		expect(second.owner).toBe("linyue");
		expect(second.status).toBe("paused");
		expect(second.body).toBe("v2");
	});

	it("doing：写进去能读出来，且只重复写正文时沿用原值", async () => {
		await writeProject(root, { slug: "demo", doing: "沈舟在改 doing 链路", body: "v1" });
		expect((await readProject(root, "demo"))?.doing).toBe("沈舟在改 doing 链路");
		const second = await writeProject(root, { slug: "demo", body: "v2" });
		expect(second.doing).toBe("沈舟在改 doing 链路");
		expect(second.body).toBe("v2");
	});

	it("doing：没写的项目读出来是 undefined，空串也不落盘", async () => {
		await writeProject(root, { slug: "demo", body: "v1" });
		expect((await readProject(root, "demo"))?.doing).toBeUndefined();
		await writeProject(root, { slug: "demo", doing: "", body: "v2" });
		expect((await readProject(root, "demo"))?.doing).toBeUndefined();
	});

	it("doing：显式传入时覆盖原值（契约只把「不传」当保留）", async () => {
		await writeProject(root, { slug: "demo", doing: "旧", body: "v1" });
		const second = await writeProject(root, { slug: "demo", doing: "新", body: "v2" });
		expect(second.doing).toBe("新");
	});

	it("缺 owner 时不编造负责人（写「没人负责」是渲染层的事）", async () => {
		const written = await writeProject(root, { slug: "solo", body: "只有我一个人做" });
		expect(written.owner).toBeUndefined();
		expect(written.name).toBe("solo");
	});

	it("非法 status 回落 active，不炸", async () => {
		const written = await writeProject(root, { slug: "x", body: "b", status: "什么鬼" as never });
		expect(written.status).toBe("active");
	});

	it("列表按 slug 码点序，保证渲染确定", async () => {
		for (const slug of ["c", "a", "b"]) await writeProject(root, { slug, body: slug });
		expect((await listProjects(root)).map((project) => project.slug)).toEqual(["a", "b", "c"]);
	});

	it("空 slug 被拒绝", async () => {
		await expect(writeProject(root, { slug: "  ", body: "x" })).rejects.toThrow();
	});

	it("renderProjectFile 是唯一格式来源：写盘内容与它逐字节相同", async () => {
		const text = renderProjectFile({ name: "A", owner: "b", status: "done", body: "正文" });
		expect(text).toBe("---\nname: A\nowner: b\nstatus: done\n---\n\n正文\n");
	});

	it("membersOfProject 按 identity 的 project 字段算成员", () => {
		const identities = [
			{ slug: "a", project: "demo" },
			{ slug: "b", project: "other" },
			{ slug: "c" },
			{ slug: "d", project: "demo" },
		];
		expect(membersOfProject(identities, "demo")).toEqual(["a", "d"]);
	});
});
