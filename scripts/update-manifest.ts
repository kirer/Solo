/**
 * 生成发布清单 + 签名（ADR-029）。**一条命令出全部四份清单**，格式只在这一处改。
 *
 *   npm run update:manifest -- --feed feed --version 2.0.1 --tag v2.0.1 \
 *     --file darwin=release/Solo-2.0.1-arm64.zip \
 *     --file win32=release/Solo-2.0.1-x64.zip \
 *     --plugins-src plugins-src
 *
 * 产物（全部落在 `--feed` 目录）：
 * - `latest-mac.json` / `latest-win.json` + 各自的 `.sig`：更新清单（`files` 里是 sha512）；
 * - `plugins.json` + `.sig`：**插件清单**（独立一份，`plugins` 数组里是每个插件 bundle 的 sha256）；
 * - `plugin-*.json`：插件包（纯文本 bundle，见 `src/shell/plugin-download.ts` 的说明）；
 * - `release-notes.md`：本版 `feat`/`fix` 的标题，给 Release 正文和界面弹窗共用。
 *
 * 为什么清单里要带 `notes`：更新弹窗以前只写「有新版本」，用户不知道改了什么（闻舒 2026-11-12）。
 * `notes` 由**提交标题生成**、不手抄 —— 手抄必然忘，一忘就是「弹窗说改了 A、实际改了 B」。
 * 老客户端的 `parseManifest` 只认 `version`/`files`，多一个字段会被忽略，不会破。
 *
 * 私钥默认 `~/.solo-update-key.pem`，可用 `--key` 指定。**同一条验签链路**
 * （`src/core/signing.ts`）签这三份东西，只是清单文件各是各的。
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

const PLATFORM_MANIFEST: Record<string, string> = { darwin: "latest-mac.json", win32: "latest-win.json" };

/**
 * 插件名 → 线上资产名。**必须是 ASCII**：中文名在 URL 里要编码，各处都要多一层错。
 *
 * 这张表要和 `src/shell/plugin-download.ts` 的 `REMOTE_PLUGINS` 对得上；
 * `test/core/plugin-download.test.ts` 会按真文件生成一遍清单来断言两边没走散。
 */
export const PLUGIN_ASSETS: Record<string, string> = {
	悬浮球: "plugin-orb.json",
	文件树: "plugin-file-tree.json",
	IM机器人: "plugin-im-bot.json",
	Token统计: "plugin-token-stats.json",
	模型管理: "plugin-model-manager.json",
};

/** 一个插件目录里的文本文件：相对路径（`/` 分隔）→ 内容。按路径排序，产物可复现。 */
export function readPluginDir(root: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (entry.name === ".DS_Store") continue;
			out.set(relative(root, path).split(sep).join("/"), readFileSync(path, "utf8"));
		}
	};
	walk(root);
	return out;
}

/** 一个插件打成一份纯文本 bundle（见 `src/shell/plugin-download.ts`：不用 zip，跨平台一致）。 */
export function bundleText(files: Map<string, string>): string {
	const body: Record<string, string> = {};
	for (const key of [...files.keys()].sort()) body[key] = files.get(key) ?? "";
	return `${JSON.stringify({ files: body }, null, "\t")}\n`;
}

/**
 * `plugins-src/` 里每个插件目录 → 清单里那一条。返回 `[清单文本, 资产名 → 文本]`。
 *
 * 目录里出现没登记过的插件就直接报错：**没登记 = 用户永远下不到，而且不会有任何东西变红**
 * （Solo 2026-11-12）。
 */
export function buildPluginManifest(srcRoot: string, version: string): {
	readonly text: string;
	readonly assets: ReadonlyMap<string, string>;
	readonly bundled: readonly string[];
} {
	const dirs = readdirSync(srcRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const plugins: {
		name: string;
		version: string;
		file: string;
		sha256: string;
		size: number;
	}[] = [];
	const assets = new Map<string, string>();
	for (const name of dirs) {
		const file = PLUGIN_ASSETS[name];
		if (file === undefined) throw new Error(`plugins-src/${name} 没在 PLUGIN_ASSETS 里登记：线上不会有它的包，用户永远下不到`);
		const text = bundleText(readPluginDir(join(srcRoot, name)));
		const bytes = Buffer.from(text, "utf8");
		assets.set(file, text);
		plugins.push({
			name,
			version,
			file,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			size: bytes.byteLength,
		});
	}
	return {
		text: `${JSON.stringify({ schema: 1, plugins }, null, 2)}\n`,
		assets,
		bundled: dirs,
	};
}

/** 提交标题 → 弹窗里那条人话：只留 `feat` / `fix`，去掉前缀，去重，保持原顺序。 */
export function releaseNotes(subjects: readonly string[]): readonly string[] {
	const out: string[] = [];
	for (const subject of subjects) {
		const match = /^(feat|fix)(\([^)]*\))?!?:\s*(.+)$/.exec(subject.trim());
		if (match === null) continue;
		const text = (match[3] ?? "").trim();
		if (text === "" || out.includes(text)) continue;
		out.push(text);
	}
	return out;
}

/** 上一个 tag → 这个 tag 之间的提交标题。git 读不出来（浅克隆、还没 tag）就返回空。 */
function subjectsBetween(prev: string | undefined, tag: string): readonly string[] {
	try {
		const args = ["log", "--pretty=%s", "--no-merges"];
		args.push(prev === undefined ? tag : `${prev}..${tag}`);
		return execFileSync("git", args, { encoding: "utf8" }).split("\n").filter((line) => line.trim() !== "");
	} catch {
		return [];
	}
}

/** 这个 tag 之前最近的一个 `v*` tag。 */
export function previousTag(tag: string, cwd = process.cwd()): string | undefined {
	try {
		// **必须 `--exclude` 掉自己**：tag 就打在 HEAD 上时，`describe` 的默认行为会返回当前这个 tag，
		// `prev..cur` 就是 0 行 —— notes 空、CI 那道红门每次都红，版本根本发不出去（Solo 2026-11-12）。
		const out = execFileSync(
			"git",
			["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", `--exclude=${tag}`, `${tag}^`],
			{ encoding: "utf8", cwd },
		).trim();
		return out === "" ? undefined : out;
	} catch {
		return undefined;
	}
}

function main(): void {
	const { values } = parseArgs({
		options: {
			feed: { type: "string" },
			version: { type: "string" },
			file: { type: "string", multiple: true },
			key: { type: "string" },
			tag: { type: "string" },
			"plugins-src": { type: "string" },
			notes: { type: "string" },
		},
	});

	if (values.feed === undefined || values.version === undefined || values.file === undefined) {
		console.error(
			"用法：npm run update:manifest -- --feed <目录> --version <x.y.z> --file darwin=<zip> [--file win32=<zip>] [--key <私钥>] [--tag vX.Y.Z] [--plugins-src plugins-src]",
		);
		process.exit(1);
	}

	const keyPath = values.key ?? join(homedir(), ".solo-update-key.pem");
	const privateKey = createPrivateKey(readFileSync(keyPath));
	const sign_ = (text: string): string => sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64");

	/** 一个包在清单里的样子。 */
	function entry(path: string): { file: string; sha512: string; size: number } {
		const bytes = readFileSync(path);
		return {
			file: basename(path),
			sha512: createHash("sha512").update(bytes).digest("base64"),
			size: statSync(path).size,
		};
	}

	// 本版改了什么：从提交标题生成，一份给清单（界面弹窗读）、一份给 Release 正文。
	const tag = values.tag;
	const notes =
		values.notes === undefined
			? releaseNotes(tag === undefined ? [] : subjectsBetween(previousTag(tag), tag))
			: releaseNotes(values.notes.split("\n"));
	if (notes.length === 0) console.warn("这一版没有 feat/fix 提交标题，清单里的 notes 是空的");

	for (const spec of values.file) {
		const [platform, path] = spec.split("=", 2) as [string, string | undefined];
		const name = PLATFORM_MANIFEST[platform];
		if (name === undefined) {
			console.error(`不认识的平台：${platform}（只支持 darwin / win32）`);
			process.exit(1);
		}
		if (path === undefined) {
			console.error(`--file ${spec} 少了路径`);
			process.exit(1);
		}
		const text = `${JSON.stringify({ version: values.version, notes, files: { [platform]: entry(path) } }, null, 2)}\n`;
		writeFileSync(join(values.feed, name), text);
		writeFileSync(join(values.feed, `${name}.sig`), `${sign_(text)}\n`);
		console.log(`${name}（${values.version}，notes ${String(notes.length)} 条）`);
	}

	if (values["plugins-src"] !== undefined) {
		const manifest = buildPluginManifest(values["plugins-src"], values.version);
		for (const [file, text] of manifest.assets) writeFileSync(join(values.feed, file), text);
		writeFileSync(join(values.feed, "plugins.json"), manifest.text);
		writeFileSync(join(values.feed, "plugins.json.sig"), `${sign_(manifest.text)}\n`);
		console.log(`plugins.json（${manifest.bundled.join("、")}）`);
	}

	writeFileSync(
		join(values.feed, "release-notes.md"),
		notes.length === 0 ? "这一版没有 feat / fix 提交。\n" : `${notes.map((note) => `- ${note}`).join("\n")}\n`,
	);
}

// 只有被当脚本跑才执行：测试要 import 上面的纯函数（`releaseNotes` / `buildPluginManifest`）。
if (process.argv[1] !== undefined && process.argv[1].endsWith("update-manifest.ts")) main();
