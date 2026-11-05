/**
 * 测试用的**真模板**：直接读 `seed/prompt/` 的正文，不在这里手抄一份。
 *
 * 手抄就是第二个家：seed 改一句，测试还在断言旧话，于是要么测试红得莫名其妙，要么有人
 * 顺手把断言改宽。读真文件之后，断言的是「投递正文里贴的就是 seed 里那一份」——
 * 改措辞不会误伤，插槽被删、段被删才会红。
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deliveryText } from "../../src/core/channel/delivery.ts";
import { parseDoc } from "../../src/core/documents/base/doc.ts";

async function body(name: string): Promise<string> {
	const source = await readFile(new URL(`../../seed/prompt/${name}`, import.meta.url), "utf8");
	return parseDoc(name, source).body;
}

/** `80-reply.md`：每轮贴在投递正文末尾的「怎么回话」。 */
export const REPLY_TEMPLATE = await body("80-reply.md");

/** `90-interrupted.md`：插话时多贴的那一句。 */
export const INTERRUPTED_TEMPLATE = await body("90-interrupted.md");

/** 回话片段：条件句全部来自 `prompt/81`–`87`，代码只负责挑。 */
export const ALONE_TEMPLATE = await body("81-alone.md");
export const SHARED_TEMPLATE = await body("82-shared.md");
export const COLLEAGUES_TEMPLATE = await body("83-colleagues.md");
export const DM_TEMPLATE = await body("84-dm.md");
export const MULTI_TEMPLATE = await body("85-multi.md");
export const DIGEST_TEMPLATE = await body("86-digest.md");
export const MERGED_TEMPLATE = await body("87-merged.md");

/** 一份完整的 delivery 模板：直接走生产那条读取路径（含 `default:` 兜底句）。 */
export const SEED_DELIVERY_PROMPT = await deliveryText(
	fileURLToPath(new URL("../../seed/prompt", import.meta.url)),
);
