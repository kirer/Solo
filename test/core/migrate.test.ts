/**
 * 工作区文件迁移：旧键在启动时改写掉，读的代码只认一种形状。
 *
 * 钉住三件事：`project:` → `team:`、正文与其它字段逐字节不动、重复跑不再改。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLayout } from "../../src/core/layout.ts";
import { migrateWorkspace } from "../../src/shell/migrate.ts";

const boxes: string[] = [];

afterEach(async () => {
	for (const box of boxes.splice(0)) await rm(box, { recursive: true, force: true });
});

async function box(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "solo-migrate-"));
	boxes.push(root);
	return root;
}

async function identity(root: string, dir: string, body: string): Promise<string> {
	await mkdir(join(root, dir), { recursive: true });
	const path = join(root, dir, "identity.md");
	await writeFile(path, body, "utf8");
	return path;
}

describe("身份头 project: → team:", () => {
	it("改键不改别的字节；已经有 team 的删掉 project 行", async () => {
		const root = await box();
		const layout = resolveLayout({ appRoot: join(root, "app"), userRoot: join(root, "home") });
		const renamed = await identity(
			layout.membersRoot,
			"甲",
			"---\nname: 甲\ntitle: 工程师\nproject: alpha\n---\n\n# 甲\n\n正文里的 project: 不动。\n",
		);
		const both = await identity(layout.membersRoot, "乙", "---\nname: 乙\nteam: beta\nproject: gamma\n---\n\n做事的。\n");

		const changed = await migrateWorkspace(layout);

		expect(changed.sort()).toEqual([renamed, both].sort());
		expect(await readFile(renamed, "utf8")).toBe(
			"---\nname: 甲\ntitle: 工程师\nteam: alpha\n---\n\n# 甲\n\n正文里的 project: 不动。\n",
		);
		expect(await readFile(both, "utf8")).toBe("---\nname: 乙\nteam: beta\n---\n\n做事的。\n");
		// 幂等：第二次跑没有任何文件要改。
		expect(await migrateWorkspace(layout)).toEqual([]);
	});

	it("助理与 .retired 里的身份也一起迁移", async () => {
		const root = await box();
		const layout = resolveLayout({ appRoot: join(root, "app"), userRoot: join(root, "home") });
		const assistant = await identity(layout.assistantRoot, "知言", "---\nname: 知言\nproject: alpha\n---\n\n助理。\n");
		const retired = await identity(join(layout.membersRoot, ".retired"), "丙-2", "---\nname: 丙\nproject: alpha\n---\n\n走了。\n");

		const changed = await migrateWorkspace(layout);

		expect(changed.sort()).toEqual([assistant, retired].sort());
		expect(await readFile(assistant, "utf8")).toContain("team: alpha");
		expect(await readFile(retired, "utf8")).toContain("team: alpha");
	});
});

describe("助理的显示名 知言 → Solo", () => {
	it("只改应用根下那个人的 name，成员与正文不动", async () => {
		const root = await box();
		const layout = resolveLayout({ appRoot: join(root, "app"), userRoot: join(root, "home") });
		const assistant = await identity(
			layout.assistantRoot,
			"知言",
			"---\nname: 知言\ntitle: 助理\nteam: \"\"\n---\n\n正文里的 知言 不动。\n",
		);
		const sameNameMember = await identity(
			layout.membersRoot,
			"知言",
			"---\nname: 知言\ntitle: 工程师\n---\n\n成员。\n",
		);

		const changed = await migrateWorkspace(layout);

		expect(changed).toEqual([assistant]);
		expect(await readFile(assistant, "utf8")).toBe(
			"---\nname: Solo\ntitle: 助理\nteam: \"\"\n---\n\n正文里的 知言 不动。\n",
		);
		expect(await readFile(sameNameMember, "utf8")).toBe(
			"---\nname: 知言\ntitle: 工程师\n---\n\n成员。\n",
		);
		// 幂等。
		expect(await migrateWorkspace(layout)).toEqual([]);
	});
});
