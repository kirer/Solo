/**
 * 一个人的档案与记忆。
 *
 * 界面右上角那个「详情」面板与记忆抽屉要的所有东西都在这里取，**不给界面对磁盘的
 * 访问权**（它会拿 slug 去拼路径），也不让它自己去读技能目录 —— 那等于把「路径怎么拼」
 * 这份知识复制到前端，两处早晚不一致。
 */
import { dirname, join } from "node:path";
import { OWNER_SLUG } from "../agent/identity.ts";
import { appendMemory, memoryDigest, memoryTimeline, readMemory, removeSection, sectionsOf, writeMemory } from "../agent/memory.ts";
import { listSkills } from "../agent/skills.ts";
import type { DirectoryState } from "../agent/roster.ts";
import { labelIn, withLabels } from "../view/index.ts";
import type { ViewPersonMemory, ViewPersonProfile } from "../view/dto.ts";
import { AppError } from "./errors.ts";
import type { Read } from "./read.ts";
import type { Snapshots } from "./snapshot.ts";
import type { CoreServices } from "./types.ts";

/** 记忆一次写操作的请求体。 */
export type MemoryEditBody = {
	readonly op?: string;
	readonly heading?: string;
	readonly text?: string;
};

export function createPeople(shell: CoreServices, snapshots: Snapshots, read: Read) {
	/**
	 * 只认名册里的 slug —— 这既挡住了路径穿越，也让「查一个不存在的人」老实回 404，
	 * 而不是先建出一个空目录。
	 */
	function requireSlug(directory: DirectoryState, slug: string): void {
		if (!(slug in directory.slugToConversation) || slug === OWNER_SLUG) {
			throw new AppError("not-found", "没有这个人");
		}
	}

	/** 档案：身份 / 技能 / 记忆概况 / 所在频道。 */
	async function readPersonProfile(slug: string): Promise<ViewPersonProfile> {
		const { identities, directory } = await snapshots.snapshot();
		requireSlug(directory, slug);
		const skills = await listSkills({ workspace: dirname(shell.agentsRoot), agents: shell.agentsRoot }, slug);
		const identity = identities.find((candidate) => candidate.slug === slug);
		const source = (await readMemory(join(shell.agentsRoot, slug))) ?? "";
		return {
			slug,
			label: labelIn(directory, slug),
			title: identity?.title ?? "",
			...(identity?.team === undefined ? {} : { team: identity.team }),
			manager: identity?.manager ?? "",
			managerLabel: identity?.manager === undefined ? "" : labelIn(directory, identity.manager),
			body: identity?.body ?? "",
			skills: skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				scope: skill.scope,
				overrides: skill.overrides === true,
			})),
			memory: {
				exists: source !== "",
				entries: sectionsOf(source).length,
				digest: memoryDigest(source) ?? null,
			},
			channels: await read.channelsOf(slug),
		};
	}

	/** 记忆全文 + 按小节拆开的条目（带 `.memory-journal.jsonl` 的留痕）。 */
	async function readPersonMemory(slug: string): Promise<ViewPersonMemory> {
		const { directory } = await snapshots.snapshot();
		requireSlug(directory, slug);
		const agentDir = join(shell.agentsRoot, slug);
		const source = (await readMemory(agentDir)) ?? "";
		const stamps = await memoryTimeline(agentDir);
		return {
			slug,
			label: withLabels(directory, []).labels?.[slug] ?? slug,
			exists: source !== "",
			digest: memoryDigest(source) ?? null,
			// `at`/`by`/`op` 来自 `.memory-journal.jsonl`。手写进 memory.md 的条目没有日志，
			// 就照实给 `null` —— 不拿「现在」去冒充「当时」（ADR-016）。
			entries: sectionsOf(source).map((section) => {
				const stamp = stamps.get(section.heading);
				return {
					heading: section.heading,
					body: section.body,
					at: stamp?.at ?? null,
					by: stamp?.by ?? null,
					op: stamp?.op ?? null,
				};
			}),
			raw: source,
		};
	}

	/**
	 * 删一条 / 添一条记忆。
	 *
	 * `actor` 由调用方给（网页写 `owner:web`，agent 自己 `remember` 写 `agent`），
	 * 这样以后真出错时，「这条是人在面板上删的」和「它自己改的」能一眼分开。
	 */
	async function editPersonMemory(
		slug: string,
		body: MemoryEditBody,
		actor: string,
	): Promise<{ ok: true; entries: number }> {
		const { directory } = await snapshots.snapshot();
		requireSlug(directory, slug);
		const agentDir = join(shell.agentsRoot, slug);
		if (body.op === "forget") {
			const source = (await readMemory(agentDir)) ?? "";
			// 重建交给 `removeSection`：删除必须和 `sectionsOf` 用同一套分段口径，
			// 在这里手拼行切片实测会把后面的节写坏（删末节最容易被漏）。
			const next = removeSection(source, body.heading ?? "");
			if (next === undefined) throw new AppError("not-found", "没有这一条记忆（可能已经被删掉）");
			const result = await writeMemory(agentDir, next, actor);
			return { ok: true, entries: sectionsOf(result.source).length };
		}
		if (body.op === "add") {
			const result = await appendMemory(agentDir, body.text ?? "", new Date(), actor);
			if (!result.changed) throw new AppError("bad-request", result.message);
			return { ok: true, entries: sectionsOf(result.source).length };
		}
		throw new AppError("bad-request", "op 只能是 forget 或 add");
	}

	return { readPersonProfile, readPersonMemory, editPersonMemory };
}

export type People = ReturnType<typeof createPeople>;
