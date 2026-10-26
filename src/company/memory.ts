/**
 * 记忆分层的 IO 层：读写 `MemoryDoc` + 两个工具（`memory_write` / `memory_search`）。
 *
 * 纯逻辑在 `src/domain/memory.ts`（写入门槛、读取预算、超限折叠都在那里）。
 * 这里只负责三件事：
 *
 * 1. 从会话号反查「我是谁、我在哪个项目」（记忆的归属不能由模型自己声明——
 *    声明就意味着它可以往别人的记忆里写）。
 * 2. 把写/读包成工具。
 * 3. 任务完成时生成一条**提醒**（不强制写入）：强制的写会让 agent 为了交差
 *    编一句废话，那比不写更糟。
 */
import { BACKGROUND_CONTEXT, defineDoc, type CompanyRuntime, type Context } from "../runtime/index.ts";
import { defineTool, Type } from "../runtime/index.ts";
import {
	appendMemory,
	compactMemory,
	emptyMemoryState,
	entriesOf,
	MEMORY_LEVELS,
	renderMemoryBrief,
	rankMemory,
	type MemoryEntry,
	type MemoryLevel,
	type MemoryState,
} from "../domain/memory.ts";
import { personOf } from "../domain/membership.ts";
import { buildOrg } from "./org-model.ts";
import { CompanyDoc } from "./docs.ts";

/** 记忆文档：公司级单文档，按 `level + owner` 分区。 */
export const MemoryDoc = defineDoc<MemoryState>({
	kind: "app.memory",
	version: 1,
	scope: "session",
	initial: () => emptyMemoryState(),
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

/** 读记忆文档。 */
export async function readMemory(runtime: CompanyRuntime, context: Context = BACKGROUND_CONTEXT): Promise<MemoryState> {
	return (await runtime.harness.snapshot(MemoryDoc, context)) ?? emptyMemoryState();
}

/**
 * 同步版的归属判定：只吃已经读到的公司文档，不再读库。
 *
 * 投递路径（`deliver`）里已经有 `org` 了，再读一次 `CompanyDoc` 就是同一份
 * 数据读两遍——投递是热路径，省这一下有意义。
 */
export function memoryActorFromOrg(org: ReturnType<typeof buildOrg>, conversationId: number): MemoryActor | undefined {
	const person = personOf(org, conversationId);
	const label = person?.label ?? (conversationId === 0 ? "老板" : `会话 ${conversationId}`);
	if (person === undefined) {
		return conversationId === 0 ? { conversationId, label, level: "company", owner: "company" } : undefined;
	}
	if (person.role === "ceo" || person.role === "management") {
		return { conversationId, label, level: "company", owner: "company", ...(person.project === undefined ? {} : { project: person.project }) };
	}
	if (person.role === "leader" && person.project !== undefined) {
		return { conversationId, label, level: "project", owner: person.project, project: person.project };
	}
	return {
		conversationId,
		label,
		level: "staff",
		owner: String(conversationId),
		...(person.project === undefined ? {} : { project: person.project }),
	};
}

/** 这个人是谁、能写哪一层的记忆。 */
type MemoryActor = {
	readonly conversationId: number;
	readonly label: string;
	readonly level: MemoryLevel;
	readonly owner: string;
	readonly project?: string;
};

/**
 * 从会话号推出记忆归属。
 *
 * 刻意**不让模型传 `level` / `owner`**：能声明归属就等于能往别人的记忆里写、
 * 或者替公司编一条「公司惯例」。写哪一层由组织结构决定，不由模型决定。
 *
 * - 老板与 CEO、管理层 → `company`
 * - 项目负责人 → `project`（本项目）+ `company` 的读权限
 * - 员工 → `staff`（自己的）
 */
export async function memoryActorOf(
	runtime: CompanyRuntime,
	conversationId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<MemoryActor | undefined> {
	const company = await runtime.harness.snapshot(CompanyDoc, context);
	const org = buildOrg(company);
	const person = personOf(org, conversationId);
	const label = person?.label ?? (conversationId === 0 ? "老板" : `会话 ${conversationId}`);
	if (person === undefined) {
		// 老板（OWNER_ID = 0）不在 people 里，但它是唯一有全局视角的人。
		return conversationId === 0
			? { conversationId, label, level: "company", owner: "company" }
			: undefined;
	}
	if (person.role === "ceo" || person.role === "management") {
		return { conversationId, label, level: "company", owner: "company", ...(person.project === undefined ? {} : { project: person.project }) };
	}
	if (person.role === "leader" && person.project !== undefined) {
		// 负责人写自己的项目记忆；公司级要 CEO 写（避免每个项目都往公司层灌）
		return { conversationId, label, level: "project", owner: person.project, project: person.project };
	}
	return {
		conversationId,
		label,
		level: "staff",
		owner: String(conversationId),
		...(person.project === undefined ? {} : { project: person.project }),
	};
}

/** 一个会话能读哪些层（写只能写自己的那层）。 */
function readableLevels(actor: MemoryActor): readonly { level: MemoryLevel; owner: string }[] {
	const out: { level: MemoryLevel; owner: string }[] = [{ level: actor.level, owner: actor.owner }];
	if (actor.level === "staff" && actor.project !== undefined) {
		out.push({ level: "project", owner: actor.project });
	}
	if (actor.level !== "company") out.push({ level: "company", owner: "company" });
	return out;
}

/** 写入一条记忆。 */
export async function writeMemory(
	runtime: CompanyRuntime,
	input: {
		readonly level: MemoryLevel;
		readonly owner: string;
		readonly title: string;
		readonly body: string;
		readonly tags?: readonly string[];
		readonly taskId?: string;
		readonly source?: MemoryEntry["source"];
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ readonly ok: true; readonly entry: MemoryEntry; readonly folded: boolean }> {
	const at = Date.now();
	const entry: MemoryEntry = {
		id: `m-${at}-${Math.random().toString(36).slice(2, 8)}`,
		at,
		level: input.level,
		owner: input.owner,
		title: input.title.trim() === "" ? "（无标题）" : input.title.trim(),
		body: input.body,
		tags: [...(input.tags ?? [])],
		...(input.taskId === undefined ? {} : { taskId: input.taskId }),
		source: input.source ?? "manual",
	};
	let folded = false;
	await runtime.harness.commit(async (tx) => {
		const doc = await tx.doc(MemoryDoc);
		const state = doc as MemoryState;
		const next = compactMemory(appendMemory(state, entry));
		folded = next.entries.length !== state.entries.length + 1;
		state.entries = next.entries;
		return true;
	}, context);
	return { ok: true, entry, folded };
}

/**
 * 任务完成时该写一条经验（供 `transitionTask` 拼提醒文案，**不强制写**）。
 *
 * 为什么是提醒而不是自动写：强制写会让 agent 为了交差编一句废话，
 * 那比不写更糟——记忆层一旦被流水账填满，检索就再也挑不出有用的东西。
 * 系统只保证「它被提醒过」，写不写由它判断。
 */
export function memoryReminderFor(taskId: string): string {
	return [
		`【记忆】任务 ${taskId} 已完成。如果有值得下次复用的经验（踩过的坑、有效的做法、`,
		"下次该先检查什么），用 memory_write 记一条。",
		"只记能改变下次做法的东西；写「顺利完成了」这样的流水账没有价值，不如不写。",
	].join("\n");
}

/**
 * 两个记忆工具。
 *
 * `memory_search` 是核心工具（每轮都可能想查）；`memory_write` 不是——
 * 写是低频动作，藏在 `tool_search` 后面，避免模型每轮都想着「记点什么」。
 */
export function createMemoryTools(runtime: CompanyRuntime): {
	readonly memoryWrite: ReturnType<typeof defineTool>;
	readonly memorySearch: ReturnType<typeof defineTool>;
} {
	const memoryWrite = {
		name: "memory_write",
		description: [
			"把一条经验写进记忆，供以后自己（或项目/公司）复用。",
			"写什么：踩过的坑、有效的做法、下次该先检查什么。**不写**流水账和任务摘要。",
			"标题要能当检索词用（「迁移时先备份 sqlite」好过「迁移经验」）。",
			"正文 ≤ 300 字；超了会被截断。",
			"写哪一层由你的角色决定，不用也不能指定：员工写自己，负责人写项目，管理层写公司。",
		].join(""),
		parameters: Type.Object({
			title: Type.String({ description: "一句话标题（未来检索主要看它）" }),
			body: Type.String({ description: "经验正文：具体情况 + 结论 + 下次怎么做" }),
			tags: Type.Optional(Type.Array(Type.String(), { description: "标签，例如项目名、模块名、任务类型" })),
			task: Type.Optional(Type.String({ description: "相关任务标识（例如 T-12）；同一任务只有一条记忆，后写的覆盖前面的" })),
		}),
		execute: async (
			args: { title: string; body: string; tags?: string[]; task?: string },
			api: { conversationId: string | number },
			context?: Context,
		) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const actor = await memoryActorOf(runtime, Number(api.conversationId), ctx);
			if (actor === undefined) return "找不到你的身份，无法写记忆。";
			const result = await writeMemory(
				runtime,
				{
					level: actor.level,
					owner: actor.owner,
					title: args.title,
					body: args.body,
					tags: args.tags ?? [],
					...(args.task === undefined ? {} : { taskId: args.task }),
				},
				ctx,
			);
			return [
				`已记入 ${levelLabel(actor.level)}（${result.entry.id}）。`,
				result.folded ? "记忆条数超过上限，最老的若干条已折叠成一条阶段总结。" : "",
			]
				.filter((line) => line !== "")
				.join("");
		},
	} as unknown as ReturnType<typeof defineTool>;

	const memorySearch = {
		name: "memory_search",
		description: [
			"按关键词检索记忆（自己的 + 项目 + 公司）。回答「我们以前怎么处理的」这类问题前先查它。",
			"不传关键词时返回最近的几条。",
		].join(""),
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "关键词；不传则列最近的" })),
			limit: Type.Optional(Type.Number({ description: "最多几条，默认 8" })),
		}),
		execute: async (
			args: { query?: string; limit?: number },
			api: { conversationId: string | number },
			context?: Context,
		) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const actor = await memoryActorOf(runtime, Number(api.conversationId), ctx);
			if (actor === undefined) return "找不到你的身份，无法检索记忆。";
			const state = await readMemory(runtime, ctx);
			const limit = Math.min(Math.max(args.limit ?? 8, 1), 30);
			const rows: MemoryEntry[] = [];
			for (const scope of readableLevels(actor)) {
				const found = rankMemory(state, {
					level: scope.level,
					owner: scope.owner,
					...(args.query === undefined ? {} : { query: args.query }),
					limit,
				});
				rows.push(...found);
			}
			if (rows.length === 0) {
				return args.query === undefined ? "还没有任何记忆。" : `没有与「${args.query}」相关的记忆。`;
			}
			return [
				`找到 ${rows.length} 条：`,
				...rows.slice(0, limit).map(
					(entry) =>
						`\n【${levelLabel(entry.level)}】${entry.title}（${new Date(entry.at).toISOString().slice(0, 10)}）\n${entry.body}${
							entry.tags.length === 0 ? "" : `\n标签：${entry.tags.join("、")}`
						}`,
				),
			].join("\n");
		},
	} as unknown as ReturnType<typeof defineTool>;

	return { memoryWrite, memorySearch };
}

/** 注入到提示词里的一段记忆简报（没有记忆时返回空串）。 */
export async function memoryBriefFor(
	runtime: CompanyRuntime,
	conversationId: number,
	query: string | undefined,
	context: Context = BACKGROUND_CONTEXT,
): Promise<string> {
	const actor = await memoryActorOf(runtime, conversationId, context);
	if (actor === undefined) return "";
	const state = await readMemory(runtime, context);
	return renderMemoryBrief(state, {
		level: actor.level,
		owner: actor.owner,
		...(query === undefined ? {} : { query }),
	});
}

function levelLabel(level: MemoryLevel): string {
	if (level === "staff") return "个人记忆";
	if (level === "project") return "项目记忆";
	return "公司记忆";
}

/** 供外部（org 装配、档案接口）用的常量与类型。 */
export { MEMORY_LEVELS, entriesOf };
