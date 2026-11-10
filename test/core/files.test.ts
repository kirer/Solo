/**
 * 正文里点到的文件：解路径的几条底线。
 *
 * 这条例行的存在意义是「点一个路径能看一眼」，所以判据只有三类：**认得对**
 * （两个根、图片 / 文本 / PDF）、**挡得住**（`..`、绝对路径、隐藏文件、自家的密钥与库）、
 * **说得清**（认不出的格式回 415 而不是把二进制塞进响应）。
 */
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
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
	// 仓库根给一份：模拟「模型在仓库里干活，报的是仓库相对路径」。
	await mkdir(join(box, "repo", "src", "app"), { recursive: true });
	await writeFile(join(box, "repo", "src", "app", "files.ts"), "第一行\n第二行\n第三行\n");
	layout = resolveLayout({
		appRoot: join(box, "app"),
		userRoot: join(box, "home"),
		projectRoot: join(box, "repo"),
	});
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

	it("`..` 拼出来的、带 `~` 的一律不认", async () => {
		expect(await files.preview("../etc/passwd")).toMatchObject({ status: 404 });
		expect(await files.preview("teams/../../etc/passwd")).toMatchObject({ status: 404 });
		expect(await files.preview("teams/../../../etc/passwd")).toMatchObject({ status: 404 });
		expect(await files.preview("~/x.md")).toMatchObject({ status: 404 });
		// 绝对路径里带 `..` 也一样挡：放开绝对路径不等于放开往上跳。
		expect(await files.preview(join(layout.teamsRoot, "..", "..", "..", "etc", "passwd"))).toMatchObject({ status: 404 });
	});

	it("认不出的格式回 415，找不到回 404", async () => {
		expect(await files.preview("teams/weekly/workspace/raw.bin")).toMatchObject({ kind: "none", status: 415 });
		expect(await files.preview("teams/weekly/workspace/nope.md")).toMatchObject({ kind: "none", status: 404 });
		expect(await files.preview("teams/weekly/workspace")).toMatchObject({ kind: "none", status: 404 });
	});
});

describe("放开的路径（老板 2026-11-10）", () => {
	it("绝对路径直接能开", async () => {
		const result = await files.preview(join(layout.teamsRoot, "weekly", "workspace", "report.md"));
		expect(result.kind).toBe("text");
		if (result.kind === "text") expect(result.name).toBe("report.md");
	});

	it("项目外的绝对路径也能开，但是只读的一档", async () => {
		const outside = join(box, "elsewhere", "notes.md");
		await put(outside, "外面的文件\n");
		const result = await files.preview(outside);
		expect(result.kind).toBe("text");
		// 只读：拿到的是一份可直接推给浏览器的路径，没有任何写入口。
		expect(result.kind === "text" && result.path).toBeTruthy();
	});

	it("仓库相对路径能找到项目目录", async () => {
		const result = await files.preview("src/app/files.ts");
		expect(result.kind).toBe("text");
		if (result.kind === "text") expect(result.name).toBe("files.ts");
	});

	it("带行号的路径：行号解析出来，路径还是那个文件", async () => {
		const result = await files.preview("src/app/files.ts:2");
		expect(result.kind).toBe("text");
		if (result.kind === "text") {
			expect(result.name).toBe("files.ts");
			expect(result.line).toBe(2);
		}
		// 绝对路径带行号也一样。
		const abs = await files.preview(`${join(layout.teamsRoot, "weekly", "workspace", "report.md")}:3`);
		expect(abs.kind === "text" && abs.line).toBe(3);
	});

	it("只有纯数字尾才当行号：带冒号的真文件名照旧先按原名找", async () => {
		// `report:2.md` 这种名字里有冒号的：原样找得到就直接用它，不会被拆成 `report` + 行号。
		await put(join(layout.teamsRoot, "weekly", "workspace", "report:2.md"), "冒号在名字里\n");
		const colons = await files.preview("teams/weekly/workspace/report:2.md");
		expect(colons.kind).toBe("text");
		if (colons.kind === "text") {
			expect(colons.name).toBe("report:2.md");
			expect(colons.line).toBeUndefined();
		}
		// `:0` 不算行号，去掉它那个文件不存在，所以是 404。
		expect(await files.preview("teams/weekly/workspace/report.md:0")).toMatchObject({ status: 404 });
	});

	it("指向外面的软链接不给看（相对路径那条）", async () => {
		const outside = join(box, "elsewhere", "secret.md");
		await put(outside, "外面的秘密\n");
		await symlink(outside, join(layout.teamsRoot, "weekly", "workspace", "escape.md"));
		expect(await files.preview("teams/weekly/workspace/escape.md")).toMatchObject({ kind: "none", status: 404 });
	});

	it("自家的密钥与库即使软链接过去也不给看", async () => {
		await mkdir(join(box, "elsewhere"), { recursive: true });
		await symlink(layout.settingsFile, join(box, "elsewhere", "looks-innocent.md"));
		expect(await files.preview(join(box, "elsewhere", "looks-innocent.md"))).toMatchObject({
			kind: "none",
			reason: "这个文件不开放预览",
		});
		expect(await files.preview(layout.settingsFile)).toMatchObject({ kind: "none", reason: "这个文件不开放预览" });
	});
});
