/**
 * 提示词分段的**黄金测试**。
 *
 * 分段的全部意义是「缓存能命中，而模型读到的字节一个字不变」。所以这里钉死的不是
 * 「看起来差不多」，而是：
 * 1. `renderAgentPrompt` 的输出与分段前（整段一个 section）**逐字节相同**——下面的
 *    字面量是改动前用同一份 fixture 采下来的真实输出；
 * 2. 各段按序用空行拼回去，就等于整段；
 * 3. 只有内容真的变了的段，正文才会变（其余段逐字不变 → 底座的最小 patch 不写新条目）。
 */
import { describe, expect, it } from "vitest";
import {
	PROMPT_SEGMENTS,
	renderAgentPrompt,
	renderAgentPromptSegments,
	renderPromptSegment,
	type RenderInput,
} from "../../src/core/agent/prompt.ts";

const self = {
	slug: "lin",
	name: "林越",
	title: "前端",
	team: "web",
	manager: "owner",
	body: "我是林越。\n\n两段正文。",
} as unknown as RenderInput["self"];

const full: RenderInput = {
	self,
	all: [
		self,
		{ slug: "zhao", name: "赵四", title: "后端", team: "web", manager: "owner" } as unknown as RenderInput["self"],
		{ slug: "owner", name: "我" } as unknown as RenderInput["self"],
	],
	ownerName: "我",
	rules: "- 说话短。\n- 不编。",
	capabilities: [
		{ name: "say", summary: "在频道里说一句。" },
		{ name: "skills", summary: "读一门技能。" },
	],
	teamBrief: "把网页做到能看。",
	teamMembers: ["lin", "zhao"],
	chats: [
		{ id: "team:web", title: "web", kind: "group" },
		{ id: "dm:lin", title: "和我的私聊", kind: "dm" },
	],
	teamMemoryDigest: "- 部署脚本要用 node 22",
	memoryDigest: "- 上次踩过缓存坑",
	skills: [{ name: "debug", description: "从头复现问题。", scope: "personal" }],
};

/** 分段前采下来的输出。**不许改**：改了就不是「字节不变」了。 */
const GOLDEN = "# 你叫林越（前端）\n\n本提示词里的『我』指用户本人；你称呼对方时用『你』。\n\n我是林越。\n\n两段正文。\n\n## 规矩\n\n- 说话短。\n- 不编。\n\n## 你在组织里的位置\n\n- 你的上级：我（用户本人）—— 你直接对我负责\n- 向你汇报的人：（目前没有）\n- 对用户的称呼：你。正文里直接写「你」，要提到他时写 `@我` —— 不要写 `@owner`。\n- 你在团队 `web` 里，同团队的人：赵四（后端）\n\n- 你在这些群里：「web」\n- 和我的私聊：已开（只有你和我两个人，别人看不到）\n\n当前全公司有 3 个 agent：林越、赵四、我，加上我。\n\n## 你的团队：web\n\n把网页做到能看。\n\n团队里的成员（目录名）：`lin`、`zhao`\n\n团队记忆（目录，正文用 `read_history(scope=team)` 读）：\n- 部署脚本要用 node 22\n\n## 你能做的事\n\n- `say` — 在频道里说一句。\n- `skills` — 读一门技能。\n\n上下文被压缩过。精确的路径、数字、原话不许凭记忆补——用 `read_history` 查。\n\n## 你的记忆\n\n- 上次踩过缓存坑\n\n要用哪条就 `read_history(scope=memory)` 读全文。新经验用 `remember` 记下。\n\n## 你的技能\n\n- `debug` — 从头复现问题。（你自己写的）\n\n要用哪一门，就 `skills(action=read)` 读它 —— 正文不在上下文里，读了才知道细节。\n缺什么手艺就 `skills(action=write)` 自己写一份；`scope=company` 写进公司层，所有人都立刻看得见。\n外面的技能市场有现成的：`run` 跑 `npx skills find` / `npx skills add` 能搜、能装。装完别直接用，按我们的话重写一遍。\n\n## 你的目录\n\n你的全部身份都在 `agents/lin/` 里，只有你能改它：\n\n- `identity.md` — 你是谁（名字、岗位、上级、所在团队）。改它等于改你自己，下一句话就生效。\n- `memory.md` — 你的长期记忆。`remember` 写、`read_history(scope=memory)` 读。\n- `skills/<名字>/SKILL.md` — 你的手艺。`skills(action=write)` 写、`skills(action=read)` 读。\n\n你的能力（能调用哪些工具）不在这几个文件里：它由代码注册，人人一样多。\n要「多会一件事」，写技能，不要指望加一行配置。\n\n改动不需要重启，也不需要谁批准。改坏了就改回来。\n";

const joined = (input: RenderInput): string =>
	renderAgentPromptSegments(input)
		.map((segment) => segment.text)
		.filter((text) => text !== "")
		.join("\n\n");

const changedSegments = (input: RenderInput): readonly string[] => {
	const before = renderAgentPromptSegments(full);
	const after = renderAgentPromptSegments(input);
	return after.filter((segment, index) => segment.text !== before[index]?.text).map((segment) => segment.segment);
};

describe("提示词分段：字节级不变量", () => {
	it("整段渲染与改动前一个字都不差", () => {
		expect(renderAgentPrompt(full)).toBe(GOLDEN);
	});

	it("各段拼回去等于整段", () => {
		expect(joined(full)).toBe(renderAgentPrompt(full));
	});

	it("同一份输入渲染两次完全一样（确定性，否则缓存必炸）", () => {
		expect(renderAgentPromptSegments(full)).toEqual(renderAgentPromptSegments(full));
	});

	it("极简身份（没有规矩/团队/记忆/技能）也拼得回来，并且仍以换行结尾", () => {
		const bare: RenderInput = { self: { slug: "a", name: "甲", body: "" } as unknown as RenderInput["self"], all: [] };
		expect(joined(bare)).toBe(renderAgentPrompt(bare));
		expect(renderAgentPrompt(bare).endsWith("\n")).toBe(true);
	});

	it("规矩缺失时整段消失，不留空标题", () => {
		expect(renderPromptSegment("rules", full)).toBe("## 规矩\n\n- 说话短。\n- 不编。");
		expect(renderPromptSegment("rules", { ...full, rules: undefined })).toBe("");
	});
});

describe("提示词分段：只有变了的段失效", () => {
	it("改记忆只动记忆那一段", () => {
		expect(changedSegments({ ...full, memoryDigest: "- 新的一条" })).toEqual(["memory"]);
	});

	it("改规矩只动规矩那一段", () => {
		expect(changedSegments({ ...full, rules: "- 只说事实。" })).toEqual(["rules"]);
	});

	it("团队换人只动团队那一段", () => {
		expect(changedSegments({ ...full, teamMembers: ["lin"] })).toEqual(["team"]);
	});

	it("身份清单变了只动位置段（团队名单单独喂，不受它影响）", () => {
		expect(changedSegments({ ...full, all: [self] })).toEqual(["position"]);
	});

	it("段落顺序固定（顺序一变底座会整块重写）", () => {
		expect(renderAgentPromptSegments(full).map((segment) => segment.segment)).toEqual([...PROMPT_SEGMENTS]);
	});
});
