/**
 * 把一个 agent 的文件夹渲染成它的系统提示词。
 *
 * 这里是整个新核心的**唯一**提示词来源。没有任何岗位文案写在这份代码里：
 * 组织架构谁向谁汇报、你的职责、你的项目、你的能力清单，全部来自
 * `workspace/agents/<slug>/` 下的文件与目录。代码只负责**排版**。
 *
 * 两条设计约束：
 * 1. **确定性**：同样的一组文件必须渲染出逐字节相同的提示词，否则每次重启都会
 *    打穿模型侧的 prompt cache（`docs/AGENT.md` §4 的硬规则）。
 * 2. **不哄人**：宁可写「未设置」，也不替 agent 编造一个听起来合理的职责。
 */
import { OWNER_SLUG, chainUp, managerOf, reportsOf, type Identity } from "./identity.ts";

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
	/** 老板的显示名。老板不是 agent，没有文件夹。 */
	readonly ownerName?: string;
	/** 这个 agent 能调用的全部能力。缺省 = 没有能力（只说话）。 */
	readonly capabilities?: readonly CapabilityLine[];
	/** 项目简报（项目根 `README.md` 的正文），仅有项目时提供。 */
	readonly projectBrief?: string;
	/** 项目成员目录（`projects/<slug>/` 下的 agent slug）。 */
	readonly projectMembers?: readonly string[];
};

const NOT_SET = "（未设置）";

function labelOf(all: readonly Identity[], slug: string): string {
	if (slug === OWNER_SLUG) return "老板";
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
		lines.push(`- 你的上级：${NOT_SET}（这意味着没有人替你拍板，遇到需要决策的事要自己定，或交给老板）`);
	} else if (manager === OWNER_SLUG) {
		lines.push(`- 你的上级：老板（${input.ownerName ?? "老板本人"}）—— 你直接对老板负责`);
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

	if (self.project !== undefined) {
		const peers = all.filter(
			(item) => item.project === self.project && item.slug !== self.slug,
		);
		lines.push(
			peers.length === 0
				? `- 你在项目 \`${self.project}\` 里，目前只有你一个人`
				: `- 你在项目 \`${self.project}\` 里，同项目的人：${peers.map((item) => `${item.name ?? item.slug}（${item.title ?? "成员"}）`).join("、")}`,
		);
	}

	lines.push("");
	lines.push(`当前全公司有 ${all.length} 个 agent：${all.map((item) => item.name ?? item.slug).join("、")}，加上老板。`);
	return lines.join("\n");
}

/**
 * 「你能做的事」。
 *
 * `capabilities` 是**额外能力**的索引，不是「你拥有哪些工具」的真相：基础工具
 * （收发消息、组织架构、招人、改身份、记忆）人人都有，不写进这个文件也存在。
 * 早期版本把空清单渲染成「你现在没有可调用的能力」，导致 agent 明明有 12 个工具
 * 却自称「只能传话」—— 那是在提示词里撒谎，比缺信息更糟。
 */
function capabilitySection(capabilities: readonly CapabilityLine[] | undefined): string {
	const base = [
		"你随时可以：在频道说话（`say`）、提问并叫醒某人（`ask`）、读频道历史（`read_channel`）、",
		"看未读（`inbox`）、列频道（`channels`）、看自己的位置（`whoami`）、看全公司架构（`org_chart`）、",
		"招人（`hire`）、改身份（`update_identity`）、改能力清单（`set_capabilities`）、记与翻记忆（`remember` / `recall`）。",
	];
	const lines = [...base];
	if (capabilities !== undefined && capabilities.length > 0) {
		lines.push("");
		lines.push("此外，你的 `capabilities` 文件还给你列了这些额外能力：");
		for (const item of capabilities) lines.push(`- \`${item.name}\` — ${item.summary}`);
	} else {
		lines.push("");
		lines.push(
			"你的 `capabilities` 文件现在是空的 —— 这只是说没有**额外**能力，上面的基础能力你都有。",
			"想加额外能力，就往 `agents/<你>/capabilities` 里写一行（一行一个名字），下一次对话生效。",
		);
	}
	return lines.join("\n");
}

/**
 * 渲染完整提示词。
 *
 * 段落顺序固定，段落之间用空行分隔；任何一段为空时整段不出现（不留空标题）。
 */
export function renderAgentPrompt(input: RenderInput): string {
	const parts: string[] = [];

	const heading = input.self.name ?? input.self.slug;
	const title = input.self.title === undefined ? "" : `（${input.self.title}）`;
	parts.push(`# 你叫${heading}${title}`);

	if (input.self.body !== "") parts.push(input.self.body);

	parts.push(section("你在组织里的位置", orgSection(input)));

	if (input.projectBrief !== undefined && input.projectBrief.trim() !== "") {
		const members = input.projectMembers ?? [];
		const memberLine =
			members.length === 0
				? ""
				: `\n\n项目里的成员（目录名）：${members.map((slug) => `\`${slug}\``).join("、")}`;
		parts.push(section(`你的项目：${input.self.project ?? ""}`, `${input.projectBrief}${memberLine}`));
	}

	parts.push(section("你能做的事", capabilitySection(input.capabilities)));

	parts.push(
		section(
			"你的目录",
			[
				`你的全部身份都在 \`agents/${input.self.slug}/\` 里，只有你能改它：`,
				"",
				"- `identity.md` — 你是谁。改它等于改你自己，下一句话就生效。",
				"- `capabilities` — 一行一项能力的名字。加一行就多一项能力。",
				"- `memory/` — 你的长期记忆。写进去的东西下次还能读到。",
				"",
				"改动不需要重启，也不需要谁批准。改坏了就改回来 —— 你的目录有版本历史。",
			].join("\n"),
		),
	);

	return `${parts.join("\n\n")}\n`;
}
