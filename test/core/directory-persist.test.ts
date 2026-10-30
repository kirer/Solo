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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry, setupModels } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import { assembleCore, type CoreShell } from "../../src/core/shell/assemble.ts";
import { DirectoryDoc, type DirectoryState } from "../../src/core/agent/roster.ts";

const roots: string[] = [];
const runtimes: CoreRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function identity(ws: string, slug: string): Promise<void> {
	await mkdir(join(ws, "agents", slug), { recursive: true });
	await writeFile(join(ws, "agents", slug, "identity.md"), `---\nname: ${slug}\ntitle: 工程师\n---\n\n# ${slug}\n`, "utf8");
}

async function boot(ws: string): Promise<{ shell: CoreShell; runtime: CoreRuntime; doc: DirectoryState }> {
	const { models } = setupModels(process.env, { workspace: ws });
	const runtime = await openCore({ databasePath: join(ws, "core.sqlite"), models, registry: createRegistry() });
	runtimes.push(runtime);
	const shell = await assembleCore(runtime.harness, runtime.registry, {
		agentsRoot: join(ws, "agents"),
		teamsRoot: join(ws, "teams"),
		defaultModel: { provider: "test", modelId: "test" },
	});
	const doc = ((await runtime.harness.snapshot(DirectoryDoc)) as DirectoryState | undefined) ?? {
		slugToConversation: {},
		conversationToSlug: {},
		wake: {},
		labels: {},
	};
	return { shell, runtime, doc };
}

async function freshWs(): Promise<string> {
	const ws = await mkdtemp(join(tmpdir(), "core-directory-"));
	roots.push(ws);
	return ws;
}

describe("加人之后重启：复用同一个会话，不制造孤儿", () => {
	it("openAgent 立刻把映射落盘，重开用的是同一个会话 id", async () => {
		const ws = await freshWs();
		await identity(ws, "甲");
		const first = await boot(ws);
		const idA = first.doc.slugToConversation["甲"];
		expect(idA).toBeDefined();

		// 第二个人的身份是运行中才出现的（`hire` 的路径），只走 openAgent、不走 rescan。
		await identity(ws, "乙");
		const idB = await first.shell.openAgent("乙");
		const afterHire = (await first.runtime.harness.snapshot(DirectoryDoc)) as DirectoryState;
		expect(afterHire.slugToConversation["乙"]).toBe(idB);
		await first.runtime.close();

		const second = await boot(ws);
		expect(second.doc.slugToConversation["甲"]).toBe(idA);
		// 关键断言：重启后**没有**给她新开一个会话（旧行为这里会变一个新 id）。
		expect(second.doc.slugToConversation["乙"]).toBe(idB);
	});
});

describe("已有名册不被旧快照覆盖", () => {
	it("一次唤醒写入不会把别人的映射冲掉，重启后全员 id 不变", async () => {
		const ws = await freshWs();
		await identity(ws, "甲");
		await identity(ws, "乙");
		const first = await boot(ws);
		const before: Record<string, number | undefined> = { ...first.doc.slugToConversation };
		expect(before["甲"]).toBeDefined();
		expect(before["乙"]).toBeDefined();

		// 我在频道里 @甲：会走 `rememberWake`（旧写法在这里整份回写名册）。
		await first.shell.postAs({ channelId: "all", from: "owner", text: "@甲 在吗" });

		const afterWake = (await first.runtime.harness.snapshot(DirectoryDoc)) as DirectoryState;
		expect(afterWake.slugToConversation).toEqual(before);
		expect(Object.keys(afterWake.labels).sort()).toEqual(["乙", "甲"].sort());
		await first.runtime.close();

		const second = await boot(ws);
		expect(second.doc.slugToConversation).toEqual(before);
	});
});
