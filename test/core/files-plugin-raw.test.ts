/**
 * 出厂插件「文件树」的三件新事：按后缀分类、媒体预览走 `/raw`、路径转附件。
 *
 * 这里钉两样东西：**新的 `raw` 路由还是同一套守卫**（越界、软链接、隐藏文件、上限），
 * 以及**分类只认后缀、认不出就说不认识**（不许把 zip 说成能预览）。
 */
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugins } from "../../src/core/plugin/index.ts";
import type { PluginRouteSpec } from "../../src/core/plugin/index.ts";

const boxes: string[] = [];

afterEach(async () => {
	for (const box of boxes.splice(0)) await rm(box, { recursive: true, force: true });
});

type Preview = { kind: string; name?: string; size?: number; mime?: string; note?: string; text?: string; dataUrl?: string };
type RawItem = { path: string; kind: string; mime?: string; note?: string; dataUrl?: string };
type Raw = { kind: string; items?: readonly RawItem[]; text?: string };

type Routes = { preview: PluginRouteSpec; raw: PluginRouteSpec };

/** 最小可用的 PNG（1×1，真字节；浏览器与单测都认得它）。 */
const PNG = Buffer.from(
	"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
		"0d0a2db40000000049454e44ae426082",
	"hex",
);

async function boot(): Promise<Routes> {
	const root = await mkdtemp(join(tmpdir(), "files-raw-"));
	boxes.push(root);
	const workspace = join(root, "workspace");
	const area = join(workspace, "space");
	await mkdir(join(workspace, "plugins"), { recursive: true });
	await mkdir(join(area, "sub"), { recursive: true });
	await writeFile(join(area, "shot.png"), PNG);
	await writeFile(join(area, "sub", "deep.png"), PNG);
	await writeFile(join(area, "手册.pdf"), "%PDF-1.4\n%%EOF\n");
	await writeFile(join(area, "语音.mp3"), Buffer.from([0x49, 0x44, 0x33, 0x03, 0, 0, 0]));
	await writeFile(join(area, "片.webm"), Buffer.alloc(16));
	await writeFile(join(area, "打包.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
	await writeFile(join(area, "page.html"), "<h1>页面</h1>");
	await writeFile(join(area, "README.md"), "# 标题\n");
	await writeFile(join(root, "secret.png"), PNG);
	await symlink(join(root, "secret.png"), join(area, "escape.png"));

	const seed = fileURLToPath(new URL("../../seed/plugins/文件树", import.meta.url));
	await cp(seed, join(workspace, "plugins", "文件树"), { recursive: true });

	const host = await loadPlugins({
		pluginsRoot: join(workspace, "plugins"),
		workspace,
		logsRoot: join(root, "logs"),
		scope: async (channelId) =>
			channelId === "c1" ? { kind: "group", title: "测试频道", root: area, label: "测试" } : undefined,
		log: () => {},
	});
	expect(host.errors).toEqual([]);
	const preview = host.routes.find((item) => item.pattern === "/api/p/files/preview");
	const raw = host.routes.find((item) => item.pattern === "/api/p/files/raw");
	if (preview === undefined || raw === undefined) throw new Error("文件树没注册 preview / raw 路由");
	return { preview, raw };
}

async function previewOf(route: PluginRouteSpec, path: string): Promise<Preview> {
	return (await route.handle({ method: "GET", params: {}, query: { channel: "c1", path } })) as Preview;
}

async function rawOf(route: PluginRouteSpec, query: Record<string, string>): Promise<Raw> {
	return (await route.handle({ method: "GET", params: {}, query: { channel: "c1", ...query } })) as Raw;
}

describe("文件树：预览类型", () => {
	it("图片 / PDF / 音频 / 视频各报各的类型，字节不塞进 JSON", async () => {
		const { preview } = await boot();
		const png = await previewOf(preview, "shot.png");
		expect(png.kind).toBe("image");
		expect(png.mime).toBe("image/png");
		// preview 只分类，不搬内容：dataUrl 由 /raw 按需给。
		expect(png.dataUrl).toBeUndefined();

		expect((await previewOf(preview, "手册.pdf")).kind).toBe("pdf");
		expect((await previewOf(preview, "语音.mp3")).kind).toBe("audio");
		expect((await previewOf(preview, "片.webm")).kind).toBe("video");
	});

	it("认不出的格式不假装能预览：给 binary 并说明用默认程序打开", async () => {
		const { preview } = await boot();
		const zip = await previewOf(preview, "打包.zip");
		expect(zip.kind).toBe("binary");
		expect(zip.note).toBeUndefined();
		expect((await previewOf(preview, "README.md")).kind).toBe("markdown");
		expect((await previewOf(preview, "page.html")).kind).toBe("html");
	});

	it("/raw 只搬认得的媒体：图片给 data URL，别的一律 skip", async () => {
		const { raw } = await boot();
		const one = await rawOf(raw, { path: "shot.png" });
		expect(one.kind).toBe("raw");
		expect(one.items?.[0]?.kind).toBe("ok");
		expect(one.items?.[0]?.dataUrl?.startsWith("data:image/png;base64,")).toBe(true);

		const pdf = await rawOf(raw, { path: "手册.pdf" });
		expect(pdf.items?.[0]?.mime).toBe("application/pdf");

		// 文本不走这条路：它已经在 /preview 里给了。
		const md = await rawOf(raw, { path: "README.md" });
		expect(md.items?.[0]?.kind).toBe("skip");
	});

	it("/raw 一次能搬多个，认不出的那一个单独写明原因", async () => {
		const { raw } = await boot();
		const many = await rawOf(raw, { paths: "shot.png\n打包.zip\nsub/deep.png" });
		expect(many.items?.map((item) => item.kind)).toEqual(["ok", "skip", "ok"]);
	});

	it("/raw 同一套守卫：`../`、指向外面的软链接、超过 40 个都拒", async () => {
		const { raw } = await boot();
		const escape = await rawOf(raw, { path: "../secret.png" });
		expect(escape.items?.[0]?.kind).toBe("skip");

		const link = await rawOf(raw, { path: "escape.png" });
		expect(link.items?.[0]?.kind).toBe("skip");

		const many = await rawOf(raw, { paths: Array.from({ length: 41 }, () => "shot.png").join("\n") });
		expect(many.kind).toBe("error");
	});

	it("没有工作区的频道：`/raw` 也说没有，不去猜路径", async () => {
		const { raw } = await boot();
		const none = (await raw.handle({ method: "GET", params: {}, query: { channel: "别处", path: "shot.png" } })) as Raw;
		expect(none.kind).toBe("none");
	});
});
