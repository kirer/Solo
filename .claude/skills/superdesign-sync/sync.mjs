#!/usr/bin/env node
/**
 * 把「现在的界面」同步到 Superdesign 画布。
 *
 * 四步，一条命令：构建界面 → 用无头 Chrome 走一遍每一屏并取 DOM → 打成一屏一个自包含 HTML
 * （内嵌 CSS、头像转 data URI、字体指回 Brand Asset）→ `import-design-draft` 推上去。
 *
 * 不调生成模型，所以**不花额度**；画布上是像素级还原，不是重画的近似版。
 *
 *   node .claude/skills/superdesign-sync/sync.mjs              # 只抓 + 打包，打印推送命令
 *   node .claude/skills/superdesign-sync/sync.mjs --push       # 抓 + 打包 + 推到画布
 *   node .claude/skills/superdesign-sync/sync.mjs --push --only 01-group-dark,12-group-light
 *   node .claude/skills/superdesign-sync/sync.mjs --no-build   # 跳过 ui:build（刚构建过）
 *
 * 状态在 `.superdesign/sync.json`（项目 id、每屏的草稿 id 与版本、上次同步的 commit）。
 * 第一次跑需要先有 projectId —— 用 `create-project` 建一个，或者从已有画布地址里抄。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "./cdp.mjs";
import { SCREENS, capture } from "./states.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const TMP = join(ROOT, ".superdesign", "tmp");
const STATE_FILE = join(ROOT, ".superdesign", "sync.json");
const CLI = "npx";
const CLI_ARGS = ["--yes", "@superdesign/cli@latest"];
const USER_REQUEST = "根据 git 新提交，把界面同步到画布。";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
	const at = args.indexOf(name);
	return at === -1 ? fallback : args[at + 1];
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.log(...parts);

function loadState() {
	if (!existsSync(STATE_FILE)) return { projectId: "", origin: "http://127.0.0.1:7788", drafts: {} };
	return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function head() {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

/** 上次同步之后界面改了什么 —— 只用来在终端里说一句，不参与判断。 */
function changedSince(commit) {
	if (commit === "") return [];
	try {
		return execFileSync("git", ["diff", "--name-only", `${commit}..HEAD`, "--", "ui/app"], {
			cwd: ROOT,
			encoding: "utf8",
		})
			.split("\n")
			.filter((line) => line !== "");
	} catch {
		return [];
	}
}

/** 编译后的 CSS：字体换成已上传的 Brand Asset，`body[data-*]` 改成跟着根 div 走。 */
function readCss(projectId) {
	const index = readFileSync(join(ROOT, "ui/web/index.html"), "utf8");
	const match = /assets\/(index-[A-Za-z0-9_-]+\.css)/.exec(index);
	if (match === null) throw new Error("ui/web/index.html 里找不到 CSS —— 先跑 npm run ui:build");
	let css = readFileSync(join(ROOT, "ui/web/assets", match[1]), "utf8");
	const brandBase = `https://vgbujcuwptvheqijyjbe.supabase.co/storage/v1/object/public/hmac-uploads/projects/${projectId}/brand-assets`;
	for (const weight of ["light", "regular", "medium"]) {
		css = css.replace(
			`url(../fonts/montserrat-${weight}.woff2)`,
			`url(${brandBase}/solo-brand-montserrat-${weight}/montserrat-${weight}.woff2)`,
		);
	}
	return css.replaceAll("body[data-", "[data-");
}

/** 头像走的是 `/api/avatar/...`：导进去以后服务不在，所以转成 data URI 一起带走。 */
async function inlineAvatars(html, origin, cache) {
	for (const path of new Set([...html.matchAll(/src="(\/api\/avatar\/[^"]*)"/g)].map((m) => m[1]))) {
		if (!cache.has(path)) {
			const response = await fetch(origin + path);
			if (!response.ok) throw new Error(`头像取不到：${path} → ${String(response.status)}`);
			const body = Buffer.from(await response.arrayBuffer());
			cache.set(path, `data:${response.headers.get("content-type") ?? "image/svg+xml"};base64,${body.toString("base64")}`);
		}
		html = html.replaceAll(`src="${path}"`, `src="${cache.get(path)}"`);
	}
	return html;
}

/**
 * 系统 note 里可能贴着脚本正文，`${...}` 和花括号会被导入校验当成「没解析的模板」拒掉。
 * 换成实体，渲染出来还是原来那些字符。
 */
function escapeTemplateText(html) {
	return html.replace(/<span class="note-text">([\s\S]*?)<\/span>/g, (_all, text) =>
		`<span class="note-text">${text
			.replaceAll("$", "&#36;")
			.replaceAll("{", "&#123;")
			.replaceAll("}", "&#125;")}</span>`,
	);
}

/** 把一张 DOM 快照包成一份完整文档：一个屏幕、一个根 div、没有脚本。 */
function pack(raw, screen, css) {
	const body = /<body([^>]*)>([\s\S]*)<\/body>\s*$/.exec(raw);
	if (body === null) throw new Error(`${screen.name}：快照不是一份完整的 body`);
	const keep = ["data-pane", "data-layout", "data-side"]
		.map((attr) => new RegExp(`${attr}="([^"]*)"`).exec(body[1]))
		.filter((match) => match !== null)
		.map((match) => `${match[0]}`);
	let inner = body[2].replace('<div id="root">', `<div id="root" ${keep.join(" ")}>`, 1);
	inner = inner.replace(/<script[\s\S]*?<\/script>/g, "");
	inner = escapeTemplateText(inner);
	return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${screen.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${screen.title}</title>
<style>
${css}
</style>
</head>
<body>
${inner}
</body>
</html>
`;
}

function importDraft({ projectId, screen, file, draftId }) {
	const common = ["import-design-draft", "--html-file", file, "--user-request", USER_REQUEST];
	const argv =
		draftId === undefined
			? [...common, "--project-id", projectId, "--title", screen.title, "--width", String(screen.width), "--height", String(screen.height)]
			: [...common, "--into", draftId];
	const result = spawnSync(CLI, [...CLI_ARGS, ...argv], { cwd: ROOT, encoding: "utf8" });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const id = /draftId\s+([0-9a-f-]{36})/.exec(output)?.[1];
	if (id === undefined) {
		log(`  ✗ ${screen.name}\n${output.split("\n").filter((line) => line.trim() !== "").slice(-4).join("\n")}`);
		return undefined;
	}
	return id;
}

async function main() {
	const state = loadState();
	const origin = value("--origin", state.origin ?? "http://127.0.0.1:7788");
	const projectId = value("--project", state.projectId ?? "");
	const only = value("--only", "");
	const wanted = only === "" ? null : new Set(only.split(",").map((name) => name.trim()));

	const lastCommit = state.lastCommit ?? "";
	const currentCommit = head();
	const changed = changedSince(lastCommit);
	log(`上次同步：${lastCommit === "" ? "没有记录" : lastCommit}　现在：${currentCommit}`);
	if (changed.length > 0) log(`界面改动 ${String(changed.length)} 个文件：${changed.slice(0, 6).join(" ")}${changed.length > 6 ? " …" : ""}`);

	if (!flag("--no-build")) {
		log("构建界面…");
		const build = spawnSync("npm", ["run", "ui:build"], { cwd: ROOT, stdio: "inherit" });
		if (build.status !== 0) throw new Error("npm run ui:build 失败");
	}

	const probe = await fetch(origin).catch(() => null);
	if (probe === null || !probe.ok) {
		throw new Error(`服务没起来：${origin}。先 npm start（或用 --origin 指到别处）`);
	}

	mkdirSync(join(TMP, "dom"), { recursive: true });
	mkdirSync(join(TMP, "drafts"), { recursive: true });

	const browser = await Browser.launch();
	const packed = [];
	try {
		const page = await browser.newPage();
		const grab = async (name) => {
			const html = await page.eval("document.body.outerHTML");
			writeFileSync(join(TMP, "dom", `${name}.html`), html);
			log(`  抓到 ${name}`);
		};
		await capture(page, { origin, grab, wait: sleep });
	} finally {
		await browser.close();
	}

	const css = readCss(projectId === "" ? "2fdc3a74-5f3e-4cb6-93c0-fac5062bcec4" : projectId);
	const avatars = new Map();
	for (const screen of SCREENS) {
		if (wanted !== null && !wanted.has(screen.name)) continue;
		const raw = readFileSync(join(TMP, "dom", `${screen.name}.html`), "utf8");
		let doc = pack(raw, screen, css);
		doc = await inlineAvatars(doc, origin, avatars);
		const file = join(TMP, "drafts", `${screen.name}.html`);
		writeFileSync(file, doc);
		packed.push({ screen, file, bytes: doc.length });
	}
	log(`打包 ${String(packed.length)} 屏，头像 ${String(avatars.size)} 个已内嵌`);

	if (!flag("--push")) {
		log("\n没有推（加 --push）：");
		for (const { screen, file } of packed) {
			const draftId = state.drafts?.[screen.name]?.draftId;
			log(
				draftId === undefined
					? `  npx --yes @superdesign/cli@latest import-design-draft --project-id ${projectId} --title "${screen.title}" --width ${String(screen.width)} --height ${String(screen.height)} --html-file ${file}`
					: `  npx --yes @superdesign/cli@latest import-design-draft --into ${draftId} --html-file ${file}`,
			);
		}
		return;
	}

	if (projectId === "") throw new Error("还没有 projectId：先 create-project，或写进 .superdesign/sync.json");

	log("推到画布…");
	state.projectId = projectId;
	state.origin = origin;
	state.drafts = state.drafts ?? {};
	for (const { screen } of packed) {
		const known = state.drafts[screen.name];
		const draftId = importDraft({ projectId, screen, file: join(TMP, "drafts", `${screen.name}.html`), draftId: known?.draftId });
		if (draftId === undefined) continue;
		const version = known?.draftId === undefined ? 1 : (known.version ?? 1) + 1;
		state.drafts[screen.name] = { draftId, title: screen.title, theme: screen.theme, version };
		log(`  ✓ ${screen.name} → v${String(version)} ${draftId}`);
	}
	// 只推了一部分时不能记 commit：否则下次会以为其余几屏也同步过了。
	if (wanted === null) state.lastCommit = currentCommit;
	state.updatedAt = new Date().toISOString();
	saveState(state);
	log(`\n画布：https://superdesign.dev/projects/${projectId}`);
}

main().catch((error) => {
	console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
