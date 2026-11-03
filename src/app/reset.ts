/**
 * 重置：把两个根里的组织数据清空，回到刚装好的样子。
 *
 * 真正的删除必须在库关掉之后做（`core.sqlite` 还在进程手里）；这里只提供
 * 「确认」和「删哪些」两件事，什么时候调用由启动层（`shell/main.ts`）决定。
 *
 * 保留 `settings.json` 与 `.secrets.json`：重置是清数据，不是把应用打成
 * 一个连模型都没有的空壳。已装插件不保留 —— 出厂插件会在下次启动时播种回来。
 */
import { join, relative, resolve, sep } from "node:path";
import type { Layout } from "../core/layout.ts";
import { listDirSorted, removeAt, removeDirAt } from "../core/runtime/io.ts";
import { AppError } from "./errors.ts";

/** 应用根里由内核拥有的目录。别的一概不碰：桌面壳的缓存也在这同一个目录里。 */
function appOwnedDirs(layout: Layout): readonly string[] {
	return [
		layout.assistantRoot,
		layout.promptRoot,
		layout.textRoot,
		layout.pluginsRoot,
		layout.uploadsRoot,
	];
}

/** 应用根里由内核拥有的文件：库（连同 WAL）与播种账本。 */
function appOwnedFiles(layout: Layout): readonly string[] {
	return [
		layout.databasePath,
		`${layout.databasePath}-wal`,
		`${layout.databasePath}-shm`,
		layout.seedManifestFile,
	];
}

/** 两个根恰好是同一个目录（单目录部署 / 测试）时，只删用户数据，`settings.json` 得留下。 */
function userOwnedPaths(layout: Layout): readonly string[] {
	return [layout.membersRoot, layout.teamsRoot, layout.skillsRoot, layout.logsRoot];
}

/**
 * 用户根整个删掉。只有一种例外：应用根与用户根相同、或藏在用户根里面
 * （测试、单目录部署）—— 那就只删应用根以外的条目，别把 `settings.json` 一起带走。
 */
async function wipeUserRoot(layout: Layout): Promise<void> {
	const user = resolve(layout.userRoot);
	const app = resolve(layout.appRoot);
	if (app === user) {
		await Promise.all(userOwnedPaths(layout).map((path) => removeDirAt(path)));
		await removeAt(layout.rulesFile);
		return;
	}
	if (!app.startsWith(`${user}${sep}`)) {
		await removeDirAt(user);
		return;
	}
	const keep = relative(user, app).split(sep)[0];
	for (const entry of await listDirSorted(user)) {
		if (entry.name === keep) continue;
		await removeDirAt(join(user, entry.name));
	}
}

/** 清空两个根里的数据。调用前必须先关掉库。 */
export async function wipeAll(layout: Layout): Promise<void> {
	await wipeUserRoot(layout);
	await Promise.all([
		...appOwnedDirs(layout).map((path) => removeDirAt(path)),
		...appOwnedFiles(layout).map((path) => removeAt(path)),
	]);
}

export function createReset(layout: Layout) {
	return {
		/** 界面上的「确认」走这一句；真正的删除由进程关掉库之后再做。 */
		request(confirm: unknown): { readonly ok: true; readonly restarting: true } {
			if (confirm !== true) throw new AppError("bad-request", "重置需要明确确认");
			return { ok: true, restarting: true };
		},
		wipe: () => wipeAll(layout),
	};
}
