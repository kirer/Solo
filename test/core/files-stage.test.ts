/**
 * 「把正文里的一个路径转成附件」（老板 2026-11-10）。
 *
 * 这条例行的危险处只有一个：它是一段「把磁盘上的文件复制进附件目录」的路。
 * 所以判据两条都不能松 —— **路径校验走的是同一条 `files.preview`**（相对路径、
 * 不许 `..`、隐藏文件与自家密钥不给看、认不出的格式不搬），**转出来的东西就是一个
 * 普通附件**（落了本体 + 元数据，`read` 能读回来）。
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUploads, STAGED_PREFIX } from "../../src/app/uploads.ts";
import type { CoreServices } from "../../src/app/types.ts";
import { resolveLayout, type Layout } from "../../src/core/layout.ts";

let box: string;
let layout: Layout;
let uploads: ReturnType<typeof createUploads>;

async function put(path: string, body: string | Uint8Array): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, body);
}

beforeEach(async () => {
	box = await mkdtemp(join(tmpdir(), "stage-"));
	layout = resolveLayout({ appRoot: join(box, "app"), userRoot: join(box, "home") });
	uploads = createUploads({ layout } as CoreServices);
	await put(join(layout.teamsRoot, "weekly", "workspace", "report.md"), "# 周报\n本周交付。\n");
	await put(join(layout.teamsRoot, "weekly", "workspace", "raw.bin"), new Uint8Array([0, 1, 2]));
	await put(join(layout.settingsFile), '{"apiKey":"sk-秘密"}');
	await put(join(layout.userRoot, ".hidden.md"), "藏起来的");
});

afterEach(async () => {
	await rm(box, { recursive: true, force: true });
});

async function uploadNames(): Promise<string[]> {
	return await readdir(layout.uploadsRoot).catch(() => []);
}

describe("路径转附件", () => {
	it("文本转得出来：落在附件目录里，读回来是同一份内容", async () => {
		const staged = await uploads.stage("teams/weekly/workspace/report.md");
		expect(staged.name).toBe("report.md");
		expect(staged.kind).toBe("file");
		expect(staged.id.startsWith(STAGED_PREFIX)).toBe(true);

		// 本体 + 元数据都在：和手选上传的附件长得一模一样。
		const names = await uploadNames();
		expect(names).toContain(staged.id);
		expect(names).toContain(`${staged.id}.json`);

		const read = await uploads.read(staged.id, { preview: true });
		expect(read.name).toBe("report.md");
		expect(read.mime).toBe("text/plain; charset=utf-8");
	});

	it("往上走 / 绝对路径 / 隐藏文件 / 自家密钥一律转不了，且没落下任何文件", async () => {
		for (const path of ["../etc/passwd", "/etc/passwd", ".hidden.md", "settings.json"]) {
			await expect(uploads.stage(path)).rejects.toThrow();
		}
		expect(await uploadNames()).toEqual([]);
	});

	it("认不出的格式（422 档）也不搬 —— 转成附件就得画得出来", async () => {
		await expect(uploads.stage("teams/weekly/workspace/raw.bin")).rejects.toThrow("这种格式不支持预览");
		expect(await uploadNames()).toEqual([]);
	});
});
