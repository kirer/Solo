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
import { createCoreTools } from "../../src/core/channel/tools.ts";
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
import { renderDelivery } from "../../src/core/channel/deliver.ts";
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
async function setup(): Promise<{
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

	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		Object.assign(doc, ensureChannel(doc, { id: DM, title: ME, members: [OWNER, ME], at: 1 }));
		Object.assign(doc, ensureChannel(doc, { id: PROJ, title: "小恐龙", members: [OWNER, ME], at: 2 }));
		// 项目频道里有过消息 → 它是「最近活跃的那个」。
		const first = appendMessage(doc, PROJ, { from: OWNER, text: "小恐龙做到哪了", at: 10 });
		doc.messages[PROJ] = [first.message];
		doc.nextSeq[PROJ] = first.message.seq + 1;
	}, BACKGROUND_CONTEXT);

	const tools = createCoreTools({
		harness: runtime.harness,
		workspaceRoot: root,
		agentsRoot,
		projectsRoot,
		directory: async () => ({
			...emptyDirectory(),
			slugToConversation: { [ME]: CONVERSATION },
			conversationToSlug: { [String(CONVERSATION)]: ME },
		}),
		saveDirectory: async () => undefined,
	} as never);
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
		expect(lastOf(after, DM)?.text).toContain("在私聊里说一句");
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
	it("needsOwner 认决策信号，不认普通闲聊", () => {
		expect(needsOwner("要不要加联机")).toBe(true);
		expect(needsOwner("这个是 A 还是 B？")).toBe(true);
		expect(needsOwner("请确认一下这个方案")).toBe(true);
		expect(needsOwner("等你定")).toBe(true);
		expect(needsOwner("好的，我继续做")).toBe(false);
		expect(needsOwner("dino v2 已验收，46 项全绿")).toBe(false);
	});

	it("kind=decision 且没 @ 老板 → mentions 补上 owner，正文不动", async () => {
		const { say, snapshot } = await setup();
		await say({ text: "接口先按 v1 做", kind: "decision" });
		const state = await snapshot();
		const message = lastOf(state, PROJ);
		expect(message?.mentions).toContain(OWNER);
		expect(message?.text).not.toContain("@owner");
		expect(recipientsOf(state.channels[PROJ]!, message!)).toContain(OWNER);
	});

	it("正文有决策信号也补 owner", async () => {
		const { say, snapshot } = await setup();
		await say({ text: "要不要加联机模式？" });
		const state = await snapshot();
		expect(lastOf(state, PROJ)?.mentions).toContain(OWNER);
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

	it("mention 写「老板」也能解析成 owner 并叫醒他", async () => {
		const { say, snapshot } = await setup();
		await say({ text: "这个得你定", mention: "老板" });
		const state = await snapshot();
		const message = lastOf(state, PROJ);
		expect(message?.mentions).toContain(OWNER);
		expect(message?.text).toContain("@owner");
	});
});
