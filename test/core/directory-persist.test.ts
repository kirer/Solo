/**
 * 名册（`core.directory`）的持久化：谁的会话 id 不能丢。
 *
 * 两个真事故：
 * 1. `openAgent` 只把「slug → 会话 id」写进内存，落盘靠后续的批量提交顺带写 —— 加完人
 *    中间只要有一次「整份名册写回旧值」，这个人的映射就永久丢了：重启后他拿到一个**新**
 *    会话，旧会话变孤儿（顾南雁就丢过一次，22 条历史留在孤儿会话里）。
 * 2. 旧写法 `Object.assign(doc, { ...doc, wake })` 把文档代理展开后整份写回同一个覆盖层，
 *    会静默把别人的条目一起冲掉。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CoreShell } from "../../src/shell/assemble.ts";
import {
	DirectoryDoc,
	conversationFor,
	mergeDirectory,
	personOf,
	sessionKeyOf,
	slugFor,
	type DirectoryState,
} from "../../src/core/agent/roster.ts";
import type { CoreRuntime } from "../../src/core/runtime/open.ts";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { sandboxPool, type Sandbox } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

async function identity(box: Sandbox, slug: string): Promise<void> {
	await mkdir(join(box.agentsRoot, slug), { recursive: true });
	await writeFile(join(box.agentsRoot, slug, "identity.md"), `---\nname: ${slug}\ntitle: 工程师\n---\n\n# ${slug}\n`, "utf8");
}

async function boot(box: Sandbox): Promise<{ shell: CoreShell; runtime: CoreRuntime; doc: DirectoryState }> {
	const runtime = await box.open();
	const shell = await box.assemble(runtime, { defaultModel: { provider: "test", modelId: "test" } });
	const doc = ((await runtime.harness.snapshot(DirectoryDoc)) as DirectoryState | undefined) ?? {
		slugToConversation: {},
		conversationToSlug: {},
		wake: {},
		labels: {},
	};
	return { shell, runtime, doc };
}

describe("加人之后重启：复用同一个会话，不制造孤儿", () => {
	it("openAgent 立刻把映射落盘，重开用的是同一个会话 id", async () => {
		const box = await pool.make("core-directory-");
		await identity(box, "甲");
		const first = await boot(box);
		const idA = first.doc.slugToConversation["甲"];
		expect(idA).toBeDefined();

		// 第二个人的身份是运行中才出现的（`hire` 的路径），只走 openAgent、不走 rescan。
		await identity(box, "乙");
		const idB = await first.shell.openAgent("乙");
		const afterHire = (await first.runtime.harness.snapshot(DirectoryDoc)) as DirectoryState;
		expect(afterHire.slugToConversation["乙"]).toBe(idB);
		await first.runtime.close();

		const second = await boot(box);
		expect(second.doc.slugToConversation["甲"]).toBe(idA);
		// 关键断言：重启后**没有**给她新开一个会话（旧行为这里会变一个新 id）。
		expect(second.doc.slugToConversation["乙"]).toBe(idB);
	});
});

describe("落盘的名册落后于这次运行", () => {
	it("读名册时这次运行开过的会话优先（盘上缺人也不影响认人）", () => {
		const empty: DirectoryState = { slugToConversation: {}, conversationToSlug: {}, wake: {}, labels: {} };
		const live: DirectoryState = {
			slugToConversation: { 甲: 9 },
			conversationToSlug: { "9": "甲" },
			wake: { "9": { reply: { channelId: "all", seq: 1, from: "owner", at: 1 } } },
			labels: { 甲: "甲" },
		};
		const seen = mergeDirectory(empty, live);
		expect(seen.conversationToSlug["9"]).toBe("甲");
		expect(seen.slugToConversation["甲"]).toBe(9);
	});

	it("映射从盘上丢了：叫醒照样记在真实会话上", async () => {
		const box = await pool.make("core-directory-");
		await identity(box, "甲");
		const first = await boot(box);
		const idA = first.doc.slugToConversation["甲"];

		await first.runtime.harness.commit(async (tx) => {
			const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
			doc.slugToConversation = {};
			doc.conversationToSlug = {};
		}, BACKGROUND_CONTEXT);

		await first.shell.postAs({ channelId: "all", from: "owner", text: "@甲 在吗" });

		const after = (await first.runtime.harness.snapshot(DirectoryDoc)) as DirectoryState;
		expect(after.slugToConversation["甲"]).toBe(idA);
		expect(after.wake[String(idA)]).toBeDefined();
		await first.runtime.close();
	});
});

describe("已有名册不被旧快照覆盖", () => {
	it("一次唤醒写入不会把别人的映射冲掉，重启后全员 id 不变", async () => {
		const box = await pool.make("core-directory-");
		await identity(box, "甲");
		await identity(box, "乙");
		const first = await boot(box);
		const before: Record<string, number | undefined> = { ...first.doc.slugToConversation };
		expect(before["甲"]).toBeDefined();
		expect(before["乙"]).toBeDefined();

		// 我在频道里 @甲：会走 `rememberWake`（旧写法在这里整份回写名册）。
		await first.shell.postAs({ channelId: "all", from: "owner", text: "@甲 在吗" });

		const afterWake = (await first.runtime.harness.snapshot(DirectoryDoc)) as DirectoryState;
		expect(afterWake.slugToConversation).toEqual(before);
		expect(Object.keys(afterWake.labels).sort()).toEqual(["乙", "甲"].sort());
		await first.runtime.close();

		const second = await boot(box);
		expect(second.doc.slugToConversation).toEqual(before);
	});
});

describe("会话键就是 slug（ADR-058）", () => {
	it("slug ↔ 会话 id 一对一，反查回到人", () => {
		const empty: DirectoryState = { slugToConversation: {}, conversationToSlug: {}, wake: {}, labels: {} };
		const state: DirectoryState = {
			slugToConversation: { 甲: 1 },
			conversationToSlug: { "1": "甲" },
			wake: {},
			labels: {},
		};
		expect(conversationFor(state, "甲")).toBe(1);
		expect(conversationFor(state, "乙")).toBeUndefined();
		// 工具靠反查认「我是谁」。
		expect(slugFor(state, 1)).toBe("甲");
		expect(mergeDirectory(empty, state).slugToConversation).toEqual({ 甲: 1 });
	});
});
