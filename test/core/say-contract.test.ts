/**
 * `say` 的落点契约。
 *
 * 守的两件事：
 *
 * 1. **回话落在叫你的那个频道**。实测回复频道 85%/82% 是对的，但有 2598 条噪音灌进了我私聊
 *    —— 因为兜底是 `mine[0]`，它可能正是「我和某人的私聊」，于是我在群里问的一句被答进私聊。
 *    现在兜底只挑**群聊**（形态由成员推，不看 id 前缀），一个群都没有才回私聊。
 * 2. **要拍板的事必须叫我**。含「请确认/要不要/等你定」的消息里大量没有 @ 我，
 *    我的回复率只有 1.06% —— 代码兜底补 `owner`，不靠模型自觉。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { SEED_TEXT } from "./catalog.ts";
import { createCoreTools, isPass } from "../../src/core/channel/tools/index.ts";
import { ChannelDoc, OWNER, dmId, teamId, type ChannelState, type Message } from "../../src/core/channel/types.ts";
import { recipientsOf } from "../../src/core/channel/mentions.ts";
import { appendMessage, ensureChannel } from "../../src/core/channel/rules.ts";
import { renderDelivery, renderReplyRules } from "../../src/core/channel/delivery.ts";
import { REPLY_TEMPLATE, SEED_DELIVERY_PROMPT } from "./seed-prompt.ts";

/**
 * 投递正文必须带真模板：`renderDelivery` 刻意**不给**默认模板（默认值等于允许「回话段为空」
 * 静默通过）。这里补 seed 里那一份，断言的是「真的贴进去了」。
 */
function renderDeliveryWithTemplates(options: Omit<Parameters<typeof renderDelivery>[0], "prompt">): string {
	return renderDelivery({ ...options, prompt: SEED_DELIVERY_PROMPT, catalog: SEED_TEXT });
}
import { emptyDirectory } from "../../src/core/agent/roster.ts";
import { wireChannel } from "../../src/core/channel/wiring.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

const ME = "沈舟";
const CONVERSATION = 7;
/** 群聊里那个不说话的成员：让团队频道有两个以上成员，从而不是私聊。 */
const BYSTANDER = "顾南雁";
const DM = dmId(OWNER, ME);
const PROJ = teamId("dino");

/**
 * 一个真实的小运行时：`say` 要落库、要投递，只有真文档代理能验「落点」。
 *
 * 频道：我和这个人的私聊（先建，所以 `channelsOf` 的第一名就是它）+ 团队通道（后来才活跃）。
 * 名册里有意留空 `wake` —— 模拟「没刚被叫醒」的兜底分支。
 */
async function setup(options: {
	/** 把「我刚叫醒我」写进名册，`seq` 指向频道里的那条消息。 */
	wake?: { channelId: string; seq: number };
	/** 团队频道里多一个成员，并留下一条同时叫醒我们俩的消息。 */
	colleague?: string;
	/** 团队频道只有「我 + 他」两个人（按 chatKind 就是私聊形态）。live 第一轮就是这个形状。 */
	solo?: boolean;
	/** 再建一个同名的频道，用来验「重名不猜」。 */
	duplicateTitle?: boolean;
} = {}): Promise<{
	say: (args: Record<string, unknown>) => Promise<string>;
	snapshot: () => Promise<ChannelState>;
}> {
	const box = await pool.make("core-say-");
	const root = box.root;
	const agentsRoot = box.agentsRoot;
	const teamsRoot = box.teamsRoot;
	await mkdir(join(agentsRoot, ME), { recursive: true });
	await writeFile(
		join(agentsRoot, ME, "identity.md"),
		"---\nname: 沈舟\ntitle: 前端开发\nmanager: owner\n---\n\n写小恐龙。\n",
		"utf8",
	);
	if (options.colleague !== undefined) {
		// 成员必须真的在名册里，`parseMentions` 才会把 `@林越` 解析成 slug。
		await mkdir(join(agentsRoot, options.colleague), { recursive: true });
		await writeFile(
			join(agentsRoot, options.colleague, "identity.md"),
			`---\nname: ${options.colleague}\ntitle: 前端开发\nmanager: owner\n---\n\n写小恐龙。\n`,
			"utf8",
		);
	}

	const runtime = await box.open();

	// 团队频道必须是**群聊**：形态按成员推 —— 我 + 一个人就是私聊，不需要第三个概念。
	const members = options.solo === true
		? [OWNER, ME]
		: options.colleague === undefined
			? [OWNER, ME, BYSTANDER]
			: [OWNER, ME, options.colleague];
	let wokeSeq: number | undefined;
	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(doc, ensureChannel(doc, { id: DM, title: ME, members: [OWNER, ME], at: 1 }));
		Object.assign(doc, ensureChannel(doc, { id: PROJ, title: "小恐龙", members, at: 2 }));
		if (options.duplicateTitle === true) {
			Object.assign(doc, ensureChannel(doc, { id: teamId("dino-2"), title: "小恐龙", members, at: 3 }));
		}
		// 团队频道里有过消息 → 它是「最近活跃的那个」。
		const first = appendMessage(doc, PROJ, { from: OWNER, text: "小恐龙做到哪了", at: 10 });
		doc.messages[PROJ] = [first.message];
		doc.nextSeq[PROJ] = first.message.seq + 1;
		if (options.colleague !== undefined) {
			// `@` 要写在正文里：`appendMessage` 的 `mentions` 是从正文解析出来的，
			// 没有 `mentions` 入参（只有 `mention` 是「额外补进去的 slug」）。
			const both = appendMessage(doc, PROJ, {
				from: OWNER,
				text: `@${ME} @${options.colleague} 你们俩都看一下`,
				at: 11,
			});
			doc.messages[PROJ] = [...doc.messages[PROJ]!, both.message];
			doc.nextSeq[PROJ] = both.message.seq + 1;
			wokeSeq = both.message.seq;
		}
	}, BACKGROUND_CONTEXT);

	const wakeSeq = options.wake?.seq ?? wokeSeq;
	const target = { channelId: options.wake?.channelId ?? PROJ, seq: wakeSeq, from: OWNER, at: 1 };
	const wake =
		options.wake !== undefined || wakeSeq !== undefined
			? {
					[String(CONVERSATION)]: target,
				}
			: {};

	const tools = createCoreTools({
		harness: runtime.harness,
		layout: box.layout,
		text: SEED_TEXT,
		directory: async () => ({
			...emptyDirectory(),
			slugToConversation: { [ME]: CONVERSATION },
			conversationToSlug: { [String(CONVERSATION)]: ME },
			wake,
		}),
		saveDirectory: async () => undefined,
		wiring: wireChannel({ harness: runtime.harness, layout: box.layout }),
	} as never);
	// 每个用例都从「新一轮」开始（真实流程里由 `fanOut()` 清）。不清的话，
	const tool = tools.find((item) => item.name === "say");
	expect(tool).toBeDefined();

	return {
		say: async (args) => {
			const result = await tool?.execute(
				args as never,
				{ conversationId: CONVERSATION } as never,
				BACKGROUND_CONTEXT,
			);
			const output = result?.output as readonly { text?: string }[] | undefined;
			return output?.[0]?.text ?? "";
		},
		snapshot: async () =>
			((await runtime.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) ?? {
				channels: {},
				messages: {},
				nextSeq: {},
				readMarks: {},
			}) as ChannelState,
	};
}

function lastOf(state: ChannelState, channelId: string): Message | undefined {
	const list = state.messages[channelId] ?? [];
	return list[list.length - 1];
}

/** 按正文找最新的一条。 */
function lastSpoken(state: ChannelState, channelId: string, text: string): Message | undefined {
	const list = state.messages[channelId] ?? [];
	return [...list].reverse().find((m) => m.text === text);
}

describe("兜底频道", () => {
	it("私聊先建也不落到私聊：优先我所在的群里最近活跃的那个", async () => {
		const { say, snapshot } = await setup();
		const before = await snapshot();
		expect(before.channels[DM]).toBeDefined();
		// 私聊是 `channelsOf` 的第一名（createdAt 最小）—— 旧逻辑 `mine[0]` 会落在这儿。

		await say({ text: "做完了，地址在 README 里" });

		const after = await snapshot();
		expect(lastOf(after, PROJ)?.text).toContain("地址在 README 里");
		expect(lastOf(after, DM)?.text ?? "").not.toContain("地址在 README 里");
	});

	it("显式给 channel 才能落在私聊里", async () => {
		const { say, snapshot } = await setup();
		await say({ text: "在私聊里说一句", channel: DM });
		const after = await snapshot();
		expect(lastSpoken(after, DM, "在私聊里说一句")?.text).toContain("在私聊里说一句");
	});
});

describe("频道名也能指定", () => {
	/**
	 * 真实事故：知言在私聊里被叫醒，想派活给团队，手上只有「QQ农场」这个名字、
	 * 没有 `team:qq-farm` 这个 id，于是省略 channel —— 40 条指挥全落在私聊里，
	 * 团队频道 88 条消息它只发过 2 条，而它以为自己发出去了。
	 */
	it("写频道名就落到那个频道（默认本来会回私聊）", async () => {
		const { say, snapshot } = await setup({ wake: { channelId: DM, seq: 1 } });

		await say({ text: "回给我的结论" });
		const afterDefault = await snapshot();
		expect(lastOf(afterDefault, DM)?.text).toContain("回给我的结论");

		const out = await say({ text: "扫码窗口开好了", channel: "小恐龙" });
		const after = await snapshot();
		expect(lastOf(after, PROJ)?.text).toContain("扫码窗口开好了");
		expect(out).toContain("已发到「小恐龙」");
	});

	it("重名不猜：列出 id 让它自己选", async () => {
		const { say, snapshot } = await setup({ duplicateTitle: true });
		const out = await say({ text: "在吗", channel: "小恐龙" });
		expect(out).toContain("有两个频道都叫「小恐龙」");
		const after = await snapshot();
		expect(lastSpoken(after, PROJ, "在吗")).toBeUndefined();
	});

	it("名字写错：把我在的频道连 id 一起给它", async () => {
		const { say } = await setup();
		const out = await say({ text: "在吗", channel: "QQ农场" });
		expect(out).toContain("没有这个频道");
		expect(out).toContain(PROJ);
	});
});

describe("投递正文带频道 id", () => {
	it("第一行写清频道 id，模型才知道精确回哪儿", () => {
		const state = ensureChannel(
			{ channels: {}, messages: {}, nextSeq: {}, readMarks: {} },
			{ id: "all", title: "全员大群", members: [OWNER, ME], at: 1 },
		);
		const { message } = appendMessage(state, "all", { from: OWNER, text: "在吗", at: 2 });
		const body = renderDeliveryWithTemplates({ channel: state.channels.all!, message, viewer: ME });
		expect(body.split("\n")[0]).toBe("【全员大群】#1（频道 all）");
	});

	it("私聊额外说一句「要指挥团队就去团队频道」", () => {
		const state = ensureChannel(
			{ channels: {}, messages: {}, nextSeq: {}, readMarks: {} },
			{ id: DM, title: ME, members: [OWNER, ME], at: 1 },
		);
		const { message } = appendMessage(state, DM, { from: OWNER, text: "怎么样", at: 2 });
		const body = renderDeliveryWithTemplates({ channel: state.channels[DM]!, message, viewer: ME });
		// 光说「回团队频道」没用：它不知道频道叫什么，只会省略 channel 落回私聊。
		expect(body).toContain("要指挥团队");
		expect(body).toContain("`channel`");
		expect(body).toContain("团队一个字都收不到");
	});
});

describe("要我拍板就 @ 我", () => {
	it("不 @ 我就不会自动叫我：只有正文点名才算（ADR-009）", async () => {
		const { say, snapshot } = await setup();
		await say({ text: "接口先按 v1 做" });
		const state = await snapshot();
		const message = lastSpoken(state, PROJ, "接口先按 v1 做");
		expect(message?.mentions).not.toContain(OWNER);
		expect(recipientsOf(state.channels[PROJ]!, message!)).not.toContain(OWNER);
	});

	it("@ 了成员 → 不补 owner（内部结论不叫我）", async () => {
		const { say, snapshot } = await setup({ colleague: "林越" });
		const line = "@林越 计时先按 at 走，要不要加 startedAt 以后再说";
		await say({ text: line });
		const state = await snapshot();
		const message = lastSpoken(state, PROJ, line);
		expect(message?.mentions).toContain("林越");
		expect(message?.mentions).not.toContain(OWNER);
		expect(recipientsOf(state.channels[PROJ]!, message!)).not.toContain(OWNER);
	});

	it("正文显式 @owner 也能解析成 owner 并叫醒他（不靠关键词嗅探）", async () => {
		const { say, snapshot } = await setup();
		await say({ text: "@owner 要不要加联机模式？" });
		const state = await snapshot();
		expect(lastSpoken(state, PROJ, "@owner 要不要加联机模式？")?.mentions).toContain(OWNER);
	});

	it("英文内心独白不落库，返回理由并让模型重写", async () => {
		const { say, snapshot } = await setup();
		const before = lastOf(await snapshot(), PROJ)?.seq;
		const reply = await say({
			text: "Let me clone first, then read the compose before touching anything. The repo is at /Users/kirer/ds-bot.",
		});
		expect(reply).toContain("这条没发出去");
		// 关键：它没有落库 —— 不然「拦」只是多了一句提示，频道里照样多一条独白。
		expect(lastOf(await snapshot(), PROJ)?.seq).toBe(before);
	});

	it("超长正文不落库", async () => {
		const { say, snapshot } = await setup();
		const before = lastOf(await snapshot(), PROJ)?.seq;
		const reply = await say({ text: "很".repeat(1_201) });
		expect(reply).toContain("太长了");
		expect(lastOf(await snapshot(), PROJ)?.seq).toBe(before);
	});

	it("群聊里的上限比私聊更紧：600 字就该打回去", async () => {
		const { say, snapshot } = await setup({ colleague: "林越" });
		const before = lastOf(await snapshot(), PROJ)?.seq;
		const reply = await say({ text: "很".repeat(700) });
		expect(reply).toContain("太长了");
		expect(lastOf(await snapshot(), PROJ)?.seq).toBe(before);
	});

	it("普通闲聊不补 owner", async () => {
		const { say, snapshot } = await setup();
		await say({ text: "收到，我接着改" });
		const state = await snapshot();
		expect(lastOf(state, PROJ)?.mentions ?? []).not.toContain(OWNER);
	});
	it("没 @owner 的协作消息不补 owner、不标需要我（#4 回归）", async () => {
		// 模拟「@成员 但没 @我」：正文含 @沈舟（频道里真实成员），无 @owner。
		const { say, snapshot } = await setup();
		await say({ text: "@沈舟 这块要不要拆两次上线？", mention: "沈舟" });
		const state = await snapshot();
		const msg = lastSpoken(state, PROJ, "@沈舟 这块要不要拆两次上线？");
		expect(msg?.mentions ?? []).not.toContain(OWNER);
		expect(recipientsOf(state.channels[PROJ]!, msg!)).not.toContain(OWNER);
	});

	it("mention 写「我」也能解析成 owner 并叫醒他", async () => {
		const { say, snapshot } = await setup();
		await say({ text: "这个得你定", mention: "我" });
		const state = await snapshot();
		const message = lastSpoken(state, PROJ, "@owner 这个得你定");
		expect(message?.mentions).toContain(OWNER);
		expect(message?.text).toContain("@owner");
	});
});

describe("这一轮不说话（[PASS]）", () => {
	it("同一个频道里还有成员在时，PASS 不落库", async () => {
		const { say, snapshot } = await setup({ colleague: "陆衡" });
		const before = await snapshot();
		const reply = await say({ text: "[PASS]" });
		const after = await snapshot();
		expect(reply).toContain("不说了");
		expect(after.messages[PROJ]?.length).toBe(before.messages[PROJ]?.length);
	});

	it("只有自己被叫醒时，PASS 被拒绝，而且什么都没写进去", async () => {
		// 我只点名一个人：他 PASS 掉就等于我什么都没收到 —— 那是断线，不是安静。
		const { say, snapshot } = await setup({ wake: { channelId: PROJ, seq: 1 } });
		const before = await snapshot();
		const reply = await say({ text: "[PASS]" });
		const after = await snapshot();
		expect(reply).toContain("不能 PASS");
		expect(after.messages[PROJ]?.length).toBe(before.messages[PROJ]?.length);
	});

	it("空正文、方括号、中文括号、pass. 都算同一件事", async () => {
		for (const text of ["", "   ", "[PASS]", "【pass】", "（PASS）", "pass.", "PASS！"]) {
			expect(isPass(text), JSON.stringify(text)).toBe(true);
		}
		for (const text of ["passport 办好了", "[PASS] 但是", "过了", "[PASS] 我改完了"]) {
			expect(isPass(text), JSON.stringify(text)).toBe(false);
		}
	});
});

describe("每轮附言（怎么回话）", () => {
	it("被叫醒后 say 不填频道 → 落回叫你的那个频道（不是最近的群，也不是私聊）", async () => {
		// live 第一轮「提交 done 但频道里没有它说的话」的最小复现：先证明落点机制本身是好的。
		// 机制好 → 问题在模型/提示词侧；机制坏 → 问题在 code，不用等 live。
		const { say, snapshot } = await setup({ wake: { channelId: PROJ, seq: 1 } });
		await say({ text: "看完了，可以加联机" });
		const state = await snapshot();
		expect((state.messages[PROJ] ?? []).filter((m) => m.from === ME).map((m) => m.text)).toContain(
			"看完了，可以加联机",
		);
		// 群里被叫、却在私聊里答过一次（ADR-081 之前的老 bug）：这里钉死不许再发生。
		expect((state.messages[DM] ?? []).some((m) => m.from === ME)).toBe(false);
	});

	it("被叫醒的频道只有我+他两个人（私聊形态）时，say 不填频道也要落回那里", async () => {
		// live 第一轮就是这个形状：全员频道只有 owner + 助理，按 chatKind 是 dm。
		// 兜底分支（fallbackChannelId 只找「群」）在这个形状下会错过它，所以必须靠 wake 记录。
		const { say, snapshot } = await setup({ solo: true, wake: { channelId: PROJ, seq: 1 } });
		await say({ text: "在，听你说" });
		const state = await snapshot();
		expect((state.messages[PROJ] ?? []).filter((m) => m.from === ME).map((m) => m.text)).toContain("在，听你说");
	});

	it("没有 wake 记录时，say 不填频道不许落到私聊（更不许落到不存在的频道）", async () => {
		// `fallbackChannelId` 的兜底起点是 `dmId(owner, slug)`，只有找到**群**才替换它。
		// 于是「我 + 他」两个人的频道（chatKind = dm）会被跳过，say 就去写私聊/写一个不存在的 id。
		// ADR-037 的契约是「兜底频道不落私聊」——这条把那条契约钉回来。
		const { say, snapshot } = await setup({ solo: true });
		await say({ text: "在，听你说" });
		const state = await snapshot();
		const landed = Object.keys(state.messages).filter((id) =>
			(state.messages[id] ?? []).some((m) => m.from === ME && m.text === "在，听你说"),
		);
		// 落到的每个频道都必须真实存在，而且不能是私聊。
		for (const id of landed) expect(state.channels[id], `写进了不存在的频道 ${id}`).toBeDefined();
		expect(landed, "答在私聊里：问的人在原频道什么都看不到（ADR-037 修过的老 bug）").not.toContain(DM);
	});

	it("只有自己时：必须回，不提 PASS", () => {
		const rules = renderReplyRules({
			template: REPLY_TEMPLATE,
			fragments: SEED_DELIVERY_PROMPT,
			woken: ["沈舟"],
			viewer: "沈舟",
		});
		expect(rules).toContain("必须回");
		expect(rules).not.toContain("[PASS]");
	});

	it("还有别人时：点名是谁，PASS 的规则只在 say 的说明里（一个家）", () => {
		const rules = renderReplyRules({
			template: REPLY_TEMPLATE,
			fragments: SEED_DELIVERY_PROMPT,
			woken: ["沈舟", "陆衡"],
			viewer: "沈舟",
		});
		expect(rules).toContain("陆衡");
		expect(rules).not.toContain("必须回");
		expect(rules).not.toContain("[PASS]");
		expect(SEED_TEXT.get("say.param.text")).toContain("[PASS]");
	});

	it("群里有成员时：告诉他们「成员的事在群里说，@ 他」", () => {
		const withColleague = renderReplyRules({
			template: REPLY_TEMPLATE,
			fragments: SEED_DELIVERY_PROMPT,
			woken: ["沈舟"],
			viewer: "沈舟",
			colleagues: ["陆衡"],
		});
		expect(withColleague).toContain("成员的事就在这个频道说");
		expect(withColleague).toContain("陆衡");
		// 私聊里没有第三方，不该提「去找成员」
		const without = renderReplyRules({
			template: REPLY_TEMPLATE,
			fragments: SEED_DELIVERY_PROMPT,
			woken: ["沈舟"],
			viewer: "沈舟",
			colleagues: [],
		});
		expect(without).not.toContain("成员的事就在这个频道说");
	});

	it("条件句来自 prompt/ 片段：换一份片段，输出跟着变", () => {
		const rules = renderReplyRules({
			template: "{{reply.alone}}",
			fragments: { ...SEED_DELIVERY_PROMPT, alone: { body: "（换了一份说法。）", fallback: "" } },
			woken: ["沈舟"],
			viewer: "沈舟",
		});
		expect(rules).toBe("（换了一份说法。）");
		// 正文删空 → 用同一个 md 的 `default:` 那句，不产生「（未设置）」半截句。
		const missing = renderReplyRules({
			template: "{{reply.alone}}",
			fragments: { ...SEED_DELIVERY_PROMPT, alone: { body: "", fallback: SEED_DELIVERY_PROMPT.alone.fallback } },
			woken: ["沈舟"],
			viewer: "沈舟",
		});
		expect(missing).toBe("（这一轮只有你被叫醒。）");
	});

	it("投递正文里带上了这两句（不是只在系统提示里）", async () => {
		const { snapshot } = await setup();
		const state = await snapshot();
		const message = state.messages[PROJ]![0]!;
		const body = renderDeliveryWithTemplates({
			channel: state.channels[PROJ]!,
			message,
			viewer: ME,
		});
		expect(body).toContain("像成员发消息");
		expect(body).toContain("只有你被叫醒");
	});
});

describe("过程话可以连发（「一轮一句结论」已降级为 rules.md 约束，ADR-090）", () => {
	it("过程话（step）可以连发，不影响后面那句结论", async () => {
		const { say, snapshot } = await setup();
		await say({ text: "我先看下代码" });
		await say({ text: "找到原因了，正在改" });
		const reply = await say({ text: "改完了，根因是字符串被反复转义" });
		const state = await snapshot();
		expect(reply).toContain("已发到");
		// 过程话不合并（ADR-081 删掉了 30 秒 step 合并）：每句都是独立一条，结论另起一条。
		expect(lastSpoken(state, PROJ, "我先看下代码")).toBeDefined();
		expect(lastSpoken(state, PROJ, "找到原因了，正在改")).toBeDefined();
		expect(lastSpoken(state, PROJ, "改完了，根因是字符串被反复转义")).toBeDefined();
	});

	it("说了结论之后再发过程话，还是允许的", async () => {
		const { say } = await setup();
		await say({ text: "结论：这个不需要改" });
		expect(await say({ text: "顺带说一下，我把它记进文档了" })).toContain("已发到");
	});

});

describe("要我选：带 options", () => {
	it("2–6 个选项：自动叫我、原样存进消息", async () => {
		const box = await setup();
		const output = await box.say({ text: "先做哪个？", options: ["首页", "登录页"] });
		expect(output).toContain("已发到");
		const state = await box.snapshot();
		const last = lastOf(state, PROJ);
		expect(last?.kind).toBe("chat");
		expect(last?.options).toEqual(["首页", "登录页"]);
		expect(last?.mentions).toContain(OWNER);
	});

	it("选项少于 2 个、或多于 6 个、或重复：都不发，回一句能自救的话", async () => {
		const box = await setup();
		expect(await box.say({ text: "选一个", options: ["只有一个"] })).toContain("2–6");
		const seven = ["a", "b", "c", "d", "e", "f", "g"];
		expect(await box.say({ text: "选一个", options: seven })).toContain("2–6");
		expect(await box.say({ text: "选一个", options: ["A", "A"] })).toContain("不要重复");
	});
});
