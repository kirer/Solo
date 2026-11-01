/**
 * 「人」的用例：档案、记忆全文、记忆的增删。
 *
 * 与「读频道」分开的理由：它在读之外还有**写**（记忆留痕），而频道读是纯投影。
 * 两者共用的显示名只有 `labelIn` 一处。
 */
import { dirname, join } from "node:path";
import { OWNER_SLUG } from "../agent/identity.ts";
import { BACKGROUND_CONTEXT } from "../runtime/index.ts";
import { readTextOrUndefined, writeTextAtomicAt } from "../runtime/io.ts";
import { parseModelRef } from "../runtime/models.ts";
import { appendMemory, memoryTimeline, readMemory, removeSection, sectionsOf, writeMemory } from "../agent/memory.ts";
import { labelIn, type DirectoryState } from "../agent/roster.ts";
import { redact } from "../agent/secrets.ts";
import { listSkills } from "../agent/skills.ts";
import type { ViewPersonMemory, ViewPersonProfile } from "../view/dto.ts";
import { memoryEntries, memorySummary } from "./project.ts";
import { AppError } from "./errors.ts";
import type { Read } from "./read.ts";
import type { Snapshots } from "./snapshot.ts";
import type { CoreServices } from "./types.ts";

/**
 * 一个人的档案与记忆。
 *
 * 界面右上角那个「详情」面板与记忆抽屉要的所有东西都在这里取，**不给界面对磁盘的
 * 访问权**（它会拿 slug 去拼路径），也不让它自己去读技能目录 —— 那等于把「路径怎么拼」
 * 这份知识复制到前端，两处早晚不一致。
 */

/** 改某个人的模型：`provider/modelId`；空串 = 跟默认。 */
export type PersonModelBody = {
	readonly model?: string;
};

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

	/** 这个人此刻用的模型（`provider/modelId`）；没有模型就是空串。 */
	async function modelOf(slug: string): Promise<string> {
		const conversation = shell.conversations.get(slug);
		if (conversation === undefined) return "";
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		return agent.model === undefined ? "" : `${agent.model.provider}/${agent.model.modelId}`;
	}

	/** 档案：身份 / 技能 / 记忆概况 / 所在频道。 */
	async function readPersonProfile(slug: string): Promise<ViewPersonProfile> {
		const { identities, directory } = await snapshots.snapshot();
		requireSlug(directory, slug);
		const identity = identities.find((candidate) => candidate.slug === slug);
		// 团队层技能也是他会的手艺（`teams/<team>/skills/`），档案里一起列出来。
		const skills = await listSkills(
			{ workspace: dirname(shell.agentsRoot), agents: shell.agentsRoot, teams: shell.teamsRoot },
			slug,
			identity?.team,
		);
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
			memory: memorySummary(source),
			channels: await read.channelsOf(slug),
			model: await modelOf(slug),
		};
	}

	/** 记忆全文 + 按小节拆开的条目（带 `.memory-journal.jsonl` 的留痕）。 */
	async function readPersonMemory(slug: string): Promise<ViewPersonMemory> {
		const { directory } = await snapshots.snapshot();
		requireSlug(directory, slug);
		const agentDir = join(shell.agentsRoot, slug);
		const source = (await readMemory(agentDir)) ?? "";
		const summary = memorySummary(source);
		return {
			slug,
			label: labelIn(directory, slug),
			exists: summary.exists,
			digest: summary.digest,
			// 时间/作者来自 `.memory-journal.jsonl`；手写的条目没有日志，一律 `null`（ADR-016）。
			entries: memoryEntries(source, await memoryTimeline(agentDir)),
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
			// 网页上贴进来的这条也会进提示词，跟 agent 自己 `remember` 一样过脱敏。
			const result = await appendMemory(agentDir, redact(body.text ?? "", dirname(shell.agentsRoot)), new Date(), actor);
			if (!result.changed) throw new AppError("bad-request", result.message);
			return { ok: true, entries: sectionsOf(result.source).length };
		}
		throw new AppError("bad-request", "op 只能是 forget 或 add");
	}

	/**
	 * 换某个人的模型：**当场生效**（改会话的 `configure`），同时记进 `settings.json` 的
	 * `agentModels` —— 不记的话重启时装配会把他改回默认，界面上看起来就是「设置自己变回去」。
	 *
	 * 空串 = 跟默认（删掉这条记录）。只认注册表里真有的模型：写一个解析不到的引用，
	 * 这个人此后每轮都 `no_model`，而界面上只是一句「他这一轮没答上来」。
	 */
	async function setPersonModel(slug: string, body: PersonModelBody): Promise<{ model: string }> {
		const { directory } = await snapshots.snapshot();
		requireSlug(directory, slug);
		const conversation = shell.conversations.get(slug);
		if (conversation === undefined) throw new AppError("not-found", "没有这个人的会话");

		// 刚在设置里加的提供商，先装进注册表再校验（ADR-025）。
		await shell.refreshModels?.();
		const value = (body.model ?? "").trim();
		const wanted = value === "" ? shell.defaultModel : parseModelRef(value);
		if (wanted === undefined) {
			throw new AppError("bad-request", value === "" ? "还没有配置默认模型，先配一只" : `模型要写成 提供商/模型：${value}`);
		}
		if (shell.models !== undefined && shell.models.getModel(wanted.provider, wanted.modelId) === undefined) {
			throw new AppError("bad-request", `没有这个模型：${value}（看一眼 设置 → 模型 里的提供商和模型目录）`);
		}

		await conversation.configure({ model: { provider: wanted.provider, modelId: wanted.modelId } }, BACKGROUND_CONTEXT);

		const file = join(dirname(shell.agentsRoot), "settings.json");
		let settings: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse((await readTextOrUndefined(file)) ?? "{}");
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
		} catch {
			// 坏文件：当成空的写一份新的，下面这一份至少是合法的。
		}
		const raw = settings["agentModels"];
		const agentModels: Record<string, string> = {};
		if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
			for (const [key, item] of Object.entries(raw)) if (typeof item === "string") agentModels[key] = item;
		}
		if (value === "") delete agentModels[slug];
		else agentModels[slug] = value;
		if (Object.keys(agentModels).length === 0) delete settings["agentModels"];
		else settings["agentModels"] = agentModels;
		await writeTextAtomicAt(file, `${JSON.stringify(settings, null, 2)}\n`);
		return { model: value };
	}

	return { readPersonProfile, readPersonMemory, editPersonMemory, setPersonModel };
}