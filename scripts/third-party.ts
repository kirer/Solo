/**
 * 把第三方声明从 `docs/THIRD-PARTY.md` 拷进前端产物目录。
 *
 * **为什么要有这一步**：声明是「界面里能点开看」的东西（设置 → 关于 → 第三方声明），
 * 而界面只能发 `ui/web/` 里的静态资源。`docs/` 不在 `ui/web/` 里，`asar: false` 的
 * 打包版也没把它摆到界面够得着的位置。
 *
 * **为什么不是手抄一份进 `public/`**：手抄就会有两份，改一份忘一份，最后用户看到的是旧的。
 * 这里只做「拷贝 + 校验」，`docs/THIRD-PARTY.md` 是唯一来源。
 *
 * 跑在 `npm run ui:build` 之前（见 `package.json`）。自己也可以单独跑：
 * `node --experimental-strip-types scripts/third-party.ts`
 */
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const source = join(repoRoot, "docs", "THIRD-PARTY.md");
const target = join(repoRoot, "ui", "app", "public", "THIRD-PARTY.md");

/**
 * 声明里必须出现的组件。少一个就说明有人删了整节，而界面那边会安静地显示一份残缺的声明 ——
 * 这正是「漏了 29MB 微软 dylib」那次的形状，所以在这儿挡一道。
 */
const REQUIRED = ["sherpa-onnx", "onnxruntime", "dicebear", "earendil-works"] as const;

async function main(): Promise<void> {
	let text: string;
	try {
		text = await readFile(source, "utf8");
	} catch {
		throw new Error(`找不到 ${source}。第三方声明是随包发的东西，不能在构建时缺席。`);
	}

	const missing = REQUIRED.filter((name) => !text.includes(name));
	if (missing.length > 0) {
		throw new Error(`${source} 里缺了这些组件的声明：${missing.join("、")}。加依赖时别忘了同步这份文件。`);
	}

	await mkdir(dirname(target), { recursive: true });
	await copyFile(source, target);

	const info = await stat(target);
	console.log(`第三方声明已就位：${target}（${String(info.size)} 字节，${String(REQUIRED.length)} 个必查组件齐全）`);
}

await main();
