/**
 * 把「文件夹里的身份」接到库里：一个 agent 的会话为什么能用上它自己的提示词。
 *
 * 关键决策：**提示词是每次请求现读文件渲染的**（`PromptSection.render`），不是建会话时
 * 算好写进 `instructions` 的。这样「改文件 = 改身份」才真的成立 —— 不需要重开会话、
 * 不需要重启进程、不需要谁批准。代价是每次请求多几次 `readFile`（微秒级，
 * 相对一次模型请求可以忽略）。
 *
 * 反面做法（`instructions` 一次性写入）之所以不行：它会把身份钉死在会话创建的那一刻，
 * 之后 agent 改自己的 `identity.md` 会静默无效 —— 而它自己看不出来。
 */
import { join } from "node:path";
import { type PromptSection, type Registry, type ToolRegistration } from "../runtime/index.ts";
import { chainUp, managerOf, readAllIdentities, readIdentity, reportsOf, OWNER_SLUG, type Identity } from "./identity.ts";
import { listSkills } from "./skills.ts";
import { memoryDigest, readMemory } from "./memory.ts";
import { loadRules } from "./rules.ts";
import { readTeam } from "../team/doc.ts";
import { teamMemoryDigest, readTeamMemory } from "../team/memory.ts";
import { createFsx } from "../fsx.ts";
import { loadTemplates, PROMPT_DIR, type PromptTemplate } from "../prompt.ts";
import { hasSlot, renderSlots, slotsIn, type Slots, type SlotValue } from "../text.ts";

export type AgentPaths = {
	/** 工作区根（公司层技能在 `<workspace>/skills/`）。 */
	readonly workspace: string;
	/** `workspace/agents`。 */
	readonly agents: string;
	/** `workspace/teams`。 */
	readonly teams: string;
	/**
	 * 这个人此刻在哪些会话里。
	 *
	 * 用函数而不是数组：提示词是每次渲染现读的，我建群、加人、开私聊之后下一条就生效。
	 * 不给就整段不出现（纯文件场景与旧测试）。
	 */
	readonly chats?: (slug: string) => Promise<readonly ChatRef[]>;
};

/** 一个会话的对外形状。`kind` 由成员推（`channel/state.ts` 的 `chatKind`），不存字段。 */
export type ChatRef = {
	readonly id: string;
	readonly title: string;
	readonly kind: "dm" | "group";
};

/** 一项能力的展示信息：名字 + 一句话。正文归工具自己的 description。 */
export type CapabilityLine = {
	readonly name: string;
	readonly summary: string;
};

/**
 * 读团队简报（`teams/<slug>/README.md`）。
 *
 * YAML 头里的字段单独摘出来写一行「状态/团队管理员」，因为模型扫一眼就知道该不该
 * 关心这件事，不用自己从正文里推。正文原样给全 —— 团队说明就是它的事实来源。
 */
export async function readTeamBrief(teamsRoot: string, team: string): Promise<string | undefined> {
	const doc = await readTeam(teamsRoot, team);
	if (doc === undefined) return undefined;
	const head = [`状态：${doc.status}`, `团队管理员：${doc.lead ?? "（还没人负责）"}`, `目录：teams/${doc.slug}/`];
	return `${head.join(" · ")}\n\n${doc.body}`;
}

/**
 * 能力名 → 展示行。
 *
 * 直接拍注册表：注册表里有什么，就是它真能调用的全部。**不**读任何清单文件 ——
 * 清单一旦和注册表不一致，提示词就会撒谎（写着有、调了失败，或者反过来）。
 */
export function registeredTools(registry: Registry): readonly CapabilityLine[] {
	const snapshot = registry.snapshot();
	const byName = new Map<string, CapabilityLine>();
	for (const { tool } of snapshot.tools()) {
		const name = (tool as { readonly name?: string }).name;
		if (name === undefined) continue;
		byName.set(name, { name, summary: summaryOf(tool) });
	}
	return [...byName.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function summaryOf(tool: unknown): string {
	const description = (tool as { readonly description?: unknown }).description;
	if (typeof description === "string" && description.trim() !== "") {
		// 只取第一句：能力清单是索引，不是手册。
		const first = description.trim().split(/(?<=。)|\.\s/)[0];
		return (first ?? description).trim();
	}
	return "（没有说明）";
}

/**
 * 段落的 key。
 *
 * 底层要求 key 匹配 `^[a-z][a-z0-9_-]*$`（还保留 `instructions` 这个名字），
 * 而 slug 可以是中文（`agents/林越/`），所以这里必须转义：UTF-8 字节的十六进制，
 * 前缀补一个字母。结果稳定、唯一、纯 ASCII。
 */
export function sectionKeyOf(slug: string): string {
	return `agent-${Buffer.from(slug, "utf8").toString("hex")}`;
}

const identitylessPrompt = (slug: string): string =>
	`# 你还没有身份文件\n\n请先在 \`agents/${slug}/identity.md\` 写下你是谁。在那之前，你只知道自己在跟我对话。\n`;

/** 空清单怎么写。写「（目前没有）」而不是留空：空串会让一句话只剩半截。 */
const NOTHING = "（目前没有）";

/** 名册里的显示名。我是「我」，其余用 `name`，没有就用 slug。 */
function labelOf(all: readonly Identity[], slug: string): string {
	if (slug === OWNER_SLUG) return "我";
	return all.find((item) => item.slug === slug)?.name ?? slug;
}

/** `名字（\`slug\`）`—— 名字给人看，slug 给工具用，两个都要。 */
function withSlug(name: string, slug: string): string {
	return `${name}（\`${slug}\`）`;
}

/** 技能一行：名字 — 什么时候用（来源）。正文不在提示词里，读了才知道细节。 */
function skillLine(skill: {
	readonly name: string;
	readonly description: string;
	readonly scope?: "company" | "personal";
	readonly overrides?: boolean;
}): string {
	const source =
		skill.scope === "personal"
			? skill.overrides === true
				? "（你自己改过的版本，覆盖了公司的同名技能）"
				: "（你自己写的）"
			: "（公司通用）";
	return `- \`${skill.name}\` — ${skill.description}${source}`;
}

/** 频道一行：在哪些群、和我的私聊开没开。 */
function chatLine(chats: readonly ChatRef[]): string {
	const groups = chats.filter((chat) => chat.kind === "group");
	const dm = chats.some((chat) => chat.kind === "dm");
	return [
		groups.length === 0 ? "没在任何群里" : `群${groups.map((chat) => `「${chat.title}」`).join("、")}`,
		dm ? "和我的私聊已开" : "和我的私聊没开（私聊只能我开）",
	].join("；");
}

/**
 * 这一段用得到的插槽 → 值。
 *
 * **只填这段模板真的写到的名字**（`slotsIn`）：一次生成要渲染 8 段，全填一遍等于每段都把
 * 名册、技能、记忆、团队读一遍。V2 就是按段懒读的，这个性质不能丢。
 *
 * 读盘全在这里：模板只负责排版，事实从磁盘/注册表现拍。
 */
async function slotsFor(
	registry: Registry,
	paths: AgentPaths,
	slug: string,
	self: Identity,
	template: PromptTemplate,
): Promise<Slots> {
	const need = new Set(slotsIn(template.body));
	if (template.skipEmpty !== undefined) need.add(template.skipEmpty);
	const wants = (...names: readonly string[]): boolean => names.some((name) => need.has(name));

	const slots: Record<string, SlotValue> = {
		"self.name": self.name ?? self.slug,
		"self.title": self.title,
		"self.slug": self.slug,
		"self.body": self.body,
	};

	// 规矩是公司层文件，读不到就当没有：不能让一次文件缺失拖垮整段提示词。
	if (need.has("rules")) slots["rules"] = await loadRules(paths.workspace);

	const needsRoster = wants("manager", "reports", "chain", "count", "team", "peers", "team.members");
	const all = needsRoster ? await readAllIdentities(paths.agents) : [];
	if (need.has("count")) slots["count"] = all.length;
	// 位置段这四行**永远有值**：写「（未设置）」会让提示词里出现一句半截的话，模型会自己补。
	// 没有上级 / 没有团队本身就是事实，直接说出来。
	if (need.has("manager")) {
		const manager = managerOf(all, self.slug);
		slots["manager"] =
			manager === undefined
				? "没有人（要拍板的事自己定，或者交给我）"
				: manager === OWNER_SLUG
					? "我（用户本人）"
					: withSlug(labelOf(all, manager), manager);
	}
	if (need.has("reports")) {
		const reports = reportsOf(all, self.slug);
		slots["reports"] =
			reports.length === 0 ? NOTHING : reports.map((item) => withSlug(item.name ?? item.slug, item.slug)).join("、");
	}
	if (need.has("chain")) {
		const chain = chainUp(all, self.slug);
		slots["chain"] = chain.length > 1 ? chain.map((item) => labelOf(all, item)).join(" → ") : "只有你和我";
	}
	if (need.has("team")) slots["team"] = self.team === undefined ? "没在任何团队里" : `\`${self.team}\``;
	if (need.has("peers")) {
		const peers =
			self.team === undefined ? [] : all.filter((item) => item.team === self.team && item.slug !== self.slug);
		slots["peers"] =
			peers.length === 0
				? "没有同团队的人"
				: peers.map((item) => `${item.name ?? item.slug}（${item.title ?? "成员"}）`).join("、");
	}
	if (need.has("chats")) {
		const chats = paths.chats === undefined ? undefined : await paths.chats(slug);
		slots["chats"] = chats === undefined ? undefined : chatLine(chats);
	}
	// 模板里唯一允许出现工具名的地方：`{{tool:say}}`。名字从注册表现拍 —— 工具改了名，
	// 提示词自动跟着变，不会教错。注册表里没有这个名字就留空（渲染成「（未设置）」并 warn）。
	const tools = wants("tools") || [...need].some((name) => name.startsWith("tool:")) ? registeredTools(registry) : [];
	if (need.has("tools")) {
		slots["tools"] =
			tools.length === 0
				? "（工具没装上 —— 这是装配故障，不是你的问题。请向我报告。）"
				: tools.map((tool) => `- \`${tool.name}\` — ${tool.summary}`).join("\n");
	}
	for (const name of need) {
		if (!name.startsWith("tool:")) continue;
		const tool = name.slice("tool:".length);
		slots[name] = tools.some((item) => item.name === tool) ? tool : undefined;
	}
	if (need.has("memory")) {
		const memory = await readMemory(join(paths.agents, slug));
		slots["memory"] = memory === undefined ? undefined : memoryDigest(memory);
	}
	if (need.has("skills")) {
		const skills = await promptSkills(paths, slug);
		slots["skills"] = skills.length === 0 ? undefined : skills.map(skillLine).join("\n");
	}

	const team = self.team;
	if (wants("team.brief", "team.members", "team.memory")) {
		const brief = team === undefined ? undefined : await readTeamBrief(paths.teams, team);
		const members =
			team === undefined ? undefined : all.filter((item) => item.team === team).map((item) => item.slug);
		const teamMemory = team === undefined ? undefined : await readTeamMemory(paths.teams, team);
		slots["team.brief"] = brief;
		slots["team.members"] = members === undefined || members.length === 0 ? undefined : members.map((item) => `\`${item}\``).join("、");
		// 新团队还没有记忆：写一句真话，别让模板里出现「（未设置）」。
		slots["team.memory"] =
			teamMemory === undefined ? "（这个团队还没有记忆。踩到的坑自己记下来。）" : teamMemoryDigest(teamMemory);
	}

	return slots;
}

/** 系统提示词模板（`use: system`）。读不到 = 空数组（模板缺失，提示词会是空的）。 */
async function systemTemplates(workspace: string): Promise<readonly PromptTemplate[]> {
	const templates = await loadTemplates(createFsx(workspace), PROMPT_DIR);
	const system = templates.filter((template) => template.use === "system");
	if (system.length === 0) {
		console.warn(`[core] 没读到提示词模板（${join(workspace, PROMPT_DIR)}）：身份段会是空的`);
	}
	return system;
}

/**
 * 一段的正文。`self` 是已经读过的身份（`undefined` = 还没有身份文件）。
 *
 * 「还没写身份」与「这一段要不要给东西」这两件事只有这一处判断：整段一次渲染
 * （`renderAgentSegments`）与按段渲染（`agentSections`）都走它，否则两边的空段规则
 * 迟早会分叉 —— 分叉的表现是提示词字节变了，缓存被悄悄打穿。
 */
async function segmentText(
	registry: Registry,
	paths: AgentPaths,
	slug: string,
	self: Identity | undefined,
	segment: string,
	templates: readonly PromptTemplate[],
): Promise<string> {
	if (self === undefined) return segment === "who" ? identitylessPrompt(slug) : "";
	const template = templates.find((item) => item.segment === segment);
	if (template === undefined) return "";
	const slots = await slotsFor(registry, paths, slug, self, template);
	// `skip-empty`：这个事实现在没有 → 整段消失（不写「规矩：（未设置）」，那会被当成许可）。
	if (template.skipEmpty !== undefined && !hasSlot(slots, template.skipEmpty)) return "";
	const rendered = renderSlots(template.body, slots);
	for (const issue of rendered.issues) {
		console.warn(
			`[core] 提示词插槽没填上：agents/${slug} 的 ${segment} 段 {{${issue.slot}}}（${issue.reason}）`,
		);
	}
	return rendered.text.trim();
}

/**
 * 渲染某人**此刻**的提示词正文。
 *
 * 单独导出的理由：自测要断言「规矩真的进了提示词」，而去问模型不可靠（它会背课文）。
 * 拿同一份 `render` 的结果来断言，验的就是模型真会读到的那段字。
 *
 * 每次渲染都重新读盘，因此改了 `identity.md` / 记忆 / 技能后，**下一条消息**
 * 就生效。这是「文档是真理」在运行时的落点，这里退化成一次文件读。
 */
export async function renderAgentSection(registry: Registry, paths: AgentPaths, slug: string): Promise<string> {
	return (await renderAgentSegments(registry, paths, slug))
		.map((segment) => segment.text)
		.filter((text) => text !== "")
		.join("\n\n");
}

/** 技能清单（提示词只要名字 + 一句描述）。 */
async function promptSkills(paths: AgentPaths, slug: string) {
	const skills = await listSkills({ workspace: paths.workspace, agents: paths.agents }, slug);
	return skills.map((skill) => ({
		name: skill.name,
		description: skill.description,
		scope: skill.scope,
		...(skill.overrides === true ? { overrides: true } : {}),
	}));
}

/**
 * 渲染某人此刻的提示词，**按稳定段切开**（顺序即拼接顺序 = 模板文件名前缀）。
 *
 * 段名来自 `prompt/*.md` 的文件名，不再是一份代码里的常量表：加一段就是加个文件。
 */
export async function renderAgentSegments(registry: Registry, paths: AgentPaths, slug: string) {
	const self = await readIdentity(paths.agents, slug);
	const templates = await systemTemplates(paths.workspace);
	const segments: { readonly segment: string; readonly text: string }[] = [];
	if (self === undefined) {
		return [{ segment: "who", text: identitylessPrompt(slug) }];
	}
	for (const template of templates) {
		segments.push({ segment: template.segment, text: await segmentText(registry, paths, slug, self, template.segment, templates) });
	}
	return segments;
}

/**
 * 一个 agent 的提示词段落（一段一个 section，key = `<agent key>-<段名>`）。
 *
 * **为什么不像以前那样整段一个 section**：底座按 key 做最小 patch
 * （`planSystemEntries` → `planSections`），整段一个 key 等于「一个字变了整段作废」。
 * 记忆目录、技能索引、组织里的人员都会变，于是每轮都重发整段提示词，前缀缓存（ADR-005 /
 * C-003）等于不存在。切成稳定段之后，只有真正变了的那段写新条目。
 *
 * `tag: false`：tag 会包一层 `<key>…</key>`，那就改了发给模型的字节 —— 分段只靠 key。
 *
 * **async 的理由**：段名来自模板目录（文件），读目录是异步的。装配层在 `installIdentity`
 * 里 await 一次，之后就只是「每轮重读」——改模板下一条生效，不需要重启。
 */
export async function agentSections(
	registry: Registry,
	paths: AgentPaths,
	slug: string,
): Promise<readonly PromptSection<ToolRegistration>[]> {
	const base = sectionKeyOf(slug);
	const templates = await systemTemplates(paths.workspace);
	return templates.map((template) => ({
		key: `${base}-${template.segment}`,
		tag: false,
		async render(): Promise<string> {
			return segmentText(registry, paths, slug, await readIdentity(paths.agents, slug), template.segment, templates);
		},
	}));
}
