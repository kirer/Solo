/**
 * 工作区文件的一次性迁移：启动时跑，跑完就是新形状，读的代码不用再兼容旧键。
 *
 * 为什么不在读的时候兼容：兼容分支住在每一份读取实现里（身份头、名册、频道消息），
 * 每一处都得记得旧形状长什么样，而且永远不知道什么时候能删。迁移只写一次盘，
 * 之后所有读路径只认一种形状。
 *
 * 库里的文档（`ChannelDoc` / `DirectoryDoc`）不在这里 —— 它们跟着 `defineDoc` 的
 * `version` / `migrate` 走，第一次读到旧版本时自动归好。
 */
import { join } from "node:path";
import { parseDoc } from "../core/documents/base/doc.ts";
import { IDENTITY_FILE } from "../core/documents/member/identity.ts";
import { listDirSorted, readTextOrUndefined, writeTextAt } from "../core/runtime/io.ts";
import type { Layout } from "../core/layout.ts";

/**
 * 跑一遍全部文件迁移，返回改过的文件（绝对路径）。幂等：没有旧形状就什么都不写。
 *
 * 加一个文件迁移 = 在这里多跑一个函数；旧迁移不要删 —— 从旧版本升级上来的工作区
 * 需要一次走完全部。
 */
export async function migrateWorkspace(layout: Layout): Promise<readonly string[]> {
	const changed: string[] = [];
	for (const root of layout.agentRoots) {
		for (const dir of await personDirs(root)) {
			const path = join(dir, IDENTITY_FILE);
			if (await migrateProjectField(path)) changed.push(path);
		}
	}
	return changed;
}

/** 一个根下的身份目录，包括 `members/.retired/` 里那些（重新招回来时也已经是新形状）。 */
async function personDirs(root: string): Promise<string[]> {
	const dirs: string[] = [];
	for (const entry of await listDirSorted(root)) {
		if (entry.kind !== "dir") continue;
		if (entry.name === ".retired") {
			for (const retired of await listDirSorted(join(root, entry.name))) {
				if (retired.kind === "dir") dirs.push(join(root, entry.name, retired.name));
			}
			continue;
		}
		if (!entry.name.startsWith(".")) dirs.push(join(root, entry.name));
	}
	return dirs;
}

/**
 * `identity.md` 头里的 `project:` → `team:`（团队曾经叫「项目」）。
 *
 * 只改头里那一行：正文与其余字段逐字节不动。已经同时有 `team:` 的，删掉 `project:`
 * 那一行（读的时候本来就是 `team` 优先）。
 */
async function migrateProjectField(path: string): Promise<boolean> {
	const source = await readTextOrUndefined(path);
	if (source === undefined) return false;
	const doc = parseDoc(path, source);
	if (doc.front["project"] === undefined) return false;
	const lines = source.split("\n");
	const index = lines.findIndex((line) => /^project\s*:/.test(line));
	if (index < 0) return false;
	const line = lines[index]!;
	if (doc.front["team"] === undefined) {
		lines[index] = line.replace(/^project(\s*:)/, "team$1");
	} else {
		lines.splice(index, 1);
	}
	await writeTextAt(path, lines.join("\n"));
	return true;
}
