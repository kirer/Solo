/**
 * 把插件要用的大块前端资源（目前是回声消除的 wasm 和它的胶水 JS）从 `node_modules`
 * 拷进前端产物目录 `ui/web/`。
 *
 * **为什么不像别的东西那样放 `seed/`**：`seed/` 有一条 500 KB 的体积契约
 * （`test/core/seed-contract.test.ts`），这个文件 255 KB，塞进去就吃掉一半余量。
 * 它本来也不是「种子内容」—— 是随包分发的运行时二进制，`node_modules` 里已经有一份，
 * 构建时拷过去就行，不要往仓里再存一遍。
 *
 * **只拷 JS，不拷 `.wasm`**：这份胶水把 wasm 整个 base64 内联在自己身体里了
 * （第 104 行，227 KB 的 base64 段），`locateFile` 压根不会被问到。发一个用不上的
 * 170 KB 二进制只是浪费带宽和包体。
 *
 * **为什么文件名带版本号**：路由回 `immutable` 长缓存，升级换文件名就换 URL，
 * 浏览器不可能拿旧 wasm 配新 JS。所以这里写死的文件名必须跟着依赖版本一起改，
 * 版本对不上就让构建失败，而不是安静地发一个旧文件。
 */
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const source = join(repoRoot, "node_modules", "@ennuicastr", "webrtcaec3.js", "dist");
const target = join(repoRoot, "ui", "web");

/** 要拷的东西。`from` 是包里的文件名，`to` 是发出去的 URL 上那个名字。 */
const ASSETS = [{ from: "webrtcaec3-0.3.0.js", to: "webrtcaec3.js" }] as const;

async function main(): Promise<void> {
	await mkdir(target, { recursive: true });
	for (const asset of ASSETS) {
		const from = join(source, asset.from);
		const to = join(target, asset.to);
		try {
			await stat(from);
		} catch {
			throw new Error(
				`找不到 ${from}。插件要用它做回声消除；升级 @ennuicastr/webrtcaec3.js 之后，` +
					`这里的文件名要跟着改（发出去的 URL 靠文件名当缓存键）。`,
			);
		}
		await copyFile(from, to);
	}
}

await main();
