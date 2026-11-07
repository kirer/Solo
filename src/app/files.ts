/**
 * 消息里点到的文件：把一句「`teams/x/workspace/a.md`」解成一份可预览的文件。
 *
 * 两个根都认（模型写的路径多是从用户根出发的 `teams/…`、`members/…`，也有从应用根
 * 出发的 `uploads/…`）：先用户根、再应用根，谁先命中算谁。
 *
 * 三条底线：
 * 1. **只认相对路径** — 绝对路径、`~`、`..` 一律不认，避免这条例行变成「读这台机器上
 *    任意文件」的口子；
 * 2. **解析完软链接再判越界** — 字符串前缀检查挡不住工作区里一个指向外部的软链接；
 * 3. **自家的密钥与库不开放** — `settings.json`、`.secrets.json`、`core.sqlite`、
 *    播种清单即使被点到也回「不开放预览」。
 *
 * 认得的只有三种：图片、PDF、文本（HTML / SVG 一律降成文本 —— 它们能在同源里执行脚本，
 * 和附件那条 `INLINE_IMAGE` 不含 svg 是同一个理由）。其余老实说「不支持预览」。
 */
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { Layout } from "../core/layout.ts";
import { fileStatAt, realPathOrUndefined } from "../core/runtime/io.ts";

/** 一份能交给界面去画的东西；`none` 是「说给人听的一句原因」。 */
export type FilePreview =
	| {
			readonly kind: "image" | "pdf" | "text";
			readonly path: string;
			readonly name: string;
			readonly size: number;
			readonly mime: string;
	  }
	| { readonly kind: "none"; readonly name: string; readonly reason: string; readonly status: 404 | 415 };

const IMAGE_MIME: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	avif: "image/avif",
};

/** 能按文本读的扩展名。HTML / SVG 也在这里，只是 mime 会降成 `text/plain`。 */
const TEXT_EXT = new Set([
	"txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "xml", "yml", "yaml",
	"toml", "ini", "env", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "html", "htm",
	"svg", "sh", "bash", "zsh", "py", "sql",
]);

/** 没有扩展名的文件（`LICENSE`、`Makefile`）按文本读；有扩展名但不认识的就不猜。 */
const MAX_TEXT = 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_PDF = 16 * 1024 * 1024;

function extOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function createFiles(layout: Layout) {
	/** 点到了也不给看：密钥、库、播种清单。 */
	const denied = [layout.settingsFile, layout.secretsFile, layout.databasePath, layout.seedManifestFile];

	async function denyList(): Promise<readonly string[]> {
		const hits = await Promise.all(denied.map((path) => realPathOrUndefined(path)));
		return hits.filter((path): path is string => path !== undefined);
	}

	/** 说不了的东西：`status` 让路由直接回对（404 = 没有，415 = 有但不能预览）。 */
	function none(name: string, reason: string, status: 404 | 415 = 404): FilePreview {
		return { kind: "none", name, reason, status };
	}

	async function preview(input: string): Promise<FilePreview> {
		const wanted = input.trim();
		if (wanted === "") return none("", "没有指定文件");
		if (isAbsolute(wanted) || wanted.startsWith("~")) return none(basename(wanted), "只认相对路径");
		const segments = wanted.split(/[\\/]+/);
		if (segments.some((segment) => segment === "..")) return none(basename(wanted), "路径不能往上走");
		if (segments.some((segment) => segment.startsWith(".") && segment !== ".")) {
			return none(basename(wanted), "隐藏文件不预览");
		}

		const blocked = await denyList();
		for (const root of [layout.userRoot, layout.appRoot]) {
			const base = await realPathOrUndefined(root);
			if (base === undefined) continue;
			const real = await realPathOrUndefined(resolve(base, wanted));
			if (real === undefined) continue;
			const back = relative(base, real);
			if (back.startsWith("..") || isAbsolute(back)) continue;
			if (blocked.includes(real)) return none(basename(real), "这个文件不开放预览");
			const info = await fileStatAt(real);
			// 目录：换下一个根再试一次，都不行就是「找不到」。
			if (info === undefined) continue;

			const name = basename(real);
			const ext = extOf(name);
			if (ext in IMAGE_MIME) {
				if (info.size > MAX_IMAGE) return none(name, "图片太大（超过 8 MB），到工作台里看", 415);
				return { kind: "image", path: real, name, size: info.size, mime: IMAGE_MIME[ext] ?? "application/octet-stream" };
			}
			if (ext === "pdf") {
				if (info.size > MAX_PDF) return none(name, "PDF 太大（超过 16 MB），到工作台里看", 415);
				return { kind: "pdf", path: real, name, size: info.size, mime: "application/pdf" };
			}
			const text = ext === "" || TEXT_EXT.has(ext);
			if (!text) return none(name, "这种格式不支持预览", 415);
			if (info.size > MAX_TEXT) return none(name, "文件太大（超过 1 MB），到工作台里看", 415);
			// 一律 text/plain：HTML / SVG 能在同源里执行脚本，别当页面渲染。
			return { kind: "text", path: real, name, size: info.size, mime: "text/plain; charset=utf-8" };
		}
		return none(basename(wanted), "找不到这个文件");
	}

	return { preview };
}
