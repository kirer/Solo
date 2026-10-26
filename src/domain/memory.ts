/**
 * 记忆分层（需求 #12）：**写时提炼、读时检索**，不是「把聊天记录存起来」。
 *
 * 老板的担心（2026-10-31）：「数据会越来越多，堆积问题很严重。」
 *
 * 所以这一层刻意做得很窄，三层各有一道闸：
 *
 * | 层 | 写者 | 写入门槛 | 读取预算 | 总量上限 |
 * | --- | --- | --- | --- | --- |
 * | staff | 员工自己 | **任务 done 时提醒必写** | 提示词里最多 5 条 | 50 条 → 折叠 20 |
 * | project | 项目负责人 | 主动调用 | 只 `memory_search` 时读 | 100 条 → 折叠 20 |
 * | company | CEO | 主动调用 | 只 `memory_search` 时读 | 200 条 → 折叠 20 |
 *
 * 三道闸分别挡住三种膨胀：
 * - **写入门槛**挡住「什么都记」——记忆不是日志，一条经验要能改变下次的做法；
 * - **读取预算**挡住「一次全塞进上下文」——注入的是摘要，不是原文；
 * - **总量上限**挡住「历史越积越厚」——超限时最老的 20 条会被机械折叠成
 *   一条「阶段总结」（保留标题与结论，丢掉过程细节）。
 *
 * 折叠为什么不用模型：它是**确定性**的维护动作，发生在写入路径上，
 * 用模型会让「写一条记忆」变成一次不可预期的长调用。折叠出来的总结
 * 以后被 agent 读到、觉得需要细化，它自己可以再 `memory_write` 一条覆盖主题。
 *
 * 纯函数，无 IO —— 读写文档在 `src/company/memory.ts`。
 */

/** 记忆的三个层。 */
export const MEMORY_LEVELS = ["staff", "project", "company"] as const;
export type MemoryLevel = (typeof MEMORY_LEVELS)[number];

/** 一条记忆。 */
export type MemoryEntry = {
	/** 文档内唯一，由写入方生成（`m-<at>-<序号>`）。 */
	id: string;
	at: number;
	level: MemoryLevel;
	/**
	 * 归属：
	 * - `staff`：会话号的十进制字符串（每个人自己的记忆，别人读不到）
	 * - `project`：项目 slug
	 * - `company`：固定为 `"company"`
	 */
	owner: string;
	/** 一句话标题（检索主要看它）。 */
	title: string;
	/** 正文：经验、结论、坑。**≤ 300 字**，超了由写入方截断。 */
	body: string;
	/** 检索标签（项目名、模块名、任务类型）。 */
	tags: string[];
	/** 与哪条任务有关（员工层用）。 */
	taskId?: string;
	/** 来源：任务完成自动提醒、主动写入、超限折叠。 */
	source: "task" | "manual" | "distill";
	/** 被折叠进它的条数（只有 `distill` 有）。 */
	folded?: number;
};

/** 记忆文档状态。 */
export type MemoryState = {
	entries: MemoryEntry[];
};

/** 每层的容量。超了就折叠最老的 `FOLD_BATCH` 条。 */
export const MEMORY_CAPACITY: Readonly<Record<MemoryLevel, number>> = {
	staff: 50,
	project: 100,
	company: 200,
};

/** 一次折叠吃掉多少条。 */
export const FOLD_BATCH = 20;

/** 正文长度上限。记忆是提炼，不是存档。 */
export const MEMORY_BODY_LIMIT = 300;

/** 一次能注入提示词的条数预算（读侧闸门）。 */
export const BRIEF_RECENT = 3;
export const BRIEF_MATCHED = 2;

export function emptyMemoryState(): MemoryState {
	return { entries: [] };
}

/** 该层的归属键。 */
export function ownerKeyOf(level: MemoryLevel, conversationId: number, project?: string): string | undefined {
	if (level === "company") return "company";
	if (level === "project") return project;
	return String(conversationId);
}

/** 某个归属下的全部条目（按时间升序）。 */
export function entriesOf(
	state: MemoryState,
	level: MemoryLevel,
	owner: string,
): readonly MemoryEntry[] {
	return state.entries.filter((entry) => entry.level === level && entry.owner === owner);
}

/**
 * 追加一条记忆，必要时折叠。
 *
 * 同一个 `taskId` 在员工层只保留**一条**：任务重开、反复 done 不该产生多条
 * 经验——后来的覆盖前面的（新经验比旧的准）。
 */
export function appendMemory(state: MemoryState, entry: MemoryEntry): MemoryState {
	const body = entry.body.length > MEMORY_BODY_LIMIT ? `${entry.body.slice(0, MEMORY_BODY_LIMIT - 1)}…` : entry.body;
	const normalized: MemoryEntry = { ...entry, body };
	const kept =
		normalized.taskId === undefined
			? state.entries
			: state.entries.filter(
					(other) => !(other.level === normalized.level && other.owner === normalized.owner && other.taskId === normalized.taskId),
				);
	return { entries: [...kept, normalized] };
}

/**
 * 按容量折叠。
 *
 * 只折叠**最老的** `FOLD_BATCH` 条，并把它们合成一条 `source: "distill"`
 * 的总结放在最前面（时间取被折叠的最后一条，这样它不会因为「最老」被立刻再折一次）。
 * 已有的 `distill` 条目也会被再次折进去——否则反复折叠会留下一堆总结。
 */
export function compactMemory(state: MemoryState): MemoryState {
	let entries = [...state.entries];
	let changed = true;
	while (changed) {
		changed = false;
		for (const level of MEMORY_LEVELS) {
			const owners = new Set(entries.filter((entry) => entry.level === level).map((entry) => entry.owner));
			for (const owner of owners) {
				const mine = entries.filter((entry) => entry.level === level && entry.owner === owner);
				const cap = MEMORY_CAPACITY[level];
				if (mine.length <= cap) continue;
				mine.sort((left, right) => left.at - right.at);
				const folded = mine.slice(0, FOLD_BATCH);
				const rest = mine.slice(FOLD_BATCH);
				const at = folded.at(-1)?.at ?? Date.now();
				const summary: MemoryEntry = {
					id: `m-distill-${level}-${owner}-${at}`,
					at,
					level,
					owner,
					title: `阶段总结（${folded.length} 条，截至 ${new Date(at).toISOString().slice(0, 10)}）`,
					body: folded
						.map((item) => `${item.title}：${firstLine(item.body, 60)}`)
						.join("；")
						.slice(0, MEMORY_BODY_LIMIT),
					tags: [...new Set(folded.flatMap((item) => item.tags))].slice(0, 8),
					source: "distill",
					folded: folded.reduce((sum, item) => sum + (item.folded ?? 1), 0),
				};
				// 只替换**这个分区**：别的层、别的负责人一条都不能动。
				// 曾经写成 `[summary, ...rest]`——那样每次折叠都会把其它分区整个丢掉。
				const isMine = (item: MemoryEntry): boolean => item.level === level && item.owner === owner;
				entries = [...entries.filter((item) => !isMine(item)), summary, ...rest];
				changed = true;
			}
		}
	}
	return { entries };
}

/**
 * 检索排序。
 *
 * 刻意**不引入向量检索**：一个员工的记忆上限 50 条、项目 100 条，
 * 词面匹配（标题/标签/正文的中文二元组重叠）已经够准，而且完全可解释——
 * 老板问「为什么想起这条」时能指着标签回答。等真到了几千条再谈向量。
 */
export function rankMemory(
	state: MemoryState,
	input: {
		readonly level?: MemoryLevel;
		readonly owner?: string;
		readonly query?: string;
		readonly limit?: number;
	},
): readonly MemoryEntry[] {
	const query = (input.query ?? "").trim();
	let candidates = state.entries.filter(
		(entry) =>
			(input.level === undefined || entry.level === input.level) &&
			(input.owner === undefined || entry.owner === input.owner),
	);
	if (query !== "") {
		const grams = bigrams(query);
		const scored = candidates
			.map((entry) => ({ entry, score: scoreOf(entry, grams) }))
			.filter((item) => item.score > 0)
			.sort((left, right) => right.score - left.score || right.entry.at - left.entry.at);
		candidates = scored.map((item) => item.entry);
	} else {
		candidates = [...candidates].sort((left, right) => right.at - left.at);
	}
	return candidates.slice(0, input.limit ?? 10);
}

/**
 * 注入提示词的「记忆简报」：最近 N 条 + 与当前任务相关的 M 条。
 *
 * 返回空串表示没有记忆——调用方不要为「没有记忆」写一句废话。
 */
export function renderMemoryBrief(
	state: MemoryState,
	input: { readonly level: MemoryLevel; readonly owner: string; readonly query?: string },
): string {
	const mine = entriesOf(state, input.level, input.owner);
	if (mine.length === 0) return "";
	const recent = [...mine].sort((left, right) => right.at - left.at).slice(0, BRIEF_RECENT);
	const query = (input.query ?? "").trim();
	const matched =
		query === ""
			? []
			: rankMemory(state, { level: input.level, owner: input.owner, query, limit: BRIEF_RECENT + BRIEF_MATCHED })
					.filter((entry) => !recent.includes(entry))
					.slice(0, BRIEF_MATCHED);
	const lines = [...recent, ...matched].map((entry) => `- ${entry.title}：${firstLine(entry.body, 80)}`);
	const extra = mine.length - lines.length;
	return [
		`【你的经验记忆（共 ${mine.length} 条，这里只给 ${lines.length} 条）】`,
		...lines,
		extra > 0 ? `（还有 ${extra} 条，用 memory_search 按时检索，不要凭印象猜）` : "",
	]
		.filter((line) => line !== "")
		.join("\n");
}

/** 词面打分的输入：中文按二元组切，英文按单词切。 */
function bigrams(text: string): readonly string[] {
	const lower = text.toLowerCase();
	const grams: string[] = [];
	for (const word of lower.match(/[a-z0-9_]{2,}/g) ?? []) grams.push(word);
	const han = lower.replace(/[^\u4e00-\u9fa5]+/g, " ");
	for (const run of han.split(/\s+/)) {
		for (let index = 0; index + 2 <= run.length; index += 1) grams.push(run.slice(index, index + 2));
	}
	return [...new Set(grams)];
}

function scoreOf(entry: MemoryEntry, grams: readonly string[]): number {
	if (grams.length === 0) return 0;
	const title = entry.title.toLowerCase();
	const tags = entry.tags.join(" ").toLowerCase();
	const body = entry.body.toLowerCase();
	let score = 0;
	for (const gram of grams) {
		// 标题与标签命中比正文命中重要得多——正文里「的、是、我们」这类噪音太多
		if (title.includes(gram)) score += 3;
		if (tags.includes(gram)) score += 2;
		else if (body.includes(gram)) score += 1;
	}
	return score;
}

function firstLine(text: string, max: number): string {
	const line = text.split("\n").find((item) => item.trim() !== "") ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
