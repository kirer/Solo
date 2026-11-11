/**
 * 清掉 `ui/web/assets/` 里「`index.html` 没引的」`index-*` 产物。
 *
 * **为什么需要这一步**：`ui/app/vite.config.ts` 里 `emptyOutDir: false` 是故意的
 * （清空会把 `index.html` 一起删掉，出错时连白屏都看不到，只剩 404）。而 vite 的产物
 * 文件名带内容 hash —— 内容一变就换文件名。两者一叠加，**每跑一次构建就多躺一份旧产物，
 * 而且永远不删**。跑七次就躺七份，`ui/web/assets/` 里新旧混杂，看不出哪份是真的。
 * 2026-11-11 的 2.9.8 就是踩在这上面：包里引的不是最新那份。
 *
 * **为什么不改 `emptyOutDir`**：那条禁例有它的道理（见上）。这里只在构建**之后**动手，
 * 只删「`index.html` 明确没引的 `index-*`」，目录本身、别的文件一概不碰。
 *
 * **配套文件要跟着它的主文件走**：`index-xxx.js` 末尾有一行
 * `//# sourceMappingURL=index-xxx.js.map`，那个 `.map` 是它自己的配套，`index.html`
 * 里当然不会出现。所以判断依据不是「`index.html` 引没引这个名字」，而是
 * 「这个名字是不是某个**被引用的主文件**的配套」。只按前者写会把当前版的 `.map`
 * 一起删掉（第一版就是这么错的，1471 行的 `.map` 没了）。
 *
 * **两条保险**（Solo 2026-11-11 要求）：
 * 1. 删之前**先把要删的列表打出来**，空列表就跳过并明说「没有要删的」。
 * 2. **`index.html` 读失败 / 解析不出任何产物引用时，一个字节都不删**，直接报错退出。
 *    绝不允许「读不到 index.html」被当成「没有引用，全删了吧」——那会把前端清空。
 */
import { readdir, readFile, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const webRoot = join(repoRoot, "ui", "web");
const assetsDir = join(webRoot, "assets");
const indexHtml = join(webRoot, "index.html");

/** `index.html` 里引用的每一个 `assets/<名字>`。 */
function referencedAssets(html: string): Set<string> {
	const found = new Set<string>();
	for (const m of html.matchAll(/assets\/([^\s"'?#]+)/g)) {
		const name = m[1];
		if (name) found.add(name);
	}
	return found;
}

/**
 * 一个产物文件是不是「活的」：自己被引用，或者是某个被引用主文件的配套 `.map`。
 *
 * `index-xxx.js.map` 配的是 `index-xxx.js`，`index-xxx.css.map` 配的是 `index-xxx.css`。
 */
function isAlive(name: string, referenced: Set<string>): boolean {
	if (referenced.has(name)) return true;
	for (const suffix of [".map"]) {
		if (!name.endsWith(suffix)) continue;
		const main = name.slice(0, -suffix.length);
		if (referenced.has(main)) return true;
	}
	return false;
}

async function main(): Promise<void> {
	// 保险二：读不到 index.html 就停手，不删任何东西。
	let html: string;
	try {
		html = await readFile(indexHtml, "utf8");
	} catch (error) {
		throw new Error(
			`读不到 ${indexHtml}，不敢删任何产物（可能是构建失败或路径变了）。` +
				`先把 index.html 找回来再说：${String(error)}`,
		);
	}

	const referenced = referencedAssets(html);
	if (referenced.size === 0) {
		throw new Error(
			`${indexHtml} 里没解析出任何 assets/ 引用，不敢删任何产物 —— ` +
				`这多半说明 index.html 坏了或者产物结构变了，删下去会把前端清空。`,
		);
	}

	let entries: string[];
	try {
		entries = await readdir(assetsDir);
	} catch {
		console.log("[资产清理] 没有 assets 目录，跳过。");
		return;
	}

	// 只认 vite 产物的那几种后缀，别的文件（哪怕叫 index- 开头）一概不碰。
	const stale = entries.filter(
		(name) =>
			name.startsWith("index-") &&
			/\.(js|css)(\.map)?$/.test(name) &&
			!isAlive(name, referenced),
	);

	// 保险一：先把列表打出来。
	if (stale.length === 0) {
		console.log("[资产清理] 没有要删的旧产物，跳过。");
		return;
	}
	console.log(`[资产清理] index.html 引用了 ${referenced.size} 个产物：${[...referenced].join("、")}`);
	console.log(`[资产清理] 要删 ${stale.length} 个旧产物：`);
	for (const name of stale) console.log(`  - ${name}`);

	await Promise.all(stale.map((name) => rm(join(assetsDir, name), { force: true })));
	console.log(`[资产清理] 已删 ${stale.length} 个。`);
}

await main();
