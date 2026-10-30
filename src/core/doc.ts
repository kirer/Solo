/**
 * 一切 markdown 都是同一种东西：`{ path, front, body }`。
 *
 * V2 里 identity / team / skill / rules / memory 各写一套「读文件 + 拆 YAML 头 + 拼正文」，
 * 五套代码三种边界行为（有人保留头里的空串，有人当缺省，有人把多行值丢了）。
 * V3 只留这一份：**写出去的东西一定读得回来**由代码保证，不靠五处互相看齐。
 *
 * 三个刻意的简化：
 *
 * - 头只认**单行** `key: value`。它是给人读的四五行元数据，不是数据通道；多行值、
 *   列表、锚点一律不解析，也**不丢**（留在正文里给模型看）。
 * - 读入时统一换行（`\r\n` → `\n`）。同一份文件在不同编辑器里保存，不该渲染出不同的
 *   提示词字节 —— 那会打穿 prompt cache。
 * - 不排序、不补字段：字段顺序由写的人给死，因为顺序本身就是可读性。
 */
import type { Fsx } from "./fsx.ts";

/** 一份文档。`path` 是相对工作区的路径（写回去时原样用）。 */
export type Doc = {
	readonly path: string;
	readonly front: Readonly<Record<string, string>>;
	readonly body: string;
};

/** 头里的一个字段。`undefined` = 这一行不写（空串**照写**，那是调用方的选择）。 */
export type FrontField = readonly [key: string, value: string | undefined];

const HEAD_OPEN = /^---[ \t]*\n/;

/** 统一换行。只做这一件事，别在这里 trim —— 位置有语义（正文开头可能有意留空）。 */
export function normalizeNewlines(source: string): string {
	return source.replace(/\r\n/g, "\n");
}

/** 找 `---` 头的结束位置（第二个 `---` 行的行首下标）。没有头 = `-1`。 */
function headEnd(source: string): number {
	if (!HEAD_OPEN.test(source)) return -1;
	const rest = source.slice(source.indexOf("\n") + 1);
	const end = rest.search(/^---[ \t]*$/m);
	if (end < 0) return -1;
	return source.indexOf("\n") + 1 + end;
}

/** 解析。没有头 → 整篇都是正文。 */
export function parseDoc(path: string, source: string): Doc {
	const text = normalizeNewlines(source);
	const end = headEnd(text);
	if (end < 0) return { path, front: {}, body: text.trim() };

	const front: Record<string, string> = {};
	for (const line of text.slice(text.indexOf("\n") + 1, end).split("\n")) {
		const match = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (match === null) continue;
		const key = match[1];
		const raw = match[2];
		if (key === undefined || raw === undefined) continue;
		const value = raw.trim().replace(/^["']|["']$/g, "");
		if (value !== "") front[key] = value;
	}
	return { path, front, body: text.slice(end + 4).trim() };
}

/** 渲染成文件内容：头、空行、正文、结尾换行。字段顺序由调用方给死。 */
export function renderDoc(front: readonly FrontField[], body: string): string {
	const lines = ["---"];
	for (const [key, value] of front) if (value !== undefined) lines.push(`${key}: ${value}`);
	lines.push("---", "", body.trim(), "");
	return lines.join("\n");
}

/** 读一份文档。不存在 = `undefined`（缺席是常态，不是错误）。 */
export async function readDoc(fsx: Fsx, rel: string): Promise<Doc | undefined> {
	const source = await fsx.readText(rel);
	return source === undefined ? undefined : parseDoc(rel, source);
}

/** 写一份文档。父目录由 `fsx` 建。 */
export async function writeDoc(fsx: Fsx, rel: string, front: readonly FrontField[], body: string): Promise<void> {
	await fsx.writeText(rel, renderDoc(front, body));
}

/** 取一个头字段。空串当没有 —— 头里写 `manager:` 与不写 manager 是同一个意思。 */
export function frontOf(doc: Doc, key: string): string | undefined {
	const value = doc.front[key];
	return value === undefined || value === "" ? undefined : value;
}
