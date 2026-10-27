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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	BACKGROUND_CONTEXT,
	type Context,
	type Conversation,
	type Extension,
	type Harness,
	type PromptSection,
	type Registry,
	type ToolRegistration,
} from "../runtime/index.ts";
import { readAllIdentities, readIdentity } from "./identity.ts";
import { renderAgentPrompt, type CapabilityLine } from "./prompt.ts";

/** 能力清单文件名。一行一项，`#` 开头是注释。 */
export const CAPABILITIES_FILE = "capabilities";

/** 项目简报文件名（项目根目录下）。 */
export const PROJECT_BRIEF_FILE = "README.md";

/** 读 agent 的能力清单。文件不存在 = 没有任何能力。 */
export async function readCapabilities(root: string, slug: string): Promise<readonly string[]> {
	try {
		const source = await readFile(join(root, slug, CAPABILITIES_FILE), "utf8");
		return source
			.split("\n")
			.map((line) => line.replace(/#.*$/, "").trim())
			.filter((line) => line !== "");
	} catch {
		return [];
	}
}

/** 读项目简报（`projects/<slug>/README.md`）。 */
export async function readProjectBrief(projectsRoot: string, project: string): Promise<string | undefined> {
	try {
		return await readFile(join(projectsRoot, project, PROJECT_BRIEF_FILE), "utf8");
	} catch {
		return undefined;
	}
}

export type AgentPaths = {
	/** `workspace/agents`。 */
	readonly agents: string;
	/** `workspace/projects`。 */
	readonly projects: string;
};

/**
 * 能力名 → 展示行。
 *
 * 只列注册表里**真的存在**的工具：`capabilities` 文件里写了一个拼错的名字，
 * 提示词里就不出现 —— 宁可让 agent 发现「我说要的能力没生效」，
 * 也不要让它以为有却调用失败。
 */
export function describeCapabilities(
	registry: Registry,
	names: readonly string[],
): readonly CapabilityLine[] {
	const snapshot = registry.snapshot();
	const byName = new Map<string, CapabilityLine>();
	for (const { tool } of snapshot.tools()) {
		const name = (tool as { readonly name?: string }).name;
		if (name === undefined) continue;
		byName.set(name, { name, summary: summaryOf(tool) });
	}
	const out: CapabilityLine[] = [];
	for (const name of names) {
		const line = byName.get(name);
		if (line !== undefined) out.push(line);
	}
	return out;
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
 * 每次渲染都重新读盘，因此改了 `identity.md` / `capabilities` 文件后，**下一条消息**
 * 就生效。这是「文档是真理」在运行时的落点，这里退化成一次文件读。
 */
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
			const self = await readIdentity(paths.agents, slug);
			if (self === undefined) {
				return `# 你还没有身份文件\n\n请先在 \`agents/${slug}/identity.md\` 写下你是谁。在那之前，你只知道自己在跟老板对话。\n`;
			}
			const all = await readAllIdentities(paths.agents);
			const names = await readCapabilities(paths.agents, slug);
			const brief =
				self.project === undefined ? undefined : await readProjectBrief(paths.projects, self.project);
			const members =
				self.project === undefined
					? undefined
					: all.filter((item) => item.project === self.project).map((item) => item.slug);
			return renderAgentPrompt({
				self,
				all,
				capabilities: describeCapabilities(registry, names),
				...(brief === undefined ? {} : { projectBrief: brief }),
				...(members === undefined ? {} : { projectMembers: members }),
			});
		},
	};
}

/**
 * 保证某个 slug 有会话，并把它的能力扩展选上。
 *
 * 会话 id 与 slug 的关系：会话 id 由底层分配（数字），slug 才是稳定标识。
 * 所以这里返回会话句柄，调用方自己记住 slug ↔ id 的映射（新核心把它写在
 * `agents/<slug>/identity.md` 的 `conversation` 字段里，见后）。
 */
export async function ensureAgentConversation(
	harness: Harness,
	options: {
		/** 要选上的扩展（身份段落所在的扩展名）。 */
		readonly extension: Extension<ToolRegistration>;
		/** 会话工作目录。 */
		readonly cwd?: string;
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<Conversation> {
	return harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: {
				extensions: [options.extension],
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			},
		},
		context,
	);
}
