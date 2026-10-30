/**
 * Markdown 文件的 YAML 头（frontmatter）。
 *
 * 三处文档同一个格式 —— `agents/<slug>/identity.md`、`skills/<n>/SKILL.md`、
 * `teams/<slug>/README.md` —— 以前各有一份拷贝，正则还略有出入。这里只有一份实现，
 * 解析与渲染都走它，于是「写出来的东西一定读得回」由代码保证，而不是靠三处互相看齐。
 *
 * 只认**单行** `key: value`：这些头是给人读的几行元数据，不是数据通道。多行值、
 * 列表、锚点一律不解析，也不丢（正文里原样留给模型看）。
 */

/** 解析出来的键值对。值统一去掉首尾引号；空的键直接不出现。 */
export type Frontmatter = Record<string, string>;

/** 取 `---` 之间那些行，逐行 `key: value`。没有头就返回空对象。 */
export function parseFrontmatter(source: string): Frontmatter {
	if (!source.startsWith("---")) return {};
	const end = source.indexOf("\n---", 3);
	if (end < 0) return {};
	const out: Frontmatter = {};
	for (const line of source.slice(3, end).split("\n")) {
		const match = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (match === null) continue;
		const key = match[1];
		const raw = match[2];
		if (key === undefined || raw === undefined) continue;
		const value = raw.trim().replace(/^["']|["']$/g, "");
		if (value !== "") out[key] = value;
	}
	return out;
}

/** `---` 之后的正文；没有头就是整篇（都去掉首尾空白）。 */
export function stripFrontmatter(source: string): string {
	if (!source.startsWith("---")) return source.trim();
	const end = source.indexOf("\n---", 3);
	if (end < 0) return source.trim();
	return source.slice(end + 4).trim();
}

/** 一个头字段。`undefined` = 这一行不写（空串**照写**，那是调用方的选择）。 */
export type FrontmatterField = readonly [key: string, value: string | undefined];

/**
 * 渲染成文件内容：`---`、字段（按给定顺序）、`---`、空行、正文、结尾换行。
 *
 * 字段顺序由调用方给死，因为顺序是人读时的语义（`name` 在最上面），也让 diff 稳定。
 */
export function renderFrontmatter(fields: readonly FrontmatterField[], body: string): string {
	const lines = ["---"];
	for (const [key, value] of fields) if (value !== undefined) lines.push(`${key}: ${value}`);
	lines.push("---", "", body.trim(), "");
	return lines.join("\n");
}
