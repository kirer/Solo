/**
 * 播种：把仓库自带的起手技能与「离老板最近的那个人」装进工作区。
 *
 * 分两种写入：
 * - **身份**（`agents/<slug>/`）只在工作区空的时候写一次 —— 之后那些文件属于那个人自己。
 * - **公司层的规矩与技能**（`rules.md` / `skills/`）每次启动都同步一遍：它们是公司发的，
 *   以前只在空工作区拷一次，导致 `seed/skills/工作规矩/SKILL.md` 的 1037 字节修正
 *   从来没有进过已在跑的工作区（实测 5766 vs 4729 字节）。同步按 hash 判「用户改过没有」：
 *   没改过的升到新版，改过的原样留着（见 ADR-039）。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILLS_DIR, copySkillDir } from "../agent/skills.ts";
import { OWNER_SLUG } from "../agent/identity.ts";
import { RULES_FILE } from "../agent/rules.ts";

/** 同步账本：记「上次从 seed 拷过去的内容是什么」，用来分辨「用户改过没有」。 */
export const SEED_MANIFEST_FILE = ".seed-manifest.json";

type SeedManifest = {
	version: 1;
	/** `技能名` → `技能内相对路径` → 内容 hash（sha256 前 16 位）。 */
	skills: Record<string, Record<string, string>>;
};

/** 公司层技能的同步结果。`copied` / `updated` / `kept` 都是技能名。 */
export type SyncReport = {
	readonly copied: readonly string[];
	readonly updated: readonly string[];
	readonly kept: readonly string[];
};

const EMPTY_REPORT: SyncReport = { copied: [], updated: [], kept: [] };

function hashOf(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/**
 * 把仓库自带的技能同步进工作区的公司层（`<workspace>/skills/`）。
 *
 * 每个文件单独判（不是整个技能判）：缺的补上、没改过的升到新版、改过的一动不动。
 * 幂等：内容已经一样就不写，manifest 没变也不写 —— 第二次启动不会碰磁盘。
 *
 * 找不到 `seed/skills/` 时静默跳过 —— 打包/部署方式可能不带这个目录，
 * 缺几份起手技能不该让服务起不来。
 */
export async function syncCompanySkills(agentsRoot: string): Promise<SyncReport> {
	return syncSkillTree(seedRoot("skills"), join(dirname(agentsRoot), SKILLS_DIR), join(dirname(agentsRoot), SEED_MANIFEST_FILE));
}

/**
 * 旧名字，保留给已有调用点：现在它是「同步」，不再是「播种」。
 *
 * 返回**动过的**技能名。第一次跑等于全部拷过去，所以旧测试里
 * `arrayContaining(["写技能", "找现成技能"])` 的断言仍然成立。
 */
export async function seedCompanySkills(agentsRoot: string): Promise<readonly string[]> {
	const report = await syncCompanySkills(agentsRoot);
	return [...report.copied, ...report.updated];
}

/** 同步入口：`seedSkillsRoot` 下的每个技能目录 → `skillsRoot/<技能>/...`。 */
async function syncSkillTree(seedSkillsRoot: string, skillsRoot: string, manifestPath: string): Promise<SyncReport> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(seedSkillsRoot, { withFileTypes: true });
	} catch {
		return EMPTY_REPORT;
	}
	const manifest = await readManifest(manifestPath);
	const copied: string[] = [];
	const updated: string[] = [];
	const kept: string[] = [];
	let changed = false;

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const name = entry.name;
		const files = await walkFiles(join(seedSkillsRoot, name), "");
		if (files.length === 0) continue;
		const recorded = { ...(manifest.skills[name] ?? {}) };
		let touched = false;
		let keptThis = false;

		for (const relpath of files) {
			const source = await readFile(join(seedSkillsRoot, name, ...relpath.split("/")), "utf8");
			const seedHash = hashOf(source);
			const target = join(skillsRoot, name, ...relpath.split("/"));
			const existing = await readOrUndefined(target);

			if (existing === undefined) {
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, source, "utf8");
				recorded[relpath] = seedHash;
				changed = true;
				touched = true;
				continue;
			}

			const currentHash = hashOf(existing);
			if (currentHash === seedHash) {
				// 内容已经是新版：什么也不用写，只补账本（首次跑同步的老工作区走这条）。
				if (recorded[relpath] !== seedHash) {
					recorded[relpath] = seedHash;
					changed = true;
				}
				continue;
			}
			if (recorded[relpath] === currentHash) {
				// 工作区里的内容还是上次同步给的那份（用户没改过）→ 升到新版。
				await writeFile(target, source, "utf8");
				recorded[relpath] = seedHash;
				changed = true;
				touched = true;
				continue;
			}
			// 用户改过（或者这个文件从来不在账本里）：不覆盖，留一句话。
			keptThis = true;
			console.warn(`[core] 技能 ${name} 已被本地修改，未覆盖：${relpath}`);
		}

		if (touched) {
			(manifest.skills[name] === undefined ? copied : updated).push(name);
		} else if (keptThis) {
			kept.push(name);
		}
		manifest.skills[name] = recorded;
	}

	if (changed) {
		await mkdir(dirname(manifestPath), { recursive: true });
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	}
	return { copied, updated, kept };
}

async function readManifest(path: string): Promise<SeedManifest> {
	try {
		const raw = JSON.parse(await readFile(path, "utf8")) as Partial<SeedManifest>;
		return { version: 1, skills: raw.skills ?? {} };
	} catch {
		return { version: 1, skills: {} };
	}
}

async function readOrUndefined(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

/** 递归列出目录下的文件（相对路径，`/` 分隔）。读失败 → 空。 */
async function walkFiles(root: string, prefix: string): Promise<string[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(join(root, ...prefix.split("/").filter(Boolean)), { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const entry of entries) {
		const relpath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) out.push(...(await walkFiles(root, relpath)));
		else if (entry.isFile()) out.push(relpath);
	}
	return out;
}

/**
 * 把 `seed/rules.md` 写进工作区（**只在不存在时写**）。
 *
 * 不覆盖的理由和技能不一样：规矩是每轮都进提示词的**活的**文件，老板可能亲手改过措辞。
 * 技能有 hash 账本可以判断「改没改」，规矩只有一份文案，没有可靠的基线，所以只补不改。
 */
export async function seedRules(workspaceRoot: string): Promise<"written" | "exists" | "missing"> {
	const target = join(workspaceRoot, RULES_FILE);
	if (existsSync(target)) return "exists";
	try {
		const source = await readFile(seedPath(RULES_FILE), "utf8");
		await mkdir(workspaceRoot, { recursive: true });
		await writeFile(target, source, "utf8");
		return "written";
	} catch {
		return "missing";
	}
}

/**
 * 给某一个人的个人层播种技能（`agents/<slug>/skills/`）。
 *
 * 为什么有些技能属于个人而不是公司：一份技能属于谁，取决于「谁该为这条做法负责」。
 * 「怎么立项」「怎么招人」是助理的判断，它自己会迭代 —— 写在公司层就等于宣布全公司
 * 都得按助理那一套招人，而实际上别人不该招人。`写技能` / `找现成技能` 反过来是
 * 所有人都该会的手艺，所以它们在公司层。
 */
export async function seedPersonalSkills(agentsRoot: string, slug: string, folder: string): Promise<readonly string[]> {
	return copySeedSkills(seedRoot(folder), join(agentsRoot, slug, SKILLS_DIR));
}

async function copySeedSkills(from: string, skillsRoot: string): Promise<readonly string[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(from, { withFileTypes: true });
	} catch {
		return [];
	}
	const copied: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const written = await copySkillDir(join(from, entry.name), skillsRoot);
		copied.push(written.name);
	}
	return copied;
}

/**
 * 仓库自带的播种目录（`seed/<folder>`）。
 *
 * 用「从本文件往上找」而不是写死绝对路径：`src/core/shell/` 到仓库根是固定深度，
 * 但源码（`src/`）与构建产物（`dist/`）深度不同，所以往上找而不是数层级。
 */
function seedRoot(folder: string): string {
	return seedPath(folder);
}

/** `seed/<segments...>` 的真实路径（从本文件往上找，见 `seedRoot` 的注释）。 */
function seedPath(...segments: readonly string[]): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let index = 0; index < 6; index += 1) {
		const candidate = join(dir, "seed", ...segments);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return join(dirname(fileURLToPath(import.meta.url)), "seed", ...segments);
}

/**
 * 给一个工作区播种「老板身边的人」。
 *
 * 这是**唯一**一处预置身份的地方，而且只写文件、不写代码：一个 `manager: owner` 的
 * agent，正文说清「你是老板唯一直接对话的人，其余的人由你按需要创建」。
 * 之后它自己就会 `hire` 别人 —— 那些人的身份是它写的，不是代码写的。
 */
export async function seedOwnerAssistant(
	agentsRoot: string,
	options: { readonly name: string; readonly body?: string },
): Promise<string> {
	const { createAgent } = await import("../agent/create.ts");
	const identity = await createAgent({
		root: agentsRoot,
		name: options.name,
		title: "负责人",
		manager: OWNER_SLUG,
		body:
			options.body ??
			[
				"你是老大唯一直接对话的人。老大不直接管别人，只跟你说话。",
				"",
				"## 你做什么",
				"老大说一件事，你判断它需要谁，用 `hire` 建人，用 `write_project` 立项目。",
				"招人、分工、定边界都是你的活，不必请示。做完在频道里向老大说清楚。",
				"",
				"## 你的边界",
				"你不写代码、不做设计。你决定「谁来做、做什么、做到什么程度」，然后验收。",
				"一个任务需要N个人时，就建N个人；需要一个人时，就一个人做到底。",
				"",
				"## 怎么说话",
				"对老大：结论先行，一句话说清做完了什么、卡在哪、要他定什么。不铺垫、不罗列过程。",
				"对下属：说清目标与验收标准，不说做法。",
				"",
				"## 你自己也在变",
				"你可以用 `update_identity` 改自己的身份。发现「我该更关注成本」这类结论，就写进自己的 identity.md。",
				"经验用 `remember` 记下来，下次先 `recall` 再动手。",
			].join("\n"),
	});

	// 技能：和身份一样，是文件，不是代码。
	//
	// 两层，各自管各自的事：
	// - 公司层 `seed/skills/`（`写技能`、`找现成技能`）—— 所有人都该会的手艺。
	// - 助理自己的 `seed/assistant/`（`立项`、`招人`）—— 它的判断，不属于别人。
	//   招人、立项是助理的职权，别人本来就不该招人；写进公司层等于宣布全公司都这么干。
	//
	// 正文以前是写在本函数里的字符串字面量 —— 那等于把「做法」硬编码进代码：改一句话
	// 要改 TS、要重新编译、要重启。现在它们和 agent 自己写的技能是同一种东西
	// （同一个文件夹结构），改完下一条消息就生效。
	await syncCompanySkills(agentsRoot);
	await seedPersonalSkills(agentsRoot, identity.slug, "assistant");
	return identity.slug;
}
