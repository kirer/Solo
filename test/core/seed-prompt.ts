/**
 * 测试用的**真模板**：直接读 `seed/prompt/` 的正文，不在这里手抄一份。
 *
 * 手抄就是第二个家：seed 改一句，测试还在断言旧话，于是要么测试红得莫名其妙，要么有人
 * 顺手把断言改宽。读真文件之后，断言的是「投递正文里贴的就是 seed 里那一份」——
 * 改措辞不会误伤，插槽被删、段被删才会红。
 */
import { readFile } from "node:fs/promises";
import { parseDoc } from "../../src/core/doc.ts";

async function body(name: string): Promise<string> {
	const source = await readFile(new URL(`../../seed/prompt/${name}`, import.meta.url), "utf8");
	return parseDoc(name, source).body;
}

/** `80-reply.md`：每轮贴在投递正文末尾的「怎么回话」。 */
export const REPLY_TEMPLATE = await body("80-reply.md");

/** `90-interrupted.md`：插话时多贴的那一句。 */
export const INTERRUPTED_TEMPLATE = await body("90-interrupted.md");
