/**
 * 播种：把仓库自带的起手技能与「离我最近的那个人」装进工作区。
 *
 * 分两种写入：
 * - **身份**（`members/<slug>/`）只在工作区空的时候写一次 —— 之后那些文件属于那个人自己。
 * - **全员层的规矩、技能与提示词模板**（`rules.md` / `skills/` / `prompt/`）每次启动都同步
 *   一遍：它们是全员共用的，以前只在空工作区拷一次，导致 `seed/skills/工作规矩/SKILL.md`
 *   的 1037 字节修正从来没有进过已在跑的工作区（实测 5766 vs 4729 字节）。
 *
 * 同步按 hash 判「用户改过没有」：没改过的升到新版，改过的原样留着（ADR-031）。
 * 老工作区没有账本，用 `seed-legacy.ts` 的历史 hash 认出厂内容；命中 = 没改过。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILLS_DIR, copySkillDir } from "../core/documents/skills.ts";
import { RULES_FILE } from "../core/documents/rules.ts";
import { isSafeName } from "../core/naming.ts";
import { existsAt, listDirSorted, moveAt, readTextOrUndefined, removeAt, writeTextAt } from "../core/runtime/io.ts";
import { mergeCatalog, parseCatalog } from "../core/documents/base/catalog.ts";
import { frontOf, parseDoc, type Doc } from "../core/documents/base/doc.ts";
import type { Layout } from "../core/layout.ts";
import { LEGACY_PLUGIN_HASHES, LEGACY_SEED_HASHES, LEGACY_TEXT_KEYS } from "./seed-legacy.ts";

/** 同步账本：记「上次从 seed 拷过去的内容是什么」，用来分辨「用户改过没有」。 */
export const SEED_MANIFEST_FILE = ".seed-manifest.json";

type SeedManifest = {
	version: 2;
	/** `技能名` → `技能内相对路径` → 内容 hash（sha256 前 16 位）。 */
	skills: Record<string, Record<string, string>>;
	/**
	 * 出厂插件里**已经在工作区出现过**的目录名。
	 *
	 * 记这一条是为了让「删除」真的删掉 —— 只看目录在不在的话，删掉的出厂插件
	 * 下次启动会被重新拷回来，界面上的「删除」就成了假的。
	 */
	plugins: string[];
	/**
	 * 出厂插件 → 目录内相对路径 → 上次播种时的 hash。
	 *
	 * 判据是**整个目录**：每个文件都和上次播种时一样，才算「没人动过」，才整份升到新版；
	 * 只要有一个文件不同（改了 / 多了 / 少了），整份留着 —— 插件是可执行的代码，
	 * 半新半旧比旧版更糟。没有这一条，出厂的插件修正永远进不来（ADR-097）。
	 */
	pluginFiles: Record<string, Record<string, string>>;
	/**
	 * 用户**自己删掉**的出厂插件名。
	 *
	 * 和 `plugins`（「见过」）分开：见过只说明「装过」，说明不了「谁弄没的」——
	 * 目录被手删、迁移丢了、应用重装没带过来，都长成同一个样子。早先拿「见过」
	 * 当「我删的」，结果删除一旦发生就永久死了：重装应用补不回，界面上也没有装回来的路。
	 *
	 * 现在只有走过「删除」入口的才记在这里。没记的一律当意外丢失，下次启动补回。
	 */
	removed: string[];
	/**
	 * 播种文件的逻辑键 → 上次写入的 hash。
	 *
	 * 键用工作区里的逻辑位置（`prompt/20-position.md`、`rules.md`），不是绝对路径：
	 * 账本跟着应用根走，换一台机器不该失效。
	 */
	files: Record<string, string>;
	/**
	 * 出厂文案 → 上次播种时每个键写进去的值 hash。
	 *
	 * 键是 `<文件名>:<文案键>`（`tools.md:say.param.options`）。文案按**键**升级：
	 * 没改过的键跟到新版，改过的键留着（ADR-114）。
	 */
	textKeys: Record<string, string>;
};

function emptyManifest(): SeedManifest {
	return { version: 2, skills: {}, plugins: [], pluginFiles: {}, removed: [], files: {}, textKeys: {} };
}

/** 全员层技能的同步结果。`copied` / `updated` / `kept` 都是技能名。 */
type SyncReport = {
	readonly copied: readonly string[];
	readonly updated: readonly string[];
	readonly kept: readonly string[];
};

const EMPTY_REPORT: SyncReport = { copied: [], updated: [], kept: [] };

function hashOf(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/**
 * 把仓库自带的技能同步进用户根的全员层（`~/.solo/skills/`）。
 *
 * 每个文件单独判（不是整个技能判）：缺的补上、没改过的升到新版、改过的一动不动。
 * 幂等：内容已经一样就不写，manifest 没变也不写 —— 第二次启动不会碰磁盘。
 *
 * 找不到 `seed/skills/` 时静默跳过 —— 打包/部署方式可能不带这个目录，
 * 缺几份起手技能不该让服务起不来。
 */
export async function syncAllSkills(layout: Layout): Promise<SyncReport> {
	return syncSkillTree(seedPath("skills"), layout.skillsRoot, layout.seedManifestFile);
}

/** 同步入口：`seedSkillsRoot` 下的每个技能目录 → `skillsRoot/<技能>/...`。 */
async function syncSkillTree(seedSkillsRoot: string, skillsRoot: string, manifestPath: string): Promise<SyncReport> {
	const entries = await listDirSorted(seedSkillsRoot);
	if (entries.length === 0) return EMPTY_REPORT;
	const manifest = await readManifest(manifestPath);
	const copied: string[] = [];
	const updated: string[] = [];
	const kept: string[] = [];
	let changed = false;

	for (const entry of entries) {
		if (entry.kind !== "dir") continue;
		const name = entry.name;
		const files = await walkFiles(join(seedSkillsRoot, name), "");
		if (files.length === 0) continue;
		const recorded = { ...(manifest.skills[name] ?? {}) };
		let touched = false;
		let keptThis = false;

		for (const relpath of files) {
			const source = await readTextOrUndefined(join(seedSkillsRoot, name, ...relpath.split("/")));
			if (source === undefined) continue;
			const seedHash = hashOf(source);
			const target = join(skillsRoot, name, ...relpath.split("/"));
			const existing = await readTextOrUndefined(target);

			if (existing === undefined) {
				await writeTextAt(target, source);
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
			// 账本里的基线 = 用户没改过；没有账本但内容命中历史出厂版本 = 也没改过。
			// 两条都升到新版；其余情况才是用户自己写的。
			if (recorded[relpath] === currentHash || (recorded[relpath] === undefined && LEGACY_SEED_HASHES.has(currentHash))) {
				await writeTextAt(target, source);
				recorded[relpath] = seedHash;
				changed = true;
				touched = true;
				continue;
			}
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
		await writeTextAt(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	}
	return { copied, updated, kept };
}

async function readManifest(path: string): Promise<SeedManifest> {
	const text = await readTextOrUndefined(path);
	if (text === undefined) return emptyManifest();
	let raw: Partial<SeedManifest>;
	try {
		raw = parseManifest(text);
	} catch (error) {
		// 账本是缓存，坏了不能挡启动；但也不能悄悄当成「全都没改过」然后覆盖用户文件。
		// 改名留证，下一次按「没有账本」处理（保守：只升级命中历史出厂 hash 的文件）。
		const backup = `${path}.corrupt-${Date.now()}`;
		try {
			await moveAt(path, backup);
			console.warn(`[core] ${path} 读不出来（${(error as Error).message}），已改名 ${backup}`);
		} catch (moveError) {
			console.warn(
				`[core] ${path} 读不出来（${(error as Error).message}），备份也失败：${(moveError as Error).message}`,
			);
		}
		return emptyManifest();
	}
	return {
		version: 2,
		skills: raw.skills ?? {},
		plugins: raw.plugins ?? [],
		pluginFiles: raw.pluginFiles ?? {},
		removed: raw.removed ?? [],
		files: raw.files ?? {},
		textKeys: raw.textKeys ?? {},
	};
}

/**
 * 账本的形状校验。只认对象 / 数组：任何一层不对都当成坏账本（走备份，不当成空账本
 * 覆盖用户文件）。`JSON.parse` 成功不等于账本可用 —— `null` 也会成功。
 */
function parseManifest(text: string): Partial<SeedManifest> {
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("顶层必须是对象");
	const value = parsed as Record<string, unknown>;
	const record = (raw: unknown, name: string): Record<string, unknown> => {
		if (raw === undefined) return {};
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${name} 必须是对象`);
		return raw as Record<string, unknown>;
	};
	const strings = (raw: unknown, name: string): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const [key, item] of Object.entries(record(raw, name))) {
			if (typeof item !== "string") throw new Error(`${name}.${key} 必须是字符串`);
			out[key] = item;
		}
		return out;
	};
	const skills: Record<string, Record<string, string>> = {};
	for (const [name, item] of Object.entries(record(value["skills"], "skills"))) {
		skills[name] = strings(item, `skills.${name}`);
	}
	const plugins = value["plugins"];
	if (plugins !== undefined && (!Array.isArray(plugins) || plugins.some((item) => typeof item !== "string"))) {
		throw new Error("plugins 必须是字符串数组");
	}
	const pluginFiles: Record<string, Record<string, string>> = {};
	for (const [name, item] of Object.entries(record(value["pluginFiles"], "pluginFiles"))) {
		pluginFiles[name] = strings(item, `pluginFiles.${name}`);
	}
	// 白名单式的解析：这里没列出来的字段会被丢掉，所以加字段**必须**同时加在这里
	// （否则读出来的账本永远少这一项 —— `removed` 第一次就是这么被吞掉的）。
	const removed = value["removed"];
	if (removed !== undefined && (!Array.isArray(removed) || removed.some((item) => typeof item !== "string"))) {
		throw new Error("removed 必须是字符串数组");
	}
	return {
		skills,
		plugins: plugins ?? [],
		pluginFiles,
		removed: removed ?? [],
		files: strings(value["files"], "files"),
		textKeys: strings(value["textKeys"], "textKeys"),
	};
}

async function writeManifest(path: string, manifest: SeedManifest): Promise<void> {
	await writeTextAt(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * 同步一组「一个源文件 → 一个工作区文件」的播种文件。
 *
 * 和技能同一套判据：缺的补、没改过的升级、改过的保留。`key` 是账本里的逻辑位置，
 * 不随绝对路径变化。返回值里的名字只用于启动日志。
 */
async function syncSeedFiles(
	targets: readonly { readonly key: string; readonly source: string; readonly target: string }[],
	manifest: SeedManifest,
	manifestPath: string,
): Promise<{ readonly written: readonly string[]; readonly updated: readonly string[]; readonly kept: readonly string[] }> {
	const written: string[] = [];
	const updated: string[] = [];
	const kept: string[] = [];
	let changed = false;
	for (const item of targets) {
		const source = await readTextOrUndefined(item.source);
		if (source === undefined) continue;
		const seedHash = hashOf(source);
		const existing = await readTextOrUndefined(item.target);
		if (existing === undefined) {
			await writeTextAt(item.target, source);
			manifest.files[item.key] = seedHash;
			written.push(item.key);
			changed = true;
			continue;
		}
		const currentHash = hashOf(existing);
		if (currentHash === seedHash) {
			if (manifest.files[item.key] !== seedHash) {
				manifest.files[item.key] = seedHash;
				changed = true;
			}
			continue;
		}
		const recorded = manifest.files[item.key];
		if (recorded === currentHash || (recorded === undefined && LEGACY_SEED_HASHES.has(currentHash))) {
			await writeTextAt(item.target, source);
			manifest.files[item.key] = seedHash;
			updated.push(item.key);
			changed = true;
			continue;
		}
		kept.push(item.key);
		console.warn(`[core] ${item.key} 已被本地修改，未覆盖`);
	}
	if (changed) await writeManifest(manifestPath, manifest);
	return { written, updated, kept };
}

/** 递归列出目录下的文件（相对路径，`/` 分隔）。读失败 → 空。 */
async function walkFiles(root: string, prefix: string): Promise<string[]> {
	const entries = await listDirSorted(join(root, ...prefix.split("/").filter(Boolean)));
	const out: string[] = [];
	for (const entry of entries) {
		const relpath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.kind === "dir") out.push(...(await walkFiles(root, relpath)));
		else if (entry.kind === "file") out.push(relpath);
	}
	return out;
}

/**
 * 把 `seed/rules.md` 同步进工作区。
 *
 * 和技能同一条判据（同一个账本）：缺的补、没改过的升到新版、改过的原样留着。
 * 以前规矩「只补不改」，理由是「我可能亲手改过措辞」—— 但那样出厂修正永远进不来
 * （`seed/rules.md` 改一句，已经在跑的工作区一辈子看不到）。用 hash 账本能同时满足两边。
 */
export async function seedRules(layout: Layout): Promise<"written" | "updated" | "exists" | "missing"> {
	const source = seedPath(RULES_FILE);
	if (!(await existsAt(source))) return "missing";
	const result = await syncSeedFiles(
		[{ key: RULES_FILE, source, target: layout.rulesFile }],
		await readManifest(layout.seedManifestFile),
		layout.seedManifestFile,
	);
	if (result.written.length > 0) return "written";
	return result.updated.length > 0 ? "updated" : "exists";
}

/**
 * 把出厂的提示词模板（`seed/prompt/*.md`）同步进工作区（`<workspace>/prompt/`）。
 *
 * 逐文件判而不是整目录判：新增一段模板（`85-xxx.md`）要能补进已经在跑的工作区。
 * 返回本次写入或升级的文件名（用于启动日志）。
 */
export async function seedPromptTemplates(layout: Layout): Promise<readonly string[]> {
	// 顺序只由文件名决定：目录顺序来自文件系统，不同机器不一样（`listDirSorted` 已排序）。
	const root = seedPath("prompt");
	const names = (await listDirSorted(root))
		.filter((entry) => entry.kind === "file" && entry.name.endsWith(".md"))
		.map((entry) => entry.name);
	const result = await syncSeedFiles(
		names.map((name) => ({ key: `prompt/${name}`, source: join(root, name), target: join(layout.promptRoot, name) })),
		await readManifest(layout.seedManifestFile),
		layout.seedManifestFile,
	);
	return [...result.written, ...result.updated].map((key) => key.slice("prompt/".length));
}

/**
 * 把出厂文案（`seed/text/*.md`）同步进应用私有目录（`<appRoot>/text/`）。
 *
 * 判据落到**键**上，和 prompt / rules 同一套（ADR-031 / ADR-114）：没改过的键跟到新版、
 * 改过的键原样留着、缺的键追加。以前是「只补不改」，结果改过措辞的键永远进不来 ——
 * 2026-11-08 实测，`say.param.options` 的新说法在已经在跑的工作区里读不到。
 */
export async function seedTextFiles(layout: Layout): Promise<readonly string[]> {
	const root = seedPath("text");
	const files = (await listDirSorted(root))
		.filter((entry) => entry.kind === "file" && entry.name.endsWith(".md"))
		.map((entry) => entry.name);
	const manifest = await readManifest(layout.seedManifestFile);
	const written: string[] = [];
	let ledgerChanged = false;
	for (const name of files) {
		const target = join(layout.textRoot, name);
		const source = await readTextOrUndefined(join(root, name));
		if (source === undefined) continue;
		const current = await readTextOrUndefined(target);
		if (current === undefined) {
			await writeTextAt(target, source);
			for (const [key, value] of parseCatalog(name, source)) manifest.textKeys[`${name}:${key}`] = hashOf(value);
			written.push(name);
			ledgerChanged = true;
			continue;
		}
		const prefix = `${name}:`;
		const seeded = new Map(
			Object.entries(manifest.textKeys)
				.filter(([key]) => key.startsWith(prefix))
				.map(([key, hash]) => [key.slice(prefix.length), hash] as const),
		);
		const merged = mergeCatalog(current, source, {
			seeded,
			legacy: (valueHash) => LEGACY_TEXT_KEYS.has(valueHash),
			hash: hashOf,
		});
		if (merged === undefined) continue;
		await writeTextAt(target, merged.text);
		for (const [key, hash] of merged.seeded) manifest.textKeys[`${name}:${key}`] = hash;
		written.push(name);
		ledgerChanged = true;
	}
	if (ledgerChanged) await writeManifest(layout.seedManifestFile, manifest);
	return written;
}

/**
 * 把出厂插件补进工作区（`<workspace>/plugins/<名字>/`）。
 *
 * 判据是**整个目录**（不是逐文件）：缺了整份补；盘上有、且每个文件都和上次播种时一样
 * （没人动过），整份升到新版；只要有一个文件不同，整份留着 —— 插件是可执行的代码，
 * 半新半旧比旧版更糟，动了就归改的人。
 *
 * **删掉的不会被塞回来**：见过一次就记进 `.seed-manifest.json`（`plugins`），
 * 之后只看账本 —— 否则「删除」只在这次进程里生效，重启就复活，和界面写的话不符。
 * 老账本没有 `pluginFiles`（不知道动没动过）：这次只记基线、不动手（ADR-097）。
 */
export async function seedPlugins(layout: Layout): Promise<readonly string[]> {
	const root = seedPath("plugins");
	const manifestPath = layout.seedManifestFile;
	const manifest = await readManifest(manifestPath);
	const seen = new Set(manifest.plugins);
	const removed = new Set(manifest.removed);
	const written: string[] = [];
	let changed = false;

	for (const entry of await listDirSorted(root)) {
		if (entry.kind !== "dir") continue;
		const name = entry.name;
		const target = join(layout.pluginsRoot, name);
		const seed = await pluginFiles(join(root, name));
		const record = manifest.pluginFiles[name];

		if (!(await existsAt(target))) {
			// 盘上没有：只有走过「删除」入口的才算是用户删的，不再补。
			// 没记在 `removed` 里的一律当意外丢失（手删目录、迁移、重装没带过来），补回。
			if (removed.has(name)) continue;
			seen.add(name);
			removed.delete(name);
			changed = true;
			await mirrorPlugin(target, seed, new Set());
			manifest.pluginFiles[name] = hashesOf(seed);
			written.push(name);
			continue;
		}

		// 盘上又有了（用户自己放回来 / 走过「装回」）：不再是「删掉的」。
		if (removed.delete(name)) changed = true;

		// 盘上有：先认它是不是「上次播种时那份原样」。
		const files = await pluginFiles(target);
		const current = hashesOf(files);
		// 老账本只记过「见过」：整份都命中历史出厂 hash、文件名也和当前出厂一致 = 没改过。
		const legacy =
			record === undefined &&
			sameFileNames(files, seed) &&
			Object.values(current).every((hash) => LEGACY_PLUGIN_HASHES.has(hash));
		const untouched = record === undefined ? legacy : sameHashes(current, record);
		if (!seen.has(name) || !untouched) {
			// 第一次见（老账本 / 手工放进去的）或我改过：记下基线，一个字节都不动。
			seen.add(name);
			manifest.pluginFiles[name] = current;
			changed = true;
			continue;
		}

		// 没人动过：整份对齐 seed（改的写、删的删）。
		const touched = await mirrorPlugin(target, seed, new Set(Object.keys(record ?? {})));
		const next = hashesOf(seed);
		if (touched || !sameHashes(next, record ?? {})) changed = true;
		manifest.pluginFiles[name] = next;
		if (touched) written.push(name);
	}

	if (changed) {
		manifest.plugins = [...seen].sort();
		manifest.removed = [...removed].sort();
		await writeTextAt(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	}
	return written;
}

/** 这个名字在不在出厂那份里（`seed/plugins/<名字>/` 存在就是）。 */
export async function isShippedPlugin(layout: Layout, name: string): Promise<boolean> {
	void layout;
	if (!isSafeName(name)) return false;
	return existsAt(join(seedPath("plugins"), name));
}

/**
 * 记一笔「用户把这个出厂插件删了」。
 *
 * 只记出厂就有的那些：自己装进去的插件删了就是删了，不该出现在「装回来」里
 * （出厂没有那份代码，装不回来）。
 */
export async function markRemoved(layout: Layout, name: string): Promise<void> {
	if (!isSafeName(name)) return;
	if (!(await existsAt(join(seedPath("plugins"), name)))) return;
	const manifestPath = layout.seedManifestFile;
	const manifest = await readManifest(manifestPath);
	if (manifest.removed.includes(name)) return;
	const next = { ...manifest, removed: [...manifest.removed, name].sort() };
	await writeTextAt(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * 用户自己删掉的出厂插件（界面上「装回来」能挑的）。
 *
 * 从账本读，不扫盘：盘上没有的出厂插件分两种 —— 删掉的、意外丢的，只有账本分得清。
 */
export async function removedPlugins(layout: Layout): Promise<readonly string[]> {
	const manifest = await readManifest(layout.seedManifestFile);
	const root = seedPath("plugins");
	const shipped = new Set((await listDirSorted(root)).filter((entry) => entry.kind === "dir").map((entry) => entry.name));
	return manifest.removed.filter((name) => shipped.has(name)).sort();
}

/**
 * 把一个被删掉的出厂插件装回来。
 *
 * 只认账本里记着「删过」的：没删过的传进来什么都不做（返回 false），免得把它当成
 * 一条绕过正常安装、往插件目录里写代码的路。装回用的是出厂那份，不是旧账本里的 hash。
 */
export async function restorePlugin(layout: Layout, name: string): Promise<boolean> {
	if (!isSafeName(name)) return false;
	const source = join(seedPath("plugins"), name);
	if (!(await existsAt(source))) return false;
	const manifestPath = layout.seedManifestFile;
	const manifest = await readManifest(manifestPath);
	if (!manifest.removed.includes(name)) return false;
	await mirrorPlugin(join(layout.pluginsRoot, name), await pluginFiles(source), new Set());
	const seen = new Set([...manifest.plugins, name]);
	const removed = new Set(manifest.removed.filter((item) => item !== name));
	await writeTextAt(
		manifestPath,
		`${JSON.stringify({ ...manifest, plugins: [...seen].sort(), removed: [...removed].sort(), pluginFiles: { ...manifest.pluginFiles, [name]: hashesOf(await pluginFiles(source)) } }, null, 2)}\n`,
	);
	return true;
}

/** 一个插件目录里的文本文件：相对路径（`/` 分隔）→ 内容。读不出来的跳过。 */
async function pluginFiles(root: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const relpath of await walkFiles(root, "")) {
		const content = await readTextOrUndefined(join(root, ...relpath.split("/")));
		if (content !== undefined) out.set(relpath, content);
	}
	return out;
}

function hashesOf(files: Map<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [relpath, content] of files) out[relpath] = hashOf(content);
	return out;
}

function sameFileNames(left: Map<string, string>, right: Map<string, string>): boolean {
	if (left.size !== right.size) return false;
	return [...left.keys()].every((key) => right.has(key));
}

function sameHashes(left: Record<string, string>, right: Record<string, string>): boolean {
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => right[key] === left[key]);
}

/** 让目标目录和 seed 一模一样：内容不同的写、seed 里没有的删。返回是否动过磁盘。 */
async function mirrorPlugin(target: string, seed: Map<string, string>, before: Set<string>): Promise<boolean> {
	let touched = false;
	for (const [relpath, content] of seed) {
		const path = join(target, ...relpath.split("/"));
		if ((await readTextOrUndefined(path)) === content) continue;
		await writeTextAt(path, content);
		touched = true;
	}
	for (const relpath of before) {
		if (seed.has(relpath)) continue;
		await removeAt(join(target, ...relpath.split("/")));
		touched = true;
	}
	return touched;
}

/**
 * 给某一个人的个人层播种技能（`members/<slug>/skills/`）。
 *
 * 为什么有些技能属于个人还是全员：一份技能属于谁，取决于「谁该为这条做法负责」。
 * 「怎么建团队」「怎么招人」是助理的判断，它自己会迭代 —— 写在全员层就等于宣布全员
 * 都得按助理那一套招人，而实际上别人不该招人。`写技能` / `找现成技能` 反过来是
 * 所有人都该会的手艺，所以它们在全员层。
 */
export async function seedPersonalSkills(agentDir: string, folder: string): Promise<readonly string[]> {
	return copySeedSkills(seedPath(folder), join(agentDir, SKILLS_DIR));
}

async function copySeedSkills(from: string, skillsRoot: string): Promise<readonly string[]> {
	const copied: string[] = [];
	for (const entry of await listDirSorted(from)) {
		if (entry.kind !== "dir") continue;
		const result = await copySkillDir(join(from, entry.name), skillsRoot);
		if (result.copied) copied.push(result.name);
	}
	return copied;
}

/**
 * 仓库自带的播种目录（`seed/<segments...>`）的真实路径。
 *
 * 用「从本文件往上找」而不是写死绝对路径：`src/shell/` 到仓库根是固定深度，
 * 但源码（`src/`）与构建产物（`dist/`）深度不同，所以往上找而不是数层级。
 */
function seedPath(...segments: readonly string[]): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	// `existsSync` 是保留例外：这里找的是**仓库自带的** `seed/`（启动装配期、同步调用），
	// 不是工作区文件，读不到也不该让服务起不来。
	for (let index = 0; index < 6; index += 1) {
		const candidate = join(dir, "seed", ...segments);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return join(dirname(fileURLToPath(import.meta.url)), "seed", ...segments);
}

/** 出厂助理身份的路径（相对 `seed/`）。身份是文件，不是代码里的字符串。 */
const SEED_ASSISTANT_IDENTITY = "assistant/identity.md";

/** 出厂助理的个人技能目录（相对 `seed/`）。 */
const SEED_ASSISTANT_SKILLS = "assistant/skills";

/** 取一个头字段；文档不存在 = `undefined`。 */
function front(doc: Doc | undefined, key: string): string | undefined {
	return doc === undefined ? undefined : frontOf(doc, key);
}

/**
 * 读出厂的助理身份。
 *
 * 读不到 → `undefined`（打包/部署方式可能不带 `seed/`，缺一份起手身份不该让服务起不来）。
 * 解析走 `doc.ts`：身份文件只有一种格式，读它和写它用同一份实现。
 */
async function readSeedAssistant(): Promise<Doc | undefined> {
	const source = await readTextOrUndefined(seedPath(SEED_ASSISTANT_IDENTITY));
	return source === undefined ? undefined : parseDoc(SEED_ASSISTANT_IDENTITY, source);
}

/**
 * 给一个工作区播种「我身边的人」。
 *
 * 这是**唯一**一处预置身份的地方，而且只写文件、不写代码：一份 identity.md，
 * 正文说清「你是我唯一直接对话的人，其余的人由你按需要创建」。
 * 之后它自己就会建人 —— 那些人的身份是它写的，不是代码写的。
 *
 * V2 的正文是写在这个函数里的字符串字面量：改一句话要改 TS、要重新编译、要重启。
 * 现在它和 agent 自己写的身份是同一种东西（同一个文件夹结构），改完下一条消息就生效。
 */
export async function seedOwnerAssistant(
	layout: Layout,
	options: { readonly name?: string } = {},
): Promise<string> {
	const { createAgent } = await import("../core/documents/member/identity.ts");
	const seed = await readSeedAssistant();
	if (seed === undefined) {
		console.warn(`[core] 没读到 ${SEED_ASSISTANT_IDENTITY}：助理身份会是一份占位正文`);
	}
	const name = options.name ?? front(seed, "name") ?? "助理";
	const title = front(seed, "title") ?? "助理";
	const team = front(seed, "team");
	const body = seed?.body;

	const identity = await createAgent({
		root: layout.assistantRoot,
		name,
		title,
		...(team === undefined ? {} : { team }),
		...(body === undefined || body === "" ? {} : { body }),
	});

	// 技能：和身份一样，是文件，不是代码。
	//
	// 两层，各自管各自的事：
	// - 全员层 `seed/skills/`（`写技能`、`找现成技能`）—— 所有人都该会的手艺。
	// - 助理自己的 `seed/assistant/skills/`（`建立团队`、`招人`）—— 它的判断，不属于别人。
	//   招人、建团队是助理的职权，别人本来就不该招人；写进全员层等于宣布全员都这么干。
	await syncAllSkills(layout);
	await seedPersonalSkills(identity.dir, SEED_ASSISTANT_SKILLS);
	return identity.slug;
}
