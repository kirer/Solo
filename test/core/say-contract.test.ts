/**
 * `say` 的落点契约。
 *
 * 守的两件事：
 *
 * 1. **回话落在叫你的那个频道**。实测回复频道 85%/82% 是对的，但仍有 5 次失灵，而且
 *    有 2598 条噪音灌进了老板私聊 —— 因为兜底是 `mine[0]`，它可能正是「我和老板的私聊」，
 *    于是老板在群里问的一句被答进私聊。
 * 2. **要拍板的事必须叫老板**。含「请确认/要不要/等你定」的消息里大量没有 @ 老板，
 *    老板的回复率只有 1.06% —— 代码兜底补 `owner`，不靠模型自觉。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, createRegistry, setupModels } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { createCoreTools, isPass } from "../../src/core/channel/tools.ts";
import {
	ChannelDoc,
	OWNER,
	appendMessage,
	ensureChannel,
	needsOwner,
	personalId,
	projectId,
	recipientsOf,
	type ChannelState,
	type Message,
} from "../../src/core/channel/state.ts";
import { renderDelivery, renderReplyRules } from "../../src/core/channel/deliver.ts";
import { clearSpoken } from "../../src/core/channel/speech.ts";
import { emptyDirectory } from "../../src/core/agent/roster.ts";

const roots: string[] = [];
const runtimes: CoreRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const ME = "沈舟";
const CONVERSATION = 7;
const DM = personalId(ME);
const PROJ = projectId("dino");

/**
 * 一个真实的小运行时：`say` 要落库、要投递，只有真文档代理能验「落点」。
 *
 * 频道：我和老板的私聊（先建，所以 `channelsOf` 的第一名就是它）+ 项目频道（后来才活跃）。
 * 名册里有意留空 `wake` —— 模拟「没刚被叫醒」的兜底分支。
 */
async function setup(options: {
	/** 把「老板刚叫醒我」写进名册，`seq` 指向频道里的那条消息。 */
	wake?: { channelId: string; seq: number };
	/** 项目频道里多一个同事，并留下一条同时叫醒我们俩的消息。 */
	colleague?: string;
} = {}): Promise<{
	say: (args: Record<string, unknown>) => Promise<string>;
	snapshot: () => Promise<ChannelState>;
}> {
	const root = await mkdtemp(join(tmpdir(), "core-say-"));
	roots.push(root);
	const agentsRoot = join(root, "agents");
	const projectsRoot = join(root, "projects");
	await mkdir(join(agentsRoot, ME), { recursive: true });
	await writeFile(
		join(agentsRoot, ME, "identity.md"),
		"---\nname: 沈舟\ntitle: 前端开发\nmanager: owner\n---\n\n写小恐龙。\n",
		"utf8",
	);

	const { models } = setupModels(process.env, { workspace: root });
	const runtime = await openCore({
		databasePath: join(root, "core.sqlite"),
		models,
		registry: createRegistry(),
	});
	runtimes.push(runtime);

	const members = options.colleague === undefined ? [OWNER, ME] : [OWNER, ME, options.colleague];
	let wokeSeq: number | undefined;
	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(doc, ensureChannel(doc, { id: DM, title: ME, members: [OWNER, ME], at: 1 }));
		Object.assign(doc, ensureChannel(doc, { id: PROJ, title: "小恐龙", members, at: 2 }));
		// 项目频道里有过消息 → 它是「最近活跃的那个」。
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
	const wake =
		options.wake !== undefined || wakeSeq !== undefined
			? {
					[String(CONVERSATION)]: {
						channelId: options.wake?.channelId ?? PROJ,
						seq: wakeSeq,
						from: OWNER,
						at: 1,
					},
				}
			: {};

	const tools = createCoreTools({
		harness: runtime.harness,
		workspaceRoot: root,
		agentsRoot,
		projectsRoot,
		directory: async () => ({
			...emptyDirectory(),
			slugToConversation: { [ME]: CONVERSATION },
			conversationToSlug: { [String(CONVERSATION)]: ME },
			wake,
		}),
		saveDirectory: async () => undefined,
	} as never);
	// 每个用例都从「新一轮」开始（真实流程里由 `deliver()` 清）。不清的话，
	// 「一轮只说一句结论」这条会把后面每个用例都拒掉 —— 这正是它该有的行为。
	clearSpoken(CONVERSATION);
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

/** 取「用户真正发出的那条」（B 的 processing 占位会追加在后面，lastOf 会抓到它）。 */
function lastSpoken(state: ChannelState, channelId: string, text: string): Message | undefined {
	const list = state.messages[channelId] ?? [];
	return [...list].reverse().find((m) => m.text === text);
}

describe("兜底频道", () => {
	it("私聊先建也不落到私聊：优先我所在的非个人频道里最近活跃的那个", async () => {
		const { say, snapshot } = await setup();
		const before = await snapshot();
		expect(before.channels[DM]).toBeDefined();
		// 私聊是 `channelsOf` 的第一名（createdAt 最小）—— 旧逻辑 `mine[0]` 会落在这儿。

		await say({ text: "做完了，地址在 README 里" });

		const after = await snapshot();
		expect(lastOf(after, PROJ)?.text).toContain("地址在 README 里");
		expect(lastOf(after, DM)?.text ?? "").not.toContain("地址在 README 里");
	});

	it("只有个人频道时就回私聊", async () => {
		const { say, snapshot } = await setup();
		await say({ text: "在私聊里说一句", channel: DM });
		const after = await snapshot();
		expect(lastSpoken(after, DM, "在私聊里说一句")?.text).toContain("在私聊里说一句");
	});
});

describe("投递正文带频道 id", () => {
	it("第一行写清频道 id，模型才知道精确回哪儿", () => {
		const state = ensureChannel(
			{ channels: {}, messages: {}, nextSeq: {}, readMarks: {} },
			{ id: "all", title: "公司大群", members: [OWNER, ME], at: 1 },
		);
		const { message } = appendMessage(state, "all", { from: OWNER, text: "在吗", at: 2 });
		const body = renderDelivery({ channel: state.channels.all!, message, viewer: ME });
		expect(body.split("\n")[0]).toBe("【公司大群】#1（频道 all）");
	});

	it("私聊额外说一句「只回这里，别去群里」", () => {
		const state = ensureChannel(
			{ channels: {}, messages: {}, nextSeq: {}, readMarks: {} },
			{ id: DM, title: ME, members: [OWNER, ME], at: 1 },
		);
		const { message } = appendMessage(state, DM, { from: OWNER, text: "怎么样", at: 2 });
		const body = renderDelivery({ channel: state.channels[DM]!, message, viewer: ME });
		expect(body).toContain("别去群里");
	});
});

describe("要老板拍板就 @ 老板", () => {
	it("needsOwner 不再做关键词嗅探：普通/决策措辞都返回 false（#4 已移除嗅探）", () => {
		// 旧实现用「要不要/请确认/等你定」等正则嗅探正文，会把没点老板的 @同事 协作消息误标「需要我」。
		// #4 改为只认显式 @owner（由 parseMentions 处理，见下方集成用例），needsOwner 恒返回 false。
		expect(needsOwner("要不要加联机")).toBe(false);
		expect(needsOwner("这个是 A 还是 B？")).toBe(false);
		expect(needsOwner("请确认一下这个方案")).toBe(false);
		expect(needsOwner("等你定")).toBe(false);
		expect(needsOwner("好的，我继续做")).toBe(false);
		expect(needsOwner("dino v2 已验收，46 项全绿")).toBe(false);
	});

	it("kind=decision 且没 @ 老板 → mentions 补上 owner，正文不动", async () => {
		const { say, snapshot } = await setup();
		await say({ text: "接口先按 v1 做", kind: "decision" });
		const state = await snapshot();
		const message = lastSpoken(state, PROJ, "接口先按 v1 做");
		expect(message?.mentions).toContain(OWNER);
		expect(message?.text).not.toContain("@owner");
		expect(recipientsOf(state.channels[PROJ]!, message!)).toContain(OWNER);
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

	it("普通闲聊不补 owner", async () => {
		const { say, snapshot } = await setup();
		await say({ text: "收到，我接着改" });
		const state = await snapshot();
		expect(lastOf(state, PROJ)?.mentions ?? []).not.toContain(OWNER);
	});
	it("没 @owner 的协作消息不补 owner、不标需要我（#4 回归）", async () => {
		// 模拟「@同事 但没 @老板」：正文含 @沈舟（频道里真实成员），无 @owner。
		const { say, snapshot } = await setup();
		await say({ text: "@沈舟 这块要不要拆两次上线？", mention: "沈舟" });
		const state = await snapshot();
		const msg = lastSpoken(state, PROJ, "@沈舟 这块要不要拆两次上线？");
		expect(msg?.mentions ?? []).not.toContain(OWNER);
		expect(recipientsOf(state.channels[PROJ]!, msg!)).not.toContain(OWNER);
	});

	it("mention 写「老板」也能解析成 owner 并叫醒他", async () => {
		const { say, snapshot } = await setup();
		await say({ text: "这个得你定", mention: "老板" });
		const state = await snapshot();
		const message = lastSpoken(state, PROJ, "@owner 这个得你定");
		expect(message?.mentions).toContain(OWNER);
		expect(message?.text).toContain("@owner");
	});
});

describe("这一轮不说话（[PASS]）", () => {
	it("同一个频道里还有同事在时，PASS 不落库", async () => {
		const { say, snapshot } = await setup({ colleague: "陆衡" });
		const before = await snapshot();
		const reply = await say({ text: "[PASS]" });
		const after = await snapshot();
		expect(reply).toContain("不说了");
		expect(after.messages[PROJ]?.length).toBe(before.messages[PROJ]?.length);
	});

	it("只有自己被叫醒时，PASS 被拒绝，而且什么都没写进去", async () => {
		// 老板只点名一个人：他 PASS 掉就等于老板什么都没收到 —— 那是断线，不是安静。
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
	it("只有自己时：必须回，不提 PASS", () => {
		const rules = renderReplyRules({ woken: ["沈舟"], viewer: "沈舟" });
		expect(rules).toContain("必须回");
		expect(rules).not.toContain("[PASS]");
	});

	it("还有别人时：允许 PASS，并且点名是谁", () => {
		const rules = renderReplyRules({ woken: ["沈舟", "陆衡"], viewer: "沈舟" });
		expect(rules).toContain("[PASS]");
		expect(rules).toContain("陆衡");
		expect(rules).not.toContain("必须回");
	});

	it("投递正文里带上了这两句（不是只在系统提示里）", async () => {
		const { snapshot } = await setup();
		const state = await snapshot();
		const message = state.messages[PROJ]![0]!;
		const body = renderDelivery({
			channel: state.channels[PROJ]!,
			message,
			viewer: ME,
		});
		expect(body).toContain("像同事发消息");
		expect(body).toContain("只有你被叫醒");
	});
});

describe("一轮只说一句结论", () => {
	it("第二句结果被拒，而且什么都没写进去", async () => {
		const { say, snapshot } = await setup();
		await say({ text: "改完了，在 README 里" });
		const before = await snapshot();
		const reply = await say({ text: "另外我还顺手删了三个死函数" });
		const after = await snapshot();
		expect(reply).toContain("这一轮你已经说过结果了");
		expect(after.messages[PROJ]?.length).toBe(before.messages[PROJ]?.length);
	});

	it("过程话（step）可以连发，不影响后面那句结论", async () => {
		const { say, snapshot } = await setup();
		await say({ text: "我先看下代码", step: true });
		await say({ text: "找到原因了，正在改", step: true });
		const reply = await say({ text: "改完了，根因是字符串被反复转义" });
		const state = await snapshot();
		expect(reply).toContain("已发到");
		expect(lastSpoken(state, PROJ, "我先看下代码")?.text).toBe("我先看下代码");
		expect(lastSpoken(state, PROJ, "找到原因了，正在改")?.text).toBe("找到原因了，正在改");
		expect(lastSpoken(state, PROJ, "改完了，根因是字符串被反复转义")).toBeDefined();
	});

	it("说了结论之后再发过程话，还是允许的", async () => {
		const { say } = await setup();
		await say({ text: "结论：这个不需要改" });
		expect(await say({ text: "顺带说一下，我把它记进文档了", step: true })).toContain("已发到");
	});

	it("新一轮开始（清掉标记）就又可以说一句", async () => {
		const { say } = await setup();
		await say({ text: "第一轮的结论" });
		expect(await say({ text: "第二句" })).toContain("已经说过结果了");
		clearSpoken(CONVERSATION);
		expect(await say({ text: "新一轮的结论" })).toContain("已发到");
	});
});
