/**
 * 正文里的本地图（老板 2026-11-10）：一段**本地图片路径**直接画成图。
 *
 * 三条判据：
 * 1. **画得对**：反引号里的 / 链接里的 / 光秃秃的图片路径，都变成一张走预览接口的 `<img>`；
 * 2. **不多画**：非图片后缀（`.md`）仍然只是可点的 `.md-path`，一次也别变成破图；
 * 3. **不放宽**：`javascript:`、`//host` 这类地址照旧被拒；路径能不能真读仍然由后端
 *    `files.preview` 的三条硬线说了算 —— 这一层只是「要不要画」。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MD_IMAGE_FAIL_CLASS, renderMarkdown } from "../../ui/app/src/lib/markdown.ts";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const preview = (path: string) => `/api/files/preview?path=${encodeURIComponent(path)}`;

describe("正文里的本地图", () => {
	it("反引号里的图片路径画成图", () => {
		const html = renderMarkdown("看这张 `teams/weekly/workspace/shot.png`");
		expect(html).toContain(`<span class="md-img"><img src="${preview("teams/weekly/workspace/shot.png")}"`);
		// 原来是「可点的一行字」，现在不该再留下那颗 .md-path
		expect(html).not.toContain("code.md-path");
	});

	it("链接写法的图片路径画成图", () => {
		const html = renderMarkdown("[截图](teams/weekly/workspace/shot.png)");
		expect(html).toContain(`<img src="${preview("teams/weekly/workspace/shot.png")}"`);
	});

	it("光秃秃的图片路径也画成图", () => {
		const html = renderMarkdown("图在 teams/weekly/workspace/shot.png 这里");
		expect(html).toContain(`<img src="${preview("teams/weekly/workspace/shot.png")}"`);
	});

	it("非图片后缀不变：`.md` 仍然只是可点的路径", () => {
		const html = renderMarkdown("`teams/weekly/workspace/report.md`");
		expect(html).toContain('class="md-path"');
		expect(html).not.toContain("md-img");
	});

	it("外链图片行为不变，危险协议仍然被拒", () => {
		expect(renderMarkdown("![](https://example.com/a.png)")).toContain('<img src="https://example.com/a.png"');
		const bad = renderMarkdown("`javascript:alert(1)`");
		expect(bad).not.toContain("md-img");
		expect(bad).not.toContain("<img");
	});

	it("启动时装了破图兜底，类名两边共用", () => {
		expect(read("../../ui/app/src/main.tsx")).toContain("installBrokenImages(");
		// 那颗兜底按钮的类名只在 `markdown.ts` 定义一次，监听处 import 它 —— 两边不会漂。
		expect(read("../../ui/app/src/lib/links.ts")).toContain("button.className = MD_IMAGE_FAIL_CLASS");
		expect(MD_IMAGE_FAIL_CLASS).toBe("md-img-fail");
	});
});
