/**
 * 渲染提示词用的**样例插槽表**。
 *
 * 它不属于运行时，只服务于两件事：`npm run prompt:check`（黄金渲染）与测试
 * （`test/` 里可以直接 import 这一份，不用自己再编一套人名）。
 *
 * 两条纪律：
 * - **不出现真实人名**：模板里一旦混进「知言」，换个人就全错；样例表同理，
 *   用「示例」占位，谁都能一眼看出这是假的。
 * - **覆盖全部插槽**：漏一个，黄金渲染就会报 unknown —— 那正是它要抓的东西。
 */

/**
 * 契约 §4 的 12 个插槽 + 6 个必需的复合值（`self.body` / `team.*` / `reply.*`）。
 * 键就是模板里写的那个名字；值一律是字符串，方便测试直接当 values 用。
 */
export const SAMPLE_SLOTS = {
	"self.name": "示例",
	"self.title": "示例身份",
	"self.slug": "demo",
	"self.body": "你负责把示例这件事做完。不做示例之外的事。",

	rules: "- 只在叫你的那个频道回话。\n- 没有新东西就不说。\n- 要拍板的事找上级，别自己定。",

	manager: "示例上级（`boss`）",
	reports: "示例下属（`member`）",
	chain: "示例 → 示例上级 → 我",
	team: "`demo-team`",
	peers: "示例同僚（成员）",
	chats: "「示例项目群」",
	count: "3",

	"team.brief": "这个团队负责把示例做出来。验收标准：示例能跑。",
	"team.members": "`boss`、`member`",
	"team.memory": "- 示例：踩过一次示例的坑，别再踩",

	tools: "- `say` — 在当前频道说一句\n- `chats` — 看有哪些频道\n- `file` — 读写文件\n- `run` — 跑命令",

	memory: "- 示例：第一次上手，先看规矩",
	skills: "- `工作规矩` — 什么时候用：不确定怎么说话时（全员通用）",

	pending: "2",
	candidates: "- #3 [decision] 示例上级：定了，验收标准是能跑通。\n- #4 [chat] 示例同僚：收到。",

	"tool:say": "say",
	"tool:chats": "chats",
	"tool:skills": "skills",
	"tool:remember": "remember",
	"tool:read_history": "read_history",

	"reply.alone": "（这一轮只有你被叫醒：必须回，回的就是结果。）",
	"reply.colleagues": "（成员的事就在这个频道说：要问示例同僚就 @ 他。）",

	// delivery 片段里的条件事实（81–87）。
	others: "示例同僚",
	colleagues: "示例同僚",
	total: "2",
	rows: "- 示例项目群：2 条 — 示例内容",
	merged: "2",
	task: "示例团队频道",
} as const;

export type SampleSlotName = keyof typeof SAMPLE_SLOTS;
