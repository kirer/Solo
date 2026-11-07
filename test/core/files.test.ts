/**
 * 正文里点到的文件：解路径的几条底线。
 *
 * 这条例行的存在意义是「点一个路径能看一眼」，所以判据只有三类：**认得对**
 * （两个根、图片 / 文本 / PDF）、**挡得住**（`..`、绝对路径、隐藏文件、自家的密钥与库）、
 * **说得清**（认不出的格式回 415 而不是把二进制塞进响应）。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFiles } from "../../src/app/files.ts";
import { resolveLayout, type Layout } from "../../src/core/layout.ts";

let box: string;
let layout: Layout;
let files: ReturnType<typeof createFiles>;

async function put(path: string, body: string | Uint8Array): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, body);
}

beforeEach(async () => {
	box = await mkdtemp(join(tmpdir(), "files-"));
	layout = resolveLayout({ appRoot: join(box, "app"), userRoot: join(box, "home") });
	files = createFiles(layout);
	await put(join(layout.teamsRoot, "weekly", "workspace", "report.md"), "# 周报\n本周交付。\n");
	await put(join(layout.logsRoot, "core.log"), "一行日志\n");
	await put(join(layout.settingsFile), '{"apiKey":"sk-秘密"}');
	await put(join(layout.userRoot, ".hidden.md"), "藏起来的");
	await put(join(layout.teamsRoot, "weekly", "workspace", "raw.bin"), new Uint8Array([0, 1, 2]));
});

afterEach(async () => {
	await rm(box, { recursive: true, force: true });
});

describe("正文里点到的文件", () => {
	it("用户根下的相对路径：文本按 text/plain 读", async () => {
		const result = await files.preview("teams/weekly/workspace/report.md");
		expect(result.kind).toBe("text");
		if (result.kind !== "text") return;
		expect(result.name).toBe("report.md");
		expect(result.mime).toBe("text/plain; charset=utf-8");
	});

	it("应用根下的图片给真 mime，PDF 单独一档", async () => {
		await put(join(layout.uploadsRoot, "abc.png"), new Uint8Array([137, 80, 78, 71]));
		const image = await files.preview("uploads/abc.png");
		expect(image.kind).toBe("image");
		if (image.kind === "image") expect(image.mime).toBe("image/png");

		await put(join(layout.teamsRoot, "weekly", "workspace", "spec.pdf"), "%PDF-1.7");
		expect((await files.preview("teams/weekly/workspace/spec.pdf")).kind).toBe("pdf");
	});

	it("隐藏文件也照样给原因，但自家密钥 / 库 / 播种清单不开放", async () => {
		expect(await files.preview(".hidden.md")).toMatchObject({ kind: "none", status: 404 });
		expect(await files.preview("settings.json")).toMatchObject({ kind: "none", reason: "这个文件不开放预览" });
	});

	it("绝对路径 / 往上走 / 带 `~` 的一律不认", async () => {
		expect(await files.preview(join(layout.teamsRoot, "weekly", "workspace", "report.md"))).toMatchObject({ status: 404 });
		expect(await files.preview("../etc/passwd")).toMatchObject({ status: 404 });
		expect(await files.preview("teams/../../etc/passwd")).toMatchObject({ status: 404 });
		expect(await files.preview("~/x.md")).toMatchObject({ status: 404 });
	});

	it("认不出的格式回 415，找不到回 404", async () => {
		expect(await files.preview("teams/weekly/workspace/raw.bin")).toMatchObject({ kind: "none", status: 415 });
		expect(await files.preview("teams/weekly/workspace/nope.md")).toMatchObject({ kind: "none", status: 404 });
		expect(await files.preview("teams/weekly/workspace")).toMatchObject({ kind: "none", status: 404 });
	});
});
