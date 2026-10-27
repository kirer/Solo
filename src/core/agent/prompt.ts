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
import { personalId } from "../channel/state.ts";

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
	/**
	 * 项目记忆目录（`projects/<slug>/memory.md` 的小节标题）。
	 *
	 * 只给目录，条文靠 `read_project_memory` 读。项目换人时，接手的人看目录就知道
	 * 有哪些坑，再决定读哪几条 —— 这比把整本翻一遍便宜得多。
	 */
	readonly projectMemoryDigest?: string;
	/**
	 * 你会的技能。只列名字 + 一句描述，正文按需用 `read_skill` 读。
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
	 * 记忆目录（每小节一行摘要）。正文不在提示词里，要用的那条自己 `recall`。
	 *
	 * 为什么不给全文：记忆只增不减，全塞进去等于每轮都为全部历史付费；而且太长之后
	 * 模型对中段的注意力反而最差。
	 */
	readonly memoryDigest?: string;
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

	// 拍板链。
	//
	// 写成一整段规则而不是「你的上级是谁」的重复，是因为它是这套制度里最容易漏的一环：
	// 每个人都以为自己拍不了板就该直接找老板，于是老板成了唯一的决策者，中间那些
	// 招来的人形同虚设。所以这里把每一级的职责写清楚：能拍就拍，拍不了才往上。
	if (self.slug !== OWNER_SLUG) {
		const escalateTo =
			manager === undefined
				? `${input.ownerName ?? "老板"}（\`${OWNER_SLUG}\`）`
				: manager === OWNER_SLUG
					? `${input.ownerName ?? "老板"}（\`${OWNER_SLUG}\`）`
					: `${labelOf(all, manager)}（\`${manager}\`）`;
		const up: string[] = [];
		if (manager !== undefined && manager !== OWNER_SLUG) {
			const grand = chain[2];
			up.push(`你的上级（${labelOf(all, manager)}）也拍不了，就是${grand === undefined ? "老板" : labelOf(all, grand)}`);
		}
		lines.push(
			`- 拍不了板怎么办：先自己拍 —— 归你职责范围的事，你定，不用问人。` +
				`确实超出你的职责（涉及别人的活、要改别人的东西、要对外承诺），就问${escalateTo}。` +
				`${up.length === 0 ? "" : `${up.join("、")}。`}` +
				"**不要跳级**：越过你的上级直接找老板，等于告诉老板你上面的人没用。",
		);
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

	// 频道分工。
	//
	// 不写清楚的话，agent 会把所有东西都发到公司频道（那里人多，看起来「大家都该知道」），
	// 于是公司频道被日常琐事淹没，真正需要别人看见的事反而没人看。
	//
	// 但「回话」不是「写日志」：谁在哪儿问你，就在哪儿答。第一版把这两件事写成一件事，
	// 结果 agent 在项目频道被 @ 之后把答案发到自己的个人频道 —— 问的人在项目频道里
	// 只看到沉默（`core:live` 12 项里 9 项因此超时，实测抓到）。
	lines.push(
		`- 在哪儿说话：` +
			`**别人在哪个频道问你，就在那个频道回话**（默认不填 channel 就回到最近叫你的那个频道）。` +
			`自己发起的事、过程、念头，写在个人频道（\`${personalId(self.slug)}\`）—— 那是你和老板的私聊，落在这里不干扰别人。` +
			`需要别人做事的，去对应的项目频道或公司频道，@ 具体的人。`,
	);

	lines.push("");
	lines.push(`当前全公司有 ${all.length} 个 agent：${all.map((item) => item.name ?? item.slug).join("、")}，加上老板。`);
	return lines.join("\n");
}

/**
 * 「你的技能」一节。
 *
 * 只写「名字 — 什么时候该用」，不写正文。要用的时候 agent 自己 `read_skill`。
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
		"要用哪一门，就 \`read_skill\` 读它 —— 正文不在上下文里，读了才知道细节。",
		"缺什么手艺就 \`write_skill\` 自己写一份；\`scope=company\` 写进公司层，所有人都立刻看得见。",
		"外面的技能市场有现成的：\`find_skill\` 能搜、能装。装完别直接用，按我们的话重写一遍。",
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
		return "（工具没装上 —— 这是装配故障，不是你的问题。请向老板报告。）";
	}
	const lines = capabilities.map((item) => `- \`${item.name}\` — ${item.summary}`);
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
		const memory = input.projectMemoryDigest;
		const memoryLine =
			memory === undefined
				? "\n\n这个项目还没有记忆。你踩到的坑记得用 `remember_project` 写下来。"
				: `\n\n项目记忆（目录，正文用 \`read_project_memory\` 读）：\n${memory}`;
		parts.push(section(`你的项目：${input.self.project ?? ""}`, `${input.projectBrief}${memberLine}${memoryLine}`));
	}

	parts.push(section("你能做的事", capabilitySection(input.capabilities)));

	if (input.memoryDigest !== undefined && input.memoryDigest.trim() !== "") {
		parts.push(section("你的记忆", `${input.memoryDigest}\n\n要用哪条就 \`recall\` 读全文。新经验用 \`remember\` 记下。`));
	}

	if ((input.skills ?? []).length > 0) {
		parts.push(section("你的技能", skillSection(input.skills ?? [])));
	}

	parts.push(
		section(
			"你的目录",
			[
				`你的全部身份都在 \`agents/${input.self.slug}/\` 里，只有你能改它：`,
				"",
				"- `identity.md` — 你是谁（名字、岗位、上级、所在项目）。改它等于改你自己，下一句话就生效。",
				"- `memory.md` — 你的长期记忆。`remember` 写、`recall` 读。",
				"- `skills/<名字>/SKILL.md` — 你的手艺。`write_skill` 写、`read_skill` 读。",
				"",
				"你的能力（能调用哪些工具）不在这几个文件里：它由代码注册，人人一样多。",
				"要「多会一件事」，写技能，不要指望加一行配置。",
				"",
				"改动不需要重启，也不需要谁批准。改坏了就改回来。",
			].join("\n"),
		),
	);

	return `${parts.join("\n\n")}\n`;
}
