/**
 * 只换「用户点『检查更新』看到的那段话」，别的一个字段都不动。
 *
 * 那段话在哪：`latest-mac.json` 里的 `notes` 数组（`desktop/src/update-notes.ts` 只读它），
 * **不是** Release 正文（2026-11-15 踩过这个：`gh release edit` 改完，用户看的一点没变）。
 *
 * 为什么不重跑 `update-manifest.ts`：它要从包重新算 `sha512` / `size`，那就得把 139MB 拉下来
 * 重算；而且重算出来只要差一个字节，用户端下载校验就会拒。这里反过来做 —— 读线上那份清单，
 * 把 `notes` 整段换掉，`version` 和 `files` 原样抄过去（抄完再比一次，不一样就退出），
 * 然后用同一把私钥重签 `.sig`。
 *
 * 用法：
 *   node --experimental-strip-types scripts/resign-notes.ts \
 *     --manifest old/latest-mac.json \
 *     --notes-file release-notes/2.9.20.txt \
 *     --key ~/.solo-update-key.pem \
 *     --out feed
 */
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

/** 清单里那几条人话 → 文本文件里的行。前导的 `·` / `-` / `*` 是排版，不是文案。 */
export function notesFromText(text: string): readonly string[] {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.replace(/^\s*[·•\-*]\s*/, "").trim();
		if (line === "") continue;
		if (!out.includes(line)) out.push(line);
	}
	return out;
}

function main(): void {
	const { values } = parseArgs({
		options: {
			manifest: { type: "string" },
			"notes-file": { type: "string" },
			key: { type: "string" },
			out: { type: "string" },
		},
	});
	if (values.manifest === undefined || values["notes-file"] === undefined || values.out === undefined) {
		console.error(
			"用法：node --experimental-strip-types scripts/resign-notes.ts --manifest <线上 latest-mac.json> --notes-file <给用户的几条> --out <输出目录> [--key <私钥>]",
		);
		process.exit(1);
	}

	const before = JSON.parse(readFileSync(values.manifest, "utf8")) as {
		version?: unknown;
		notes?: unknown;
		files?: unknown;
	};
	if (typeof before.version !== "string" || before.files === undefined || typeof before.files !== "object") {
		console.error(`${values.manifest} 看着不像更新清单：缺 version 或 files`);
		process.exit(1);
	}

	const notes = notesFromText(readFileSync(values["notes-file"], "utf8"));
	if (notes.length === 0) {
		console.error(`${values["notes-file"]} 里一条都没读到，别拿空文案去覆盖线上的`);
		process.exit(1);
	}

	// `files` 一个字节都不许动：用户端拿它比 sha512 / size，动了就等于换了一套产物。
	const next = {
		version: before.version,
		notes,
		files: before.files,
	};
	const text = `${JSON.stringify(next, null, 2)}\n`;
	const filesBefore = JSON.stringify(before.files);
	const filesAfter = JSON.stringify((JSON.parse(text) as { files: unknown }).files);
	if (filesBefore !== filesAfter) {
		console.error("重签出来的 files 段和线上那份不一样，停下");
		process.exit(1);
	}
	if (JSON.stringify(before.notes) === JSON.stringify(notes)) {
		console.warn("线上 notes 已经就是这个，照样重签一遍（清单字节可能还是变）");
	}

	const privateKey = createPrivateKey(readFileSync(values.key ?? join(process.env.HOME ?? "", ".solo-update-key.pem")));
	const signature = sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64");

	mkdirSync(values.out, { recursive: true });
	writeFileSync(join(values.out, basename(values.manifest)), text);
	writeFileSync(join(values.out, `${basename(values.manifest)}.sig`), `${signature}\n`);

	const longest = notes.reduce((max, note) => Math.max(max, note.length), 0);
	console.log(`${before.version}：notes ${String(notes.length)} 条、最长 ${String(longest)} 字；files 段原样（${String(Object.keys(before.files as object).length)} 个平台）；已签名`);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("resign-notes.ts")) main();
