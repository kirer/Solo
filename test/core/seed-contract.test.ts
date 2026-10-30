/**
 * V3 seed 契约的**机械验收**（`docs/design/SEED-CONTRACT.md` §6）。
 *
 * 这个文件不 import 任何业务代码，只读 `seed/` 的字节。理由是 seed 的错单测抓不到：
 * 它不会让函数返回错值，只会让模型每轮看到一句谎话（「用 hire 招人」而工具已经没了）。
 * 所以这里钉四类能机械判的事：
 *
 * 1. `rules.md` 短、硬、不带工具名（≤ 15 条，一行一条）；
 * 2. **一条事实一个家**：同一句意思只能命中一个文件；
 * 3. `seed/prompt/` 的插槽全部在契约表里——未知插槽渲染成「（未设置）」就是半句话；
 * 4. 出厂内容的体积与位置：项目技能不进公司层、助理身份在文件里、不写死人名。
 *
 * **这是 V3 的验收门，不是 V2 的回归测试。** 在搬完之前它会红，红的就是还没做完的活；
 * 不要为了让这个文件变绿去放宽断言——要改的是 seed，不是这里。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCoreTools } from "../../src/core/channel/tools.ts";

const SEED = fileURLToPath(new URL("../../seed/", import.meta.url));

type SeedFile = { readonly rel: string; readonly text: string };

/** 递归列出 seed 下的文件（相对 seed/ 的 posix 路径）。顺序按码点，两次跑结果一样。 */
async function walk(rel = ""): Promise<readonly string[]> {
	let entries;
	try {
		entries = await readdir(join(SEED, rel), { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const next = rel === "" ? entry.name : `${rel}/${entry.name}`;
		if (entry.isDirectory()) out.push(...(await walk(next)));
		else out.push(next);
	}
	return out;
}

async function readSeed(rel: string): Promise<string> {
	return readFile(join(SEED, rel), "utf8");
}

let cache: readonly SeedFile[] | undefined;

/** seed 下所有 md 的正文（一次读盘，测试之间共享）。 */
async function seedMarkdown(): Promise<readonly SeedFile[]> {
	if (cache !== undefined) return cache;
	const files: SeedFile[] = [];
	for (const rel of await walk()) {
		if (!rel.endsWith(".md")) continue;
		files.push({ rel, text: await readSeed(rel) });
	}
	cache = files;
	return files;
}

async function exists(rel: string): Promise<boolean> {
	try {
		await readdir(join(SEED, rel));
		return true;
	} catch {
		return false;
	}
}

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/** 「第 N 行：原文」——失败信息必须能直接指到要改的那一行。 */
function where(text: string, hit: (line: string) => boolean): readonly string[] {
	return text
		.split("\n")
		.map((line, index) => ({ line, index }))
		.filter(({ line }) => hit(line))
		.map(({ line, index }) => `第 ${index + 1} 行：${line.trim()}`);
}

// ── 工具名 ────────────────────────────────────────────────────────────────

/** V3 的四个工具 + V2 残留的七个：改了名的旧工具名同样不许出现在 seed 里。 */
const TOOL_NAMES = [
	"say",
	"chats",
	"read_history",
	"remember",
	"teams",
	"write_team",
	"skills",
	"hire",
	"me",
	"run",
	"file",
] as const;

/** 这些词在中文散文里只可能是工具名，不加反引号也算违规。 */
const UNAMBIGUOUS = ["read_history", "write_team", "hire", "remember", "skills", "teams"] as const;

/** 工具参数：`step: true` / `scope=company`。参数细节归工具自己的 description。 */
const TOOL_PARAM = /`[^`]*\b(step|scope|action|mention)\s*[:=]/;

/**
 * 找出文本里的工具名。三种形态都算：
 * 反引号里（`` `say` ``）、调用式（`skills(action=write)`）、不加反引号的明确名字（hire）。
 * `{{tool:say}}` 是契约里唯一允许出现工具名的写法，先剥掉。
 */
function toolMentions(text: string): readonly string[] {
	const hits = new Set<string>();
	const lines = text.split("\n");
	lines.forEach((raw, index) => {
		const line = raw.replace(/\{\{[^}]*\}\}/g, "");
		const at = (name: string): void => {
			hits.add(`第 ${index + 1} 行：${raw.trim()}（工具名 ${name}）`);
		};
		for (const match of line.matchAll(/`([^`]*)`/g)) {
			const span = match[1] ?? "";
			// 只认「整段就是一个工具名 / 一次调用」：路径（`skills/x/SKILL.md`）不是工具名。
			const call = /^([a-z_]+)(?:\([^)]*\))?$/.exec(span);
			const name = call?.[1];
			if (name !== undefined && (TOOL_NAMES as readonly string[]).includes(name)) at(name);
		}
		for (const match of line.matchAll(/\b([a-z_]+)\s*\(/g)) {
			const name = match[1] ?? "";
			if ((TOOL_NAMES as readonly string[]).includes(name)) at(name);
		}
		// 裸写的名字：先把反引号段和插槽去掉，否则路径里的 skills 会被当成工具名。
		const bare = line.replace(/`[^`]*`/g, " ");
		for (const name of UNAMBIGUOUS) {
			if (new RegExp(`(?<![a-z_])${name}(?![a-z_])`).test(bare)) at(name);
		}
	});
	return [...hits];
}

// ── 一条事实一个家 ────────────────────────────────────────────────────────

/**
 * 契约 §2.1 认账的那几条重复，每条只许命中一个文件。
 * 正则按「意思」写，不按原话写：换措辞但同一个意思，同样算重复。
 */
const ONE_HOME: readonly { readonly what: string; readonly re: RegExp }[] = [
	{ what: "说话长度 / 群聊句数", re: /((最多|不超过)\s*[0-9一二三四五]\s*句|一两句|两三句|三行以内)/ },
	{ what: "不要轮询 / 别去追消息", re: /(轮询|run sleep|别去追消息|消息会来找你)/ },
	{ what: "不要用英文写内心独白", re: /(英文独白|用英文写|Let me)/ },
	{ what: "做完要汇报", re: /(做完.{0,6}汇报|汇报是活的一部分|没人知道你做完了)/ },
	{ what: "回话只回叫你的那个频道（原话）", re: /只在叫你的那个频道/ },
	{ what: "该我定的别转达（原话）", re: /该我定的.{0,20}转达/ },
	{ what: "怎么称呼我：写 @我、别写 @owner", re: /(不要写|别写)\s*`?@owner`?/ },
];

// ── prompt 插槽 ──────────────────────────────────────────────────────────

/** 契约 §3 的十一个模板：文件名前缀定序，一个文件 = 一段 = 一个 cache section。 */
const PROMPT_FILES = [
	"00-who.md",
	"10-rules.md",
	"20-position.md",
	"30-team.md",
	"40-tools.md",
	"50-memory.md",
	"60-skills.md",
	"70-directory.md",
	"80-reply.md",
	"90-interrupted.md",
	"95-settle.md",
] as const;

/** 一段 ≤ 12 行（契约 §1 的表格）。 */
const SEGMENT_MAX_LINES = 12;

async function promptFiles(): Promise<readonly string[]> {
	try {
		return (await readdir(join(SEED, "prompt"))).filter((name) => name.endsWith(".md")).sort();
	} catch {
		return [];
	}
}

/** 去掉 `---` 头：头里是配置（`skip-empty: skills`），不是写给模型看的散文。 */
function bodyOf(text: string): string {
	const match = /^---[ \t]*\n[\s\S]*?\n---[ \t]*\n?/.exec(text);
	return match === null ? text : text.slice(match[0].length);
}

/** 名字写死在 seed 里，助理换个名全错。 */
const HARDCODED_NAMES = ["知言"] as const;

// ── 测试 ─────────────────────────────────────────────────────────────────

describe("rules.md：短、硬、不带工具名", () => {
	it("≤ 15 条，一行一条", async () => {
		const text = await readSeed("rules.md");
		const items = text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("#"));
		expect(items.length, `现在 ${items.length} 条，上限 15 条；多的挪进技能`).toBeLessThanOrEqual(15);
		// 一条一行：一条里出现换行就不是「一行一条」了，这里只能靠上面那条兜住。
		expect(items.length).toBeGreaterThan(0);
	});

	it("不出现工具名（工具改名后 seed 会在教错的东西）", async () => {
		const text = await readSeed("rules.md");
		expect(toolMentions(text)).toEqual([]);
	});

	it("不出现工具参数（step / scope / action / mention 归工具自己的 description）", async () => {
		const text = await readSeed("rules.md");
		expect(where(text, (line) => TOOL_PARAM.test(line))).toEqual([]);
	});

	it("每一条都是「不说就会立刻出错」的硬规矩，不是做法说明", async () => {
		const text = await readSeed("rules.md");
		const items = text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("#"));
		// 判据：一条超过 60 个汉字，说明它在讲「怎么做」，那是技能的地盘。
		const long = items.filter((line) => line.replace(/[^\u4e00-\u9fa5]/g, "").length > 60);
		expect(long, `太长，挪进技能：\n${long.join("\n")}`).toEqual([]);
	});
});

describe("一条事实一个家", () => {
	for (const theme of ONE_HOME) {
		it(`${theme.what}：只出现在一个文件里`, async () => {
			const files = await seedMarkdown();
			const hit = files.filter((file) => theme.re.test(file.text)).map((file) => file.rel);
			expect(hit.length, `「${theme.what}」同时出现在：${hit.join("、")}——删到只剩一个家`).toBeLessThanOrEqual(1);
		});
	}

	it("skill 正文不复述 rules.md 的原话", async () => {
		const rules = await readSeed("rules.md");
		const lines = rules
			.split("\n")
			.map((line) => line.trim().replace(/^[-*]\s*/, ""))
			.filter((line) => line.length >= 12);
		const skills = (await seedMarkdown()).filter((file) => file.rel.includes("SKILL.md"));
		const copies: string[] = [];
		for (const line of lines) {
			for (const skill of skills) {
				if (skill.text.includes(line)) copies.push(`${skill.rel} 复述了：${line}`);
			}
		}
		expect(copies, "同一句话两个家：skill 里改成「见 rules」或删掉").toEqual([]);
	});
});

describe("seed/prompt：段落与插槽", () => {
	it("十一个模板都在（契约 §3）", async () => {
		const files = await promptFiles();
		expect(files).toEqual(expect.arrayContaining([...PROMPT_FILES]));
	});

	it("文件名前缀定序且唯一（顺序一变，底座整块重写）", async () => {
		const files = await promptFiles();
		const prefixes = files.map((name) => name.slice(0, 2));
		expect(prefixes).toEqual([...prefixes].sort());
		expect(new Set(prefixes).size).toBe(prefixes.length);
		expect(prefixes.every((prefix) => /^\d{2}$/.test(prefix))).toBe(true);
	});

	it("一段 ≤ 12 行", async () => {
		const tooLong: string[] = [];
		for (const name of await promptFiles()) {
			const lines = (await readSeed(`prompt/${name}`))
				.split("\n")
				.filter((line) => line.trim() !== "");
			if (lines.length > SEGMENT_MAX_LINES) tooLong.push(`${name}：${lines.length} 行`);
		}
		expect(tooLong, `拆成两段，或者挪进技能：\n${tooLong.join("\n")}`).toEqual([]);
	});

	it("模板里不写死工具名（唯一合法写法是 {{tool:xxx}}）", async () => {
		const bad: string[] = [];
		for (const name of await promptFiles()) {
			const text = bodyOf(await readSeed(`prompt/${name}`));
			for (const hit of toolMentions(text)) bad.push(`${name} ${hit}`);
		}
		expect(bad).toEqual([]);
	});

	it("{{tool:X}} 的名字必须是真工具（写错不会报错，只会把错名原样写进正文）", async () => {
		// `toolSlots()` 按后缀自解释、不查表 —— 这是刻意的：投递层没有注册表可查，
		// 宁可让错名原样出现（一眼看得见），也不渲染成「（未设置）」把话截断。
		// 代价就是「写错不报错」，所以对表这件事只能由这里兜。
		const names = new Set(createCoreTools({} as never).map((tool) => tool.name));
		const bad: string[] = [];
		let seen = 0;
		for (const name of await promptFiles()) {
			const text = bodyOf(await readSeed(`prompt/${name}`));
			for (const match of text.matchAll(/\{\{tool:([^}]*)\}\}/g)) {
				seen += 1;
				const tool = (match[1] ?? "").trim();
				if (!names.has(tool)) bad.push(`${name}：{{tool:${tool}}}`);
			}
		}
		// 一条「没找到任何插槽」的检查等于没跑：正则写错、目录读空，它都会绿。
		expect(seen, "模板里一个 {{tool:*}} 都没有，这条检查等于没跑").toBeGreaterThan(0);
		expect(bad, `真工具只有：${[...names].join("、")}`).toEqual([]);
	});

	it("人名只在 identity.md 里（别处写死，换个名 seed 就全错）", async () => {
		const bad: string[] = [];
		for (const file of await seedMarkdown()) {
			// identity.md 是名字唯一的家；正文里提自己一律写「你」。
			if (file.rel.startsWith("agents/") && file.rel.endsWith("identity.md")) continue;
			for (const name of HARDCODED_NAMES) {
				if (file.text.includes(name)) bad.push(`${file.rel}：${name}`);
			}
		}
		expect(bad, "一律换成插槽或「你」").toEqual([]);
	});
});

describe("出厂内容：体积与位置", () => {
	it("项目技能不进公司层（前端视觉设计）", async () => {
		expect(await exists("skills/前端视觉设计"), "它该按需装，不该让全员默认背一个前端技能").toBe(false);
		const agents = await walk("agents");
		const personal = agents.filter((rel) => rel.includes("前端视觉设计"));
		expect(personal, "也别默认装进某个人的个人层").toEqual([]);
	});

	it("助理身份在 seed 里，不在代码里（契约 §2.5）", async () => {
		const text = await readSeed("agents/assistant/identity.md");
		expect(text.startsWith("---")).toBe(true);
		// `team` 是可选的：助理不属于任何团队，别为凑字段编一个。
		for (const field of ["name", "title", "manager"]) {
			expect(new RegExp(`^${field}:`, "m").test(text), `identity.md 缺 ${field}`).toBe(true);
		}
		expect(/^manager:\s*owner\s*$/m.test(text), "助理的上级必须是我（owner）").toBe(true);
		expect(text.split("\n").filter((line) => line.trim() !== "").length).toBeLessThanOrEqual(20);
	});

	it("V2 的 seed/assistant/ 已搬走（同一个家不留两份）", async () => {
		expect(await exists("assistant")).toBe(false);
	});

	it("技能体积：工作规矩可用满 4 KB，其余自律 3 KB（契约 §5）", async () => {
		// 上限是 2026-10-30 定的：`工作规矩` 是唯一被反复读、且承载四个身份模型的那个
		// 技能，为凑 3 KB 砍内容是本末倒置。其余技能照旧自律 —— 超了说明该拆或该挪进 prompt。
		const big: string[] = [];
		for (const rel of await walk()) {
			if (!rel.endsWith("SKILL.md") || rel.includes("前端视觉设计")) continue;
			const limit = rel === "skills/工作规矩/SKILL.md" ? 4 * 1024 : 3 * 1024;
			const size = byteLength(await readSeed(rel));
			if (size > limit) big.push(`${rel}：${size} B（上限 ${limit / 1024} KB）`);
		}
		expect(big).toEqual([]);
	});

	it("seed 总体积 < 500 KB（不含前端视觉设计）", async () => {
		let total = 0;
		for (const rel of await walk()) {
			if (rel.includes("前端视觉设计")) continue;
			total += byteLength(await readSeed(rel));
		}
		expect(total, `现在 ${(total / 1024).toFixed(0)} KB`).toBeLessThan(500 * 1024);
	});
});
