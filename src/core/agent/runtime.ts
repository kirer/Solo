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
import { readAllIdentities, readIdentity } from "./identity.ts";
import { listSkills } from "./skills.ts";
import { memoryDigest, readMemory } from "./memory.ts";
import { loadRules } from "./rules.ts";
import { readTeam } from "../team/doc.ts";
import { teamMemoryDigest, readTeamMemory } from "../team/memory.ts";
import { renderAgentPrompt, type CapabilityLine } from "./prompt.ts";

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

/**
 * 生成一个 agent 的提示词段落。
 *
 * 每次渲染都重新读盘，因此改了 `identity.md` / 记忆 / 技能后，**下一条消息**
 * 就生效。这是「文档是真理」在运行时的落点，这里退化成一次文件读。
 */
/**
 * 渲染某人**此刻**的提示词正文。
 *
 * 单独导出的理由：自测要断言「规矩真的进了提示词」，而去问模型不可靠（它会背课文）。
 * 拿同一份 `render` 的结果来断言，验的就是模型真会读到的那段字。
 */
export async function renderAgentSection(
	registry: Registry,
	paths: AgentPaths,
	slug: string,
): Promise<string> {
	const self = await readIdentity(paths.agents, slug);
	if (self === undefined) {
		return `# 你还没有身份文件\n\n请先在 \`agents/${slug}/identity.md\` 写下你是谁。在那之前，你只知道自己在跟我对话。\n`;
	}
	const all = await readAllIdentities(paths.agents);
	const brief = self.team === undefined ? undefined : await readTeamBrief(paths.teams, self.team);
	const members =
		self.team === undefined
			? undefined
			: all.filter((item) => item.team === self.team).map((item) => item.slug);
	const teamMemory = self.team === undefined ? undefined : await readTeamMemory(paths.teams, self.team);
	const teamDigest = teamMemory === undefined ? undefined : teamMemoryDigest(teamMemory);
	const skills = await listSkills({ workspace: paths.workspace, agents: paths.agents }, slug);
	const memory = await readMemory(join(paths.agents, slug));
	const digest = memory === undefined ? undefined : memoryDigest(memory);
	// 规矩是公司层文件（`<workspace>/rules.md`），每人每轮都读一次：读不到就当没有，
	// 不能让一次文件缺失拖垮整段提示词（那时它连自己叫什么都不会知道）。
	const rules = await loadRules(paths.workspace);
	const chats = paths.chats === undefined ? undefined : await paths.chats(slug);
	return renderAgentPrompt({
		self,
		all,
		// 脱敏要在拼完的整段上做：key 可能来自身份、技能、记忆里任何一处。
		workspaceRoot: paths.workspace,
		capabilities: registeredTools(registry),
		skills: skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			scope: skill.scope,
			...(skill.overrides === true ? { overrides: true } : {}),
		})),
		...(digest === undefined ? {} : { memoryDigest: digest }),
		...(rules === undefined ? {} : { rules }),
		...(brief === undefined ? {} : { teamBrief: brief }),
		...(members === undefined ? {} : { teamMembers: members }),
		...(teamDigest === undefined ? {} : { teamMemoryDigest: teamDigest }),
		...(chats === undefined ? {} : { chats }),
	});
}

export function agentSection(
	registry: Registry,
	paths: AgentPaths,
	slug: string,
): PromptSection<ToolRegistration> {
	return {
		key: sectionKeyOf(slug),
		// 不包 `<key>...</key>` 标签：这整段就是它的身份，不是一条附加信息。
		tag: false,
		async render(_input, _context): Promise<string | undefined> {
			return renderAgentSection(registry, paths, slug);
		},
	};
}

