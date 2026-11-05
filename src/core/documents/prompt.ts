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
import { assistantsOf, nameOf, readAllIdentities, readIdentity, type Identity } from "./member/identity.ts";
import { listSkills } from "./skills.ts";
import { readMemory } from "./member/memory.ts";
import { memoryDigest } from "./base/memory.ts";
import { loadRules } from "./rules.ts";
import { readTeam } from "./team/doc.ts";
import { teamMemoryDigest, readTeamMemory } from "./team/memory.ts";
import { redact } from "../secrets.ts";
import { createFsx } from "../fsx.ts";
import { agentDirLabel, type Layout } from "../layout.ts";
import { loadTemplates, PROMPT_DIR, type PromptTemplate } from "./base/template.ts";
import { byName } from "../runtime/io.ts";
import { hasSlot, renderSlots, slotsIn, type Slots, type SlotValue } from "./base/slots.ts";
import { fill, type TextCatalog } from "./base/catalog.ts";

export type AgentPaths = {
	/** 两个根的布局：提示词、密钥在 app 根；技能、团队、规矩在用户根。 */
	readonly layout: Layout;
	/**
	 * 这个人此刻在哪些会话里。
	 *
	 * 用函数而不是数组：提示词是每次渲染现读的，我建群、加人、开私聊之后下一条就生效。
	 * 不给就整段不出现（纯文件场景与旧测试）。
	 */
	readonly chats?: (slug: string) => Promise<readonly ChatRef[]>;
	/**
	 * 插件追加的提示词，一段一条，顺序 = 插件目录序。
	 *
	 * 它是**运行时读进来的**，不是磁盘上的模板文件：插件把自己的说明写在 `plugin.ts` 里，
	 * 装一次就在每个人的提示词里出现一次。空数组 = 这一段不存在（不写「插件：无」）。
	 */
	readonly extraPrompt?: readonly string[];
	/** 机械文案目录（`text/channel.md`）：兜底句与技能来源标签从这里取。 */
	readonly text?: TextCatalog;
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
 * 读团队简报（`teams/<slug>/README.md`），拆成插槽。
 *
 * YAML 头里的字段单独给（模型扫一眼就知道该不该关心这件事），正文原样给全 ——
 * 团队说明就是它的事实来源。「状态：/目录：」这些标签在模板里，这里只给值。
 */
async function teamSlots(teamsRoot: string, team: string): Promise<Record<string, SlotValue>> {
	const doc = await readTeam(teamsRoot, team);
	if (doc === undefined) return { "team.brief": undefined };
	return {
		"team.brief": doc.body,
		"team.status": doc.status,
		"team.dir": `teams/${doc.slug}/`,
	};
}

/**
 * 能力名 → 展示行。
 *
 * 直接拍注册表：注册表里有什么，就是它真能调用的全部。**不**读任何清单文件 ——
 * 清单一旦和注册表不一致，提示词就会撒谎（写着有、调了失败，或者反过来）。
 */
function registeredTools(registry: Registry, catalog?: TextCatalog): readonly CapabilityLine[] {
	const snapshot = registry.snapshot();
	const lines = new Map<string, CapabilityLine>();
	for (const { tool } of snapshot.tools()) {
		const name = (tool as { readonly name?: string }).name;
		if (name === undefined) continue;
		lines.set(name, { name, summary: summaryOf(tool, catalog) });
	}
	return [...lines.values()].sort(byName);
}

function summaryOf(tool: unknown, catalog?: TextCatalog): string {
	const description = (tool as { readonly description?: unknown }).description;
	if (typeof description === "string" && description.trim() !== "") {
		// 只取第一句：能力清单是索引，不是手册。
		const first = description.trim().split(/(?<=。)|\.\s/)[0];
		return (first ?? description).trim();
	}
	return fill(catalog, "sections.no-summary");
}

/**
 * 段落的 key。
 *
 * 底层要求 key 匹配 `^[a-z][a-z0-9_-]*$`（还保留 `instructions` 这个名字），
 * 而 slug 可以是中文（`members/林越/`），所以这里必须转义：UTF-8 字节的十六进制，
 * 前缀补一个字母。结果稳定、唯一、纯 ASCII。
 */
export function sectionKeyOf(slug: string): string {
	return `agent-${Buffer.from(slug, "utf8").toString("hex")}`;
}

const identitylessPrompt = (slug: string, catalog?: TextCatalog): string =>
	fill(catalog, "sections.identityless", { slug });

/** `名字（\`slug\`）`—— 名字给人看，slug 给工具用，两个都要。 */
function withSlug(name: string, slug: string): string {
	return `${name}（\`${slug}\`）`;
}

/** 技能一行：名字 — 什么时候用（来源）。正文不在提示词里，读了才知道细节。 */
function skillLine(
	skill: {
		readonly name: string;
		readonly description: string;
		readonly scope?: "all" | "team" | "personal";
		readonly overrides?: boolean;
	},
	catalog?: TextCatalog,
): string {
	const key =
		skill.scope === "personal"
			? skill.overrides === true
				? "sections.skill.personal-override"
				: "sections.skill.personal"
			: skill.scope === "team"
				? skill.overrides === true
					? "sections.skill.team-override"
					: "sections.skill.team"
				: "sections.skill.all";
	return `- \`${skill.name}\` — ${skill.description}${fill(catalog, key)}`;
}

/** 频道：在哪些群、和我的私聊开没开。标签与「没有时怎么说」都在模板里。 */
function chatSlots(chats: readonly ChatRef[], catalog?: TextCatalog): Record<string, SlotValue> {
	const groups = chats.filter((chat) => chat.kind === "group");
	return {
		"chats.groups": groups.length === 0 ? undefined : groups.map((chat) => `「${chat.title}」`).join("、"),
		"chats.dm": chats.some((chat) => chat.kind === "dm") ? fill(catalog, "sections.chats.dm") : undefined,
	};
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
		"self.dir": agentDirLabel(paths.layout, self.dir),
		// 两个根的绝对路径。组织文件在哪，模型只能从这里知道；相对路径（`teams/…`）
		// 在 `run` 里指的是「当前目录下的 teams/」，很容易写进应用根（实测踩过）。
		"root.user": paths.layout.userRoot,
		"root.app": paths.layout.appRoot,
	};

	// 规矩是全员层文件，读不到就当没有：不能让一次文件缺失拖垮整段提示词。
	if (need.has("rules")) slots["rules"] = await loadRules(paths.layout.userRoot);

	// `count` 出厂模板已经不用了，但旧安装的 `prompt/20-position.md` 还在（播种只补缺失文件）。
	const needsRoster = wants("count", "team", "peers", "assistant");
	const all = needsRoster ? await readAllIdentities(paths.layout.agentRoots) : [];
	if (need.has("count")) slots["count"] = all.length;
	// 「没有团队 / 没有助理」怎么说归模板（`{{… ?? …}}`），这里只给事实。
	if (need.has("assistant")) {
		// 助理是文件夹事实（ADR-058）：自己就是助理时直说，别人看到的是那个能招人的人。
		const assistants = assistantsOf(paths.layout, all);
		slots["assistant"] = assistants.includes(self.slug)
			? fill(paths.text, "sections.assistant.self")
			: assistants.map((slug) => withSlug(nameOf(all, slug), slug)).join("、") || undefined;
	}
	if (need.has("team")) slots["team"] = self.team === undefined ? undefined : `\`${self.team}\``;
	if (need.has("peers")) {
		const peers =
			self.team === undefined ? [] : all.filter((item) => item.team === self.team && item.slug !== self.slug);
		slots["peers"] =
			peers.length === 0
				? undefined
				: peers
						.map((item) =>
							fill(paths.text, "sections.peer", {
								name: item.name ?? item.slug,
								title: item.title ?? fill(paths.text, "sections.peer.title"),
							}),
						)
						.join("、");
	}
	if (need.has("chats.groups") || need.has("chats.dm")) {
		const chats = paths.chats === undefined ? undefined : await paths.chats(slug);
		Object.assign(slots, chats === undefined ? {} : chatSlots(chats, paths.text));
	}
	// 模板里唯一允许出现工具名的地方：`{{tool:say}}`。名字从注册表现拍 —— 工具改了名，
	// 提示词自动跟着变，不会教错。注册表里没有这个名字就留空（渲染成「（未设置）」并 warn）。
	const tools =
		wants("tools") || [...need].some((name) => name.startsWith("tool:")) ? registeredTools(registry, paths.text) : [];
	if (need.has("tools")) {
		slots["tools"] =
			tools.length === 0 ? undefined : tools.map((tool) => `- \`${tool.name}\` — ${tool.summary}`).join("\n");
	}
	for (const name of need) {
		if (!name.startsWith("tool:")) continue;
		const tool = name.slice("tool:".length);
		slots[name] = tools.some((item) => item.name === tool) ? tool : undefined;
	}
	if (need.has("memory")) {
		// 记忆跟着**身份目录**走：助理在 app 根，成员在用户根。目录已经在 `self` 上了。
		const memory = await readMemory(self.dir);
		slots["memory"] = memory === undefined ? undefined : memoryDigest(memory, paths.text);
	}
	if (need.has("skills")) {
		const skills = await promptSkills(paths, slug, self.team);
		slots["skills"] =
			skills.length === 0 ? undefined : skills.map((skill) => skillLine(skill, paths.text)).join("\n");
	}

	const team = self.team;
	if (wants("team.brief", "team.memory", "team.status", "team.dir")) {
		Object.assign(slots, team === undefined ? {} : await teamSlots(paths.layout.teamsRoot, team));
		const teamMemory = team === undefined ? undefined : await readTeamMemory(paths.layout.teamsRoot, team);
		// 新团队还没有记忆：模板的默认句会说这句真话（`{{team.memory ?? …}}`）。
		slots["team.memory"] = teamMemory === undefined ? undefined : teamMemoryDigest(teamMemory, paths.text);
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
	if (self === undefined) return segment === "who" ? identitylessPrompt(slug, paths.text) : "";
	const template = templates.find((item) => item.segment === segment);
	if (template === undefined) return "";
	const slots = await slotsFor(registry, paths, slug, self, template);
	// `skip-empty`：这个事实现在没有 → 整段消失（不写「规矩：（未设置）」，那会被当成许可）。
	if (template.skipEmpty !== undefined && !hasSlot(slots, template.skipEmpty)) return "";
	const rendered = renderSlots(template.body, slots);
	for (const issue of rendered.issues) {
		console.warn(
			`[core] 提示词插槽没填上：${slug} 的 ${segment} 段 {{${issue.slot}}}（${issue.reason}）`,
		);
	}
	// 唯一出口：身份、记忆、技能、团队简报都会进这里，密钥在这里统一换掉。
	// 写入侧（`file` / `remember` / hire）也脱敏，但那是「尽量别写进去」；这一道才是
	// 保证「已经写进去的也发不出去」的那一道（ADR-034）。
	return redact(rendered.text.trim(), paths.layout.appRoot);
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

/** 技能清单（提示词只要名字 + 一句描述）。团队层技能也在这里 —— 团队会什么他必须知道。 */
async function promptSkills(paths: AgentPaths, slug: string, team: string | undefined) {
	const skills = await listSkills({ workspace: paths.layout.userRoot, agents: paths.layout.agentRoots, teams: paths.layout.teamsRoot }, slug, team);
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
async function renderAgentSegments(registry: Registry, paths: AgentPaths, slug: string) {
	const self = await readIdentity(paths.layout.agentRoots, slug);
	const templates = await systemTemplates(paths.layout.appRoot);
	const segments: { readonly segment: string; readonly text: string }[] = [];
	if (self === undefined) {
		return [{ segment: "who", text: identitylessPrompt(slug, paths.text) }];
	}
	for (const template of templates) {
		segments.push({ segment: template.segment, text: await segmentText(registry, paths, slug, self, template.segment, templates) });
	}
	// 插件段永远在最后：它加的是「这个组织额外会什么」，不是身份的一部分。
	const pluginText = (paths.extraPrompt ?? []).map((text) => text.trim()).filter((text) => text !== "").join("\n\n");
	if (pluginText !== "") segments.push({ segment: "plugins", text: pluginText });
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
	const templates = await systemTemplates(paths.layout.appRoot);
	const sections: PromptSection<ToolRegistration>[] = templates.map((template) => ({
		key: `${base}-${template.segment}`,
		tag: false,
		async render(): Promise<string> {
			return segmentText(registry, paths, slug, await readIdentity(paths.layout.agentRoots, slug), template.segment, templates);
		},
	}));
	// 插件段：`renderAgentSegments` 里有它，这里就必须有，否则 `promptOf` 和真人读到的
	// 提示词不是同一份（自测会满意、模型没看见）。
	const extra = (paths.extraPrompt ?? []).filter((text) => text.trim() !== "");
	if (extra.length > 0) {
		sections.push({
			key: `${base}-plugins`,
			tag: false,
			async render(): Promise<string> {
				return redact(extra.map((text) => text.trim()).join("\n\n"), paths.layout.appRoot);
			},
		});
	}
	return sections;
}
