import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 前端构建。
 *
 * 产物直接写回 `ui/web/` —— 服务端就是照那个目录发静态资源的（`src/shell/serve.ts` 的
 * `serveStatic`），所以不需要给它讲「构建目录」这个概念，它一直是「发 ui/web」。
 *
 * - `emptyOutDir: false`：`ui/web/` 里还躺着被上传的附件预览之外的东西吗？没有。
 *   但**不能**清空 —— 出错时它会把 index.html 一起删掉，那连「白屏」都看不到了，
 *   只剩 404。宁可留旧文件，让 new 覆盖 old。
 * - `assetsDir: "assets"`：与 `serveStatic` 的 SPA 回退规则相容（带扩展名的找不到就 404）。
 */
export default defineConfig({
	root: "ui/app",
	publicDir: "public",
	build: {
		outDir: "../web",
		emptyOutDir: false,
		assetsDir: "assets",
		sourcemap: true,
		target: "es2022",
	},
	plugins: [react()],
});
