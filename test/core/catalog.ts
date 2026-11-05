/**
 * 测试用的**真文案**：直接读 `seed/text/*.md`，不在这里手抄一份。
 *
 * 手抄就是第二个家：seed 改一句，测试还在断言旧话。读真文件之后，断言的是
 * 「模型收到的就是 seed 里那一份」——改措辞不会误伤，键被删才会红。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseCatalog, type TextCatalog } from "../../src/core/documents/base/catalog.ts";

const DIR = fileURLToPath(new URL("../../seed/text/", import.meta.url));

const merged = new Map<string, string>();
for (const name of readdirSync(DIR).filter((file) => file.endsWith(".md")).sort()) {
	for (const [key, body] of parseCatalog(join(DIR, name), readFileSync(join(DIR, name), "utf8"))) {
		if (merged.has(key)) throw new Error(`重复的文案键：${key}（${name}）`);
		merged.set(key, body);
	}
}

export const SEED_TEXT: TextCatalog = {
	get: (key) => merged.get(key) ?? "",
	has: (key) => merged.has(key),
	keys: () => [...merged.keys()],
};
