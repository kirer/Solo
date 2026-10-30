/**
 * 把一个 agent 的文件夹渲染成它的系统提示词。
 *
 * 这里是整个新核心的**唯一**提示词来源。没有任何岗位文案写在这份代码里：
 * 组织架构谁向谁汇报、你的职责、你的团队、你的能力清单，全部来自
 * `workspace/agents/<slug>/` 下的文件与目录。代码只负责**排版**。
 *
 * 两条设计约束：
 * 1. **确定性**：同样的一组文件必须渲染出逐字节相同的提示词，否则每次重启都会
 *    打穿模型侧的 prompt cache（`docs/AGENT.md` §4 的硬规则）。
 * 2. **不哄人**：宁可写「未设置」，也不替 agent 编造一个听起来合理的职责。
 */
import { OWNER_SLUG, chainUp, managerOf, reportsOf, type Identity } from "./identity.ts";
import { renderRulesSection } from "./rules.ts";
import { redact } from "./secrets.ts";

/** 一项能力的展示信息。能力本身在注册表里，这里只管「怎么写成一行」。 */
export type CapabilityLine = {
	/** 工具名，agent 实际调用的那个字符串。 */
	readonly name: string;
	/** 一句话说明。 */
	readonly summary: string;
};

export type RenderInput = {
	/** 自己。 */
	readonly self: Identity;
	/** 全部 agent（组织架构的公共事实）。 */
	readonly all: readonly Identity[];
	/** 我的显示名。我不是 agent，没有文件夹。 */
	readonly ownerName?: string;
	/**
	 * workspace 根目录。只用来找 `.secrets.json` 做脱敏；给了才脱敏。
	 *
	 * 为什么在出口统一脱一次：`identity.md` / 技能 / 记忆全是模型自己写得动的文件，
	 * 只要有一处漏了，那把 key 就会**每一轮**都发给模型。逐处检查不可能不漏，出口只有一处。
	 */
	readonly workspaceRoot?: string;
	/**
	 * 规矩（`<workspace>/rules.md` 的正文）。空/缺省 = 整段不出现。
	 *
	 * 为什么它是一个独立入参而不是拼进 `self.body`：规矩是全公司共用的一份文件、
	 * 每轮都要看见；拼进身份就没有「改一处、所有人下一句生效」这个性质了。
	 */
	readonly rules?: string;
	/** 这个 agent 能调用的全部能力。缺省 = 没有能力（只说话）。 */
	readonly capabilities?: readonly CapabilityLine[];
	/** 团队简报（团队根 `README.md` 的正文），仅有团队时提供。 */
	readonly teamBrief?: string;
	/** 团队成员目录（`teams/<slug>/` 下的 agent slug）。 */
	readonly teamMembers?: readonly string[];
	/**
	 * 他在哪些会话里（`chatKind` 已推好）。
	 *
	 * 只写「哪些群 + 和我的私聊开没开」，不给就是旧形状（整段不出现）。
	 * 以前这里写的是「你的个人频道」—— 那个概念已经不存在了：私聊是会话的一种形态，
	 * 不是每个人的固定财产。
	 */
	readonly chats?: readonly {
		readonly id: string;
		readonly title: string;
		readonly kind: "dm" | "group";
	}[];
	/**
	 * 团队记忆目录（`teams/<slug>/memory.md` 的小节标题）。
	 *
	 * 只给目录，条文靠 `read_history(scope=team)` 读。团队换人时，接手的人看目录就知道
	 * 有哪些坑，再决定读哪几条 —— 这比把整本翻一遍便宜得多。
	 */
	readonly teamMemoryDigest?: string;
	/**
	 * 你会的技能。只列名字 + 一句描述，正文按需用 `skills(action=read)` 读。
	 *
	 * 为什么不把正文塞进来：一个 agent 攒 20 门手艺，正文全进提示词就是几万 token，
	 * 而且大部分跟当前这件事无关。常驻的应该只是「我会什么」，不是「怎么做的全文」。
	 */
	readonly skills?: readonly {
		readonly name: string;
		readonly description: string;
		/** `company` = 公司教的；`personal` = 自己写的。 */
		readonly scope?: "company" | "personal";
		/** 个人层覆盖了公司同名技能。 */
		readonly overrides?: boolean;
	}[];
	/**
	 * 记忆目录（每小节一行摘要）。正文不在提示词里，要用的那条自己 `read_history(scope=memory)`。
	 *
	 * 为什么不给全文：记忆只增不减，全塞进去等于每轮都为全部历史付费；而且太长之后
	 * 模型对中段的注意力反而最差。
	 */
	readonly memoryDigest?: string;
};

const NOT_SET = "（未设置）";

function labelOf(all: readonly Identity[], slug: string): string {
	if (slug === OWNER_SLUG) return "我";
	return all.find((identity) => identity.slug === slug)?.name ?? slug;
}

function section(title: string, body: string): string {
	return `## ${title}\n\n${body.trim()}`;
}

/**
 * 组织架构一节。
 *
 * 汇报关系不是规则，是**事实陈述**：写「你的上级是 X」「X 的下属是 Y」，
 * 而不是「你必须向 X 汇报」。约束来自事实的缺席 —— 提示词里没有的人，
 * 他也没有频道可以找到。
 */
function orgSection(input: RenderInput): string {
	const { self, all } = input;
	const lines: string[] = [];

	const manager = managerOf(all, self.slug);
	if (manager === undefined) {
		lines.push(`- 你的上级：${NOT_SET}（这意味着没有人替你拍板，遇到需要决策的事要自己定，或交给我）`);
	} else if (manager === OWNER_SLUG) {
		const me = input.ownerName ?? "我";
		lines.push(`- 你的上级：${me}（用户本人）—— 你直接对${me}负责`);
	} else {
		lines.push(`- 你的上级：${labelOf(all, manager)}（\`${manager}\`）`);
	}

	const reports = reportsOf(all, self.slug);
	if (reports.length > 0) {
		lines.push(`- 向你汇报的人：${reports.map((item) => `${item.name ?? item.slug}（\`${item.slug}\`）`).join("、")}`);
	} else {
		lines.push("- 向你汇报的人：（目前没有）");
	}

	const chain = chainUp(all, self.slug);
	if (chain.length > 1) {
		lines.push(`- 往上的整条汇报线：${chain.map((slug) => labelOf(all, slug)).join(" → ")}`);
	}

	// 称呼是**事实**，和上级是谁一样属于「本来就在那儿」的东西，不是规矩。
	// 写在组织这一段而不是 rules.md：rules.md 是可删可改的工作约定，称呼不该跟着丢。
	lines.push(`- 对用户的称呼：你。正文里直接写「你」，要提到他时写 \`@我\` —— 不要写 \`@owner\`。`);

	if (self.team !== undefined) {
		const peers = all.filter(
			(item) => item.team === self.team && item.slug !== self.slug,
		);
		lines.push(
			peers.length === 0
				? `- 你在团队 \`${self.team}\` 里，目前只有你一个人`
				: `- 你在团队 \`${self.team}\` 里，同团队的人：${peers.map((item) => `${item.name ?? item.slug}（${item.title ?? "成员"}）`).join("、")}`,
		);
	}

	lines.push("");
	// 位置：只在哪些会话里 —— 不说「你有一个个人频道」（那是个已经不存在的概念）。
	if (input.chats !== undefined) {
		const groups = input.chats.filter((chat) => chat.kind === "group");
		const dm = input.chats.find((chat) => chat.kind === "dm");
		lines.push(
			groups.length === 0
				? "- 你不在任何群里：没人能在那儿 @ 你"
				: `- 你在这些群里：${groups.map((chat) => `「${chat.title}」`).join("、")}`,
		);
		lines.push(
			dm === undefined
				? "- 和我的私聊：没开（要找我就在群里 @我；私聊只能我开）"
				: "- 和我的私聊：已开（只有你和我两个人，别人看不到）",
		);
	}
	lines.push("");
	lines.push(`当前全公司有 ${all.length} 个 agent：${all.map((item) => item.name ?? item.slug).join("、")}，加上我。`);
	return lines.join("\n");
}

/**
 * 「你的技能」一节。
 *
 * 只写「名字 — 什么时候该用」，不写正文。要用的时候 agent 自己 `skills(action=read)`。
 * 空目录时整节不出现（不写「你还没有技能」，那只是噪音）。
 */
function skillSection(
	skills: readonly {
		readonly name: string;
		readonly description: string;
		readonly scope?: "company" | "personal";
		readonly overrides?: boolean;
	}[],
): string {
	const lines = skills.map((skill) => {
		// 标出来源不是为了好看：agent 要知道「这条规矩是公司定的」还是「我自己写的」，
		// 前者它不该随手改，后者随时可以推翻重来。
		const source =
			skill.scope === "personal"
				? skill.overrides === true
					? "（你自己改过的版本，覆盖了公司的同名技能）"
					: "（你自己写的）"
				: "（公司通用）";
		return `- \`${skill.name}\` — ${skill.description}${source}`;
	});
	lines.push("");
	lines.push(
		"要用哪一门，就 \`skills(action=read)\` 读它 —— 正文不在上下文里，读了才知道细节。",
		"缺什么手艺就 \`skills(action=write)\` 自己写一份；\`scope=company\` 写进公司层，所有人都立刻看得见。",
		"外面的技能市场有现成的：\`run\` 跑 \`npx skills find\` / \`npx skills add\` 能搜、能装。装完别直接用，按我们的话重写一遍。",
	);
	return lines.join("\n");
}

/**
 * 「你能调用的工具」。
 *
 * 这一段**从注册表实拍**，不手写。理由：手写的清单一定会漂 —— 加了工具忘了改文案，
 * agent 就不知道自己有那个能力（早期版本把空清单渲染成「你现在没有可调用的能力」，
 * 结果它明明有 12 个工具却自称「只能传话」，那是在提示词里撒谎，比缺信息更糟）。
 *
 * 注册表是真相：它里面有什么，就写什么；删了工具，这段话自动跟着少一行。
 */
function capabilitySection(capabilities: readonly CapabilityLine[] | undefined): string {
	if (capabilities === undefined || capabilities.length === 0) {
		return "（工具没装上 —— 这是装配故障，不是你的问题。请向我报告。）";
	}
	const lines = capabilities.map((item) => `- \`${item.name}\` — ${item.summary}`);
	// 压缩是 pi-durable 的默认行为，模型看不见被压掉的部分，更不知道「我不知道」。
	// 不写这一句，它会用编出来的路径和数字把话说圆 —— 那比说「我忘了」糟得多。
	lines.push("", "上下文被压缩过。精确的路径、数字、原话不许凭记忆补——用 `read_history` 查。");
	return lines.join("\n");
}

/**
 * 提示词的**稳定分段**。顺序就是渲染顺序，`renderAgentPrompt` 就是把它们的正文按序
 * 用空行连起来。
 *
 * 为什么要分段：底座的 system 提示词是按 section **名字**做最小 patch 的
 * （`planSystemEntries` → `planSections`），只改变化的那几段。整段一个 section 意味着
 * 「任何一个字变了整段作废」——记忆目录、技能索引、组织里的人员都是会变的，于是前缀缓存
 * （ADR-005 / C-003）每轮都被打穿。切成 8 段之后，只有真正变了的那段失效。
 *
 * 为什么 `tag` 全是 `false`：tag 会在正文外面包一层 `<key>…</key>`，那就改了发给模型的
 * 字节。分段**只靠 key**，不靠标签。
 */
export const PROMPT_SEGMENTS = [
	"who",
	"rules",
	"position",
	"team",
	"tools",
	"memory",
	"skills",
	"directory",
] as const;

export type PromptSegment = (typeof PROMPT_SEGMENTS)[number];

/** 一段的正文（已脱敏；空串 = 这一段不出现）。 */
export type PromptSegmentText = { readonly segment: PromptSegment; readonly text: string };

/** 按段归位。空段保留空数组，渲染时变成空串（整段不出现，不留空标题）。 */
function segmentParts(input: RenderInput): Readonly<Record<PromptSegment, readonly string[]>> {
	const self = input.self;
	const who: string[] = [];
	const heading = self.name ?? self.slug;
	const title = self.title === undefined ? "" : `（${self.title}）`;
	who.push(`# 你叫${heading}${title}`);
	// 「我」是谁只有这一处定义：全文（含 agents 自己的 identity.md 与技能）都用「我」指用户。
	who.push("本提示词里的『我』指用户本人；你称呼对方时用『你』。");
	if (self.body !== "") who.push(self.body);

	// 规矩紧跟在「你是谁」后面、能力清单之前：它决定**怎么用**下面那些能力，
	// 排在能力后面就变成脚注了。空则整段消失（不写「（没有规矩）」）。
	const rules = renderRulesSection(input.rules);

	const team: string[] = [];
	if (input.teamBrief !== undefined && input.teamBrief.trim() !== "") {
		const members = input.teamMembers ?? [];
		const memberLine =
			members.length === 0
				? ""
				: `\n\n团队里的成员（目录名）：${members.map((slug) => `\`${slug}\``).join("、")}`;
		const memory = input.teamMemoryDigest;
		const memoryLine =
			memory === undefined
				? "\n\n这个团队还没有记忆。你踩到的坑记得用 `remember(scope=team)` 写下来。"
				: `\n\n团队记忆（目录，正文用 \`read_history(scope=team)\` 读）：\n${memory}`;
		team.push(section(`你的团队：${self.team ?? ""}`, `${input.teamBrief}${memberLine}${memoryLine}`));
	}

	const memory: string[] = [];
	if (input.memoryDigest !== undefined && input.memoryDigest.trim() !== "") {
		memory.push(section("你的记忆", `${input.memoryDigest}\n\n要用哪条就 \`read_history(scope=memory)\` 读全文。新经验用 \`remember\` 记下。`));
	}

	const skills: string[] = [];
	if ((input.skills ?? []).length > 0) {
		skills.push(section("你的技能", skillSection(input.skills ?? [])));
	}

	return {
		who,
		rules: rules === undefined ? [] : [rules],
		position: [section("你在组织里的位置", orgSection(input))],
		team,
		tools: [section("你能做的事", capabilitySection(input.capabilities))],
		memory,
		skills,
		directory: [
			section(
				"你的目录",
				[
					`你的全部身份都在 \`agents/${self.slug}/\` 里，只有你能改它：`,
					"",
					"- `identity.md` — 你是谁（名字、岗位、上级、所在团队）。改它等于改你自己，下一句话就生效。",
					"- `memory.md` — 你的长期记忆。`remember` 写、`read_history(scope=memory)` 读。",
					"- `skills/<名字>/SKILL.md` — 你的手艺。`skills(action=write)` 写、`skills(action=read)` 读。",
					"",
					"你的能力（能调用哪些工具）不在这几个文件里：它由代码注册，人人一样多。",
					"要「多会一件事」，写技能，不要指望加一行配置。",
					"",
					"改动不需要重启，也不需要谁批准。改坏了就改回来。",
				].join("\n"),
			),
		],
	};
}

/**
 * 渲染一段（不渲染整段）。`text` 与 `renderAgentPromptSegments` 里的同名段一致。
 *
 * 脱敏按段做：密钥是单行值，不会跨段，所以逐段脱敏与整段脱敏等价。
 * 结尾换行只挂在「你的目录」上：它是最后一段且永远非空（有身份文件时），
 * 所以整段拼回去时换行仍然落在最后。
 */
export function renderPromptSegment(segment: PromptSegment, input: RenderInput): string {
	const text = redact(segmentParts(input)[segment].join("\n\n"), input.workspaceRoot);
	return segment === "directory" && text !== "" ? `${text}\n` : text;
}

/**
 * 按段渲染。
 *
 * 不变量：`renderAgentPromptSegments(input).map(s => s.text).filter(t => t !== "").join("\n\n")`
 * 与 `renderAgentPrompt(input)` **逐字节相等**。改了这里就要跑黄金测试。
 */
export function renderAgentPromptSegments(input: RenderInput): readonly PromptSegmentText[] {
	return PROMPT_SEGMENTS.map((segment) => ({ segment, text: renderPromptSegment(segment, input) }));
}

/**
 * 渲染完整提示词。
 *
 * 段落顺序固定，段落之间用空行分隔；任何一段为空时整段不出现（不留空标题）。
 */
export function renderAgentPrompt(input: RenderInput): string {
	return renderAgentPromptSegments(input)
		.map((segment) => segment.text)
		.filter((text) => text !== "")
		.join("\n\n");
}
