/**
 * 静态目录选谁：`ui/dist/`（构建产物）还是 `ui/`（源码）。
 *
 * 打包能把首屏 24 个请求降到 3 个，但**绝不能因此让「无构建」失效**：
 * - `git clone` 完直接 `npm start` 也要能跑 → 没有产物就用源码；
 * - 改了 `ui/` 里的文件刷新就该看到 → 产物比源码旧就用源码；
 * - 产物只是一个**可选加速层**，删掉 `ui/dist/` 随时回到原状。
 *
 * 判过期的凭据是 `ui/dist/.stamp`（构建时写入的「源码最新 mtime」）。
 * 它比逐个文件 stat 便宜，也不会因为 `npm install` 触碰 node_modules 而误判。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type StaticRootChoice = {
	/** 实际要服务的目录（绝对路径）。 */
	readonly dir: string;
	/** `dist` 表示用构建产物，`source` 表示回退到源码。 */
	readonly kind: "dist" | "source";
	/** 回退原因（`kind === "source"` 时给日志用）。 */
	readonly reason?: string;
};

/** 源码目录下最新的 mtime（跳过 dist 自身）。与 `scripts/build-ui.mjs` 必须一致。 */
async function newestSourceMtime(dir: string, skip: string): Promise<number> {
	let newest = 0;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (full === skip) continue;
		const info = await stat(full).catch(() => undefined);
		if (info === undefined) continue;
		newest = Math.max(newest, info.isDirectory() ? await newestSourceMtime(full, skip) : info.mtimeMs);
	}
	return newest;
}

/**
 * 选出静态目录。**永不抛错**：任何异常都退回源码目录，
 * 因为「页面能打开」比「用上了构建产物」重要得多。
 */
export async function resolveStaticRoot(uiDir: string): Promise<StaticRootChoice> {
	const dist = join(uiDir, "dist");
	const source: StaticRootChoice = { dir: uiDir, kind: "source" };

	const index = await stat(join(dist, "index.html")).catch(() => undefined);
	if (index === undefined) return { ...source, reason: "ui/dist/ 不存在（未运行 npm run ui:build）" };

	const stampText = await readFile(join(dist, ".stamp"), "utf8").catch(() => undefined);
	const stamp = Number(stampText);
	if (stampText === undefined || !Number.isFinite(stamp)) {
		return { ...source, reason: "ui/dist/.stamp 缺失或损坏" };
	}

	// +1ms 容差：构建写完后到服务端 stat 之间文件系统时间戳可能有微秒级误差，
	// 不能让「刚构建完」被误判成「过期」，否则构建了却永远用不上。
	const newest = await newestSourceMtime(uiDir, dist).catch(() => Number.POSITIVE_INFINITY);
	if (newest > stamp + 1) {
		return { ...source, reason: "ui/ 源码比 ui/dist/ 新，可能改了没重新构建" };
	}

	return { dir: dist, kind: "dist" };
}
