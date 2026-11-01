/**
 * 生成更新清单 + 签名（ADR-029）。
 *
 *   npm run update:manifest -- --feed feed --version 2.0.1 \
 *     --file darwin=release/Solo-2.0.1-arm64.zip \
 *     --file win32=release/Solo-2.0.1-arm64.zip
 *
 * 产物落在 `--feed` 目录：`latest-mac.json` / `latest-win.json` 及各自的 `.sig`。
 * 安装包本身不会自动拷贝，放进同一个目录即可（`scripts/update-server.ts` 原样发出去）。
 * 私钥默认 `~/.solo-update-key.pem`，可用 `--key` 指定。
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

const PLATFORM_MANIFEST: Record<string, string> = { darwin: "latest-mac.json", win32: "latest-win.json" };

const { values } = parseArgs({
	options: {
		feed: { type: "string" },
		version: { type: "string" },
		file: { type: "string", multiple: true },
		key: { type: "string" },
	},
});

if (values.feed === undefined || values.version === undefined || values.file === undefined) {
	console.error("用法：npm run update:manifest -- --feed <目录> --version <x.y.z> --file darwin=<zip> [--file win32=<zip>] [--key <私钥>]");
	process.exit(1);
}

const keyPath = values.key ?? join(homedir(), ".solo-update-key.pem");
const privateKey = createPrivateKey(readFileSync(keyPath));

/** 一个包在清单里的样子。 */
function entry(path: string): { file: string; sha512: string; size: number } {
	const bytes = readFileSync(path);
	return {
		file: basename(path),
		sha512: createHash("sha512").update(bytes).digest("base64"),
		size: statSync(path).size,
	};
}

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
	const text = `${JSON.stringify({ version: values.version, files: { [platform]: entry(path) } }, null, 2)}\n`;
	const signature = sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64");
	writeFileSync(join(values.feed, name), text);
	writeFileSync(join(values.feed, `${name}.sig`), `${signature}\n`);
	console.log(`${name}（${values.version}）`);
}
