/**
 * 重启把一轮掐断之后：把人叫回来接着做（ADR-044）。
 *
 * 两件事分开测：底座自愈要**报出**「谁的这一轮断了」（`openCore` 的 `interrupted`），
 * 装配层要**叫回**那个人（频道里留一句痕 + 叫醒）。缺任何一半，症状都是
 * 「重启后团队停在那儿，谁也不动」。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LiveDoc } from "../../src/core/runtime/index.ts";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { ChannelDoc, type ChannelState } from "../../src/core/channel/types.ts";
import { writeTeam } from "../../src/core/team/doc.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

async function person(root: string, slug: string, header: string): Promise<void> {
	await mkdir(join(root, slug), { recursive: true });
	await writeFile(join(root, slug, "identity.md"), `---\nname: ${slug}\n${header}---\n\n做事的。\n`, "utf8");
}

async function setup() {
	const box = await pool.make("resume-");
	await person(box.agentsRoot, "程一", "title: 开发\nmanager: owner\nteam: alpha\n");
	await writeTeam(box.teamsRoot, { slug: "alpha", name: "Alpha", lead: "程一", body: "目标：把东西做出来。" });
	const runtime = await box.open();
	const shell = await box.assemble(runtime);
	return { box, runtime, shell };
}

describe("重启自愈：谁的这一轮断了", () => {
	it("库里有半截 `run` 的会话被报出来（清掉之前）", async () => {
		const { box, runtime, shell } = await setup();
		const conversation = shell.conversations.get("程一");
		expect(conversation).toBeDefined();
		// 模拟「跑到一半被 kill」：live 里留着 run，任务本身已经不存在。
		await runtime.harness.commit(async (tx) => {
			const doc = await tx.doc(LiveDoc, conversation?.id as never);
			(doc as unknown as { run: unknown }).run = { taskId: 1, inputs: [] };
		}, BACKGROUND_CONTEXT);
		await runtime.close();

		const reopened = await box.open();
		expect(reopened.interrupted).toContain(Number(conversation?.id));
		const live = await reopened.harness.snapshot(LiveDoc, conversation?.id as never, BACKGROUND_CONTEXT);
		expect(live?.run).toBeUndefined();
	});

	it("没有半截 `run` 的库：一个人都不报（不会每次重启都叫醒全体）", async () => {
		const { box, runtime } = await setup();
		await runtime.close();
		expect((await box.open()).interrupted).toEqual([]);
	});
});

describe("装配层：把人叫回来", () => {
	it("在当时的频道里留一句痕，并叫醒他", async () => {
		const { box, runtime, shell } = await setup();
		const conversation = shell.conversations.get("程一");
		// 先让「他」被叫过一次：唤醒记录是重启后判断「当时在哪儿干活」的唯一线索。
		await shell.postAs({ channelId: "team:alpha", from: "owner", text: "@程一 把首版做出来。" }, BACKGROUND_CONTEXT);

		const before = (await shell.channels(BACKGROUND_CONTEXT)).messages["team:alpha"] ?? [];
		const unansweredBefore = before.filter((item) => item.text.includes("没答上来")).length;

		const again = await box.assemble(runtime, { interrupted: [Number(conversation?.id)] });
		const state = (await again.channels(BACKGROUND_CONTEXT)) as ChannelState;
		const notes = (state.messages["team:alpha"] ?? []).filter((item) => item.text.includes("被打断了"));
		expect(notes).toHaveLength(1);
		expect(notes[0]?.text).toContain("程一");
		expect(notes[0]?.kind).toBe("note");
		// 真的叫了人：测试里没有模型，所以那一轮会立刻以「没答上来」收场 —— 这正是被叫到的证据。
		const unansweredAfter = (state.messages["team:alpha"] ?? []).filter((item) =>
			item.text.includes("没答上来"),
		).length;
		expect(unansweredAfter).toBeGreaterThan(unansweredBefore);
	});
});
