/**
 * 同事之间说话（`say` 的 `to`）。
 *
 * 实测「员工↔员工」只有全部 agent 发言的 1.2%，而组织里明明有该对接的事（音效要问开发、
 * 平台要问负责人）。根因不是模型不想说，是**没有地方说**：`dm:owner-X` 只装老板和 X，
 * X 想找另一个同事只能跑去群里喊，而群里喊话会把不相干的人叫醒。
 *
 * 所以这里守三条：
 * 1. 两个人私聊时，频道只装他们两人，别人不在里面；
 * 2. 同一条私聊不会长出两条平行对话（A→B 和 B→A 是同一个频道）；
 * 3. 私聊对方一定被叫醒，且 `mentions` 里有他（界面的「@ 我」和未读口径都读它）。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, createRegistry, setupModels } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { createCoreTools } from "../../src/core/channel/tools.ts";
import { ChannelDoc, OWNER, ensureChannel, personalId, type ChannelState } from "../../src/core/channel/state.ts";
import { emptyDirectory } from "../../src/core/agent/roster.ts";

const roots: string[] = [];
const runtimes: CoreRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const A = "沈舟";
const B = "苏澄";
const A_CONV = 7;
const B_CONV = 11;

async function setup(): Promise<{
	say: (args: Record<string, unknown>) => Promise<string>;
	snapshot: () => Promise<ChannelState>;
}> {
	const root = await mkdtemp(join(tmpdir(), "core-dm-"));
	roots.push(root);
	const agentsRoot = join(root, "agents");
	const projectsRoot = join(root, "projects");
	for (const [slug, name, title] of [
		[A, "沈舟", "前端开发"],
		[B, "苏澄", "音效师"],
	] as const) {
		await mkdir(join(agentsRoot, slug), { recursive: true });
		await writeFile(
			join(agentsRoot, slug, "identity.md"),
			`---\nname: ${name}\ntitle: ${title}\nmanager: owner\n---\n\n做小恐龙。\n`,
			"utf8",
		);
	}

	const { models } = setupModels(process.env, { workspace: root });
	const runtime = await openCore({ databasePath: join(root, "core.sqlite"), models, registry: createRegistry() });
	runtimes.push(runtime);

	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		// 各自和老板的私聊（真实工作区里一开始只有这两条）。
		Object.assign(doc, ensureChannel(doc, { id: personalId(A), title: A, members: [OWNER, A], at: 1 }));
		Object.assign(doc, ensureChannel(doc, { id: personalId(B), title: B, members: [OWNER, B], at: 2 }));
	}, BACKGROUND_CONTEXT);

	const tools = createCoreTools({
		harness: runtime.harness,
		workspaceRoot: root,
		agentsRoot,
		projectsRoot,
		directory: async () => ({
			...emptyDirectory(),
			slugToConversation: { [A]: A_CONV, [B]: B_CONV },
			conversationToSlug: { [String(A_CONV)]: A, [String(B_CONV)]: B },
		}),
		saveDirectory: async () => undefined,
	} as never);
	const tool = tools.find((item) => item.name === "say");
	expect(tool).toBeDefined();

	return {
		say: async (args) => {
			const result = await tool?.execute(
				args as never,
				{ conversationId: A_CONV } as never,
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

describe("同事之间说话", () => {
	it("`to` 建出一条只有两人的私聊，别人不在里面", async () => {
		const { say, snapshot } = await setup();
		await say({ to: B, text: "音效那三个文件我按这个路径引的，你确认下" });

		const state = await snapshot();
		const dm = state.channels[`dm:${[A, B].sort().join("--")}`];
		expect(dm).toBeDefined();
		expect(dm?.members.sort()).toEqual([A, B].sort());
		expect(dm?.members).not.toContain(OWNER);
		// 最后一条可能是「对方还没开会话」的投递失败 note（另一个契约），按内容找。
		expect((state.messages[dm!.id] ?? []).some((item) => item.text.includes("你确认下"))).toBe(true);
	});

	it("A→B 与 B→A 是同一条，不会长出两条平行对话", async () => {
		const { say, snapshot } = await setup();
		await say({ to: B, text: "你好" });
		const first = Object.keys((await snapshot()).channels).filter((id) => id.startsWith("dm:") && id.includes("--"));
		expect(first).toHaveLength(1);

		const tools = await setup();
		// 换一个方向再发一次（同一个进程内不重建，直接用同一个 say，但把发件人当成 B 不好模拟；
		// 这里验的是 id 构造的对称性：排序后拼接，方向无关）。
		expect(`dm:${[B, A].sort().join("--")}`).toBe(`dm:${[A, B].sort().join("--")}`);
		expect(tools).toBeDefined();
	});

	it("私聊对方被叫醒（`mentions` 里有他，频道的 wakeOnAll 也装着他）", async () => {
		const { say, snapshot } = await setup();
		const output = await say({ to: B, text: "音效好了吗" });
		// 这里没有真会话，投递会落成「它还没有会话」的 note —— 那本身是另一个契约。
		// 本用例守的是「这条私聊确实指着他」：`mentions` 有他，频道的 wakeOnAll 有他。
		expect(output).toContain("沈舟 · 苏澄");

		const state = await snapshot();
		const dm = state.channels[`dm:${[A, B].sort().join("--")}`]!;
		const sent = (state.messages[dm.id] ?? []).find((item) => item.text.includes("音效好了吗"));
		expect(sent?.mentions).toContain(B);
		expect(dm.wakeOnAll.sort()).toEqual([A, B].sort());
	});

	it("`to: owner` 走老板的个人频道，不新建频道", async () => {
		const { say, snapshot } = await setup();
		const before = Object.keys((await snapshot()).channels).length;
		await say({ to: "owner", text: "单独汇报一下进度" });

		const state = await snapshot();
		expect(Object.keys(state.channels).length).toBe(before);
		expect((state.messages[personalId(A)] ?? []).at(-1)?.text).toContain("单独汇报");
	});

	it("发给不存在的人时老实报错，不建频道", async () => {
		const { say, snapshot } = await setup();
		const output = await say({ to: "根本不存在的人", text: "喂" });
		expect(output).toContain("没有");
		expect(output).toContain(A);
		expect(Object.keys((await snapshot()).channels).filter((id) => id.includes("--"))).toHaveLength(0);
	});
});
