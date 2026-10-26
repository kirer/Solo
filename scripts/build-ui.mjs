#!/usr/bin/env node
/**
 * 前端打包：把 `ui/` 的 24 个请求合成 2 个（1 个 CSS + 1 个 JS）。
 *
 * 为什么需要它：`ui/` 是「原生 JS、无框架、无构建」的，好处是改完刷新就生效，
 * 坏处是首屏要发 **24 个请求**。走 Cloudflare 隧道时远端在境外，
 * 每个请求都要跨境往返一次，24 个请求的握手与排队成本远大于字节成本本身。
 *
 * 这不是「引入构建流程」，而是**可选的产物**：
 * - 构建产物落在 `ui/dist/`（已 gitignore），源码仍是 `ui/` 里那 25 个文件，
 *   照旧直接改、直接读，没有任何东西被编译成中间态；
 * - 没有 `ui/dist/` 时服务端**自动回退**到源码目录（见 `resolveStaticRoot`），
 *   所以 `git clone` 完 `npm start` 依然能跑，不需要先 `npm install` esbuild；
 * - 源码比产物新时服务端也回退（见 `distIsStale`），不会出现「改了代码没生效」。
 *
 * 用法：npm run ui:build
 */
import { readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UI = join(ROOT, "ui");
const DIST = join(UI, "dist");

/** 读取 `ui/index.html`，把它引用的 CSS / JS 找出来，顺序即<link>顺序。 */
async function readEntry(html) {
	const css = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>/g)].map((m) => m[1]);
	const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"[^>]*>/g)].map((m) => m[1]);
	if (css.length === 0 || scripts.length === 0) {
		throw new Error("ui/index.html 里没找到 CSS / JS 引用，构建脚本与页面结构脱节了");
	}
	return { css, scripts };
}

/**
 * 拼 CSS。
 *
 * 多个文件全部包进 `@layer` 之外的原样拼接 —— 顺序就是 `<link>` 顺序，
 * 与浏览器原来的层叠结果完全一致（`tokens.css` 定义变量、`motion.css` 覆盖动效）。
 * 不用 esbuild 的 CSS 打包：那会做 minify，改动 `ui/css` 后 diff 变噪音，而
 * CSS 压缩收益远小于「少 7 个请求」。
 */
async function buildCss(files) {
	const parts = [];
	for (const file of files) {
		const text = await readFile(join(UI, file), "utf8");
		parts.push(`/* ── ${file} ── */\n${text}`);
	}
	return parts.join("\n");
}

/** 改写 index.html：8 个 <link> → 1 个，1 个 <script> → 1 个（其余原样保留）。 */
function rewriteHtml(html, cssFiles, scriptFiles) {
	let out = html;
	for (const file of cssFiles) {
		out = out.replace(new RegExp(`\\s*<link\\b[^>]*href="${escapeRe(file)}"[^>]*>\\n?`, "g"), "\n");
	}
	// 在原来第一个 <link> 的位置插一个总样式表
	out = out.replace(/(<\/head>)/, `\t<link rel="stylesheet" href="app.css">\n$1`);
	for (const file of scriptFiles) {
		out = out.replace(new RegExp(`\\s*<script\\b[^>]*src="${escapeRe(file)}"[^>]*><\\/script>\\n?`, "g"), "\n");
	}
	out = out.replace(/(<\/body>)/, `\t<script type="module" src="app.js"></script>\n$1`);
	return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 源码目录里最新的 mtime（不含 dist 自身）。
 *
 * 写进 `ui/dist/.stamp`，服务端用同一套遍历算出「现在」的最新 mtime 与之比较。
 * 两边逻辑必须一致，否则会出现「改了源码但服务端认为产物还新」的静默失效。
 */
async function newestSourceMtime(dir, skip) {
	let newest = 0;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (full === skip) continue;
		const info = await stat(full);
		newest = Math.max(newest, entry.isDirectory() ? await newestSourceMtime(full, skip) : info.mtimeMs);
	}
	return newest;
}

async function main() {
	const html = await readFile(join(UI, "index.html"), "utf8");
	const { css, scripts } = await readEntry(html);
	if (scripts.length !== 1) {
		throw new Error(`预期 ui/index.html 只有一个 entry script，实际 ${scripts.length} 个：${scripts.join(", ")}`);
	}

	await rm(DIST, { recursive: true, force: true });
	await mkdir(DIST, { recursive: true });

	const cssText = await buildCss(css);
	await writeFile(join(DIST, "app.css"), cssText);

	const result = await esbuild.build({
		entryPoints: [join(UI, scripts[0])],
		outfile: join(DIST, "app.js"),
		bundle: true,
		format: "esm",
		platform: "browser",
		target: ["es2022"],
		// 关掉 splitting：目标就是**一个** JS 请求。动态 import（dev-fixtures）会被
		// 内联进同一个文件，仍然保持惰性执行。
		splitting: false,
		// three.js 必须 extern：它是惰性依赖，共 691 KB / br 158 KB。
		// 不加这一行 esbuild 会把它内联进主包，首屏变成 713 KB —— 比不打包还差。
		// 保留 `../vendor/three.module.js` 这个 specifier：app.js 住在 `ui/dist/`，
		// 相对解析后正好是 `ui/vendor/three.module.js`，与源码目录下的行为一致。
		external: ["../vendor/three.module.js"],
		minify: true,
		sourcemap: false,
		legalComments: "none",
		write: false,
		logLevel: "warning",
		// three.js 自带 `eval` 警告之类，与本项目无关，静音
		logOverride: { "direct-eval": "silent" },
	});

	await writeFile(join(DIST, "app.js"), result.outputFiles[0].contents);
	await writeFile(join(DIST, "index.html"), rewriteHtml(html, css, scripts));
	// 产物戳记：服务端拿它和「源码最新 mtime」比较，产物比源码旧就自动回退到源码。
	await writeFile(join(DIST, ".stamp"), String(await newestSourceMtime(UI, DIST)));

	const jsStat = await stat(join(DIST, "app.js"));
	const jsBytes = await readFile(join(DIST, "app.js"));
	const cssBytes = Buffer.from(cssText);
	const raw = await Promise.all([...css, ...scripts].map(async (f) => (await stat(join(UI, f))).size));
	const rawTotal = raw.reduce((a, b) => a + b, 0);
	const gzipTotal = gzipSync(jsBytes).length + gzipSync(cssBytes).length;
	const brTotal = brotliCompressSync(jsBytes).length + brotliCompressSync(cssBytes).length;

	console.log("ui/dist/ 已生成");
	console.log(`  请求数      ${css.length + scripts.length + 1} → 3（index.html + app.css + app.js）`);
	console.log(
		`  未压缩      ${(rawTotal / 1024).toFixed(0)} KB → ${((jsStat.size + cssBytes.length) / 1024).toFixed(0)} KB`,
	);
	console.log(`  gzip        ${(gzipTotal / 1024).toFixed(0)} KB`);
	console.log(`  brotli      ${(brTotal / 1024).toFixed(0)} KB`);
}

main().catch((error) => {
	console.error("ui 构建失败：", error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
