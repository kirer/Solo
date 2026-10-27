/**
 * 新核心的活体验证（手工跑，不在测试套件里）：
 *
 *   npx tsx scripts/core-live.ts [工作目录]
 *
 * 它做一件最朴素的事：在一个空工作区里种一个人，然后老板在频道里问他一句话，
 * 等他自己回。**这一步跑通，新核心才算真的能用** —— 前面所有单测都只是零件。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "../src/core/runtime/index.ts";
import { createRegistry, openCore, setupModels } from "../src/core/runtime/index.ts";
import { assembleCore, ownerSpeak, seedOwnerAssistant } from "../src/core/shell/assemble.ts";
import { ChannelDoc, type ChannelState } from "../src/core/channel/state.ts";

const root = process.argv[2] ?? "/tmp/core-live";
const agents = join(root, "agents");
const projects = join(root, "projects");
await mkdir(projects, { recursive: true });

const { models, defaultModel } = setupModels(process.env, { workspace: root });
console.log("默认模型：", defaultModel ?? "（无）");

const opened = await openCore({
	databasePath: join(root, "company.sqlite"),
	models,
	registry: createRegistry(),
});

const slug = await seedOwnerAssistant(agents, { name: "林越" });
console.log("种下：", slug);

const shell = await assembleCore(opened.harness, opened.registry, { agentsRoot: agents, projectsRoot: projects });
console.log("会话：", [...shell.conversations.keys()]);

const conversation = shell.conversations.get(slug);
if (conversation === undefined) throw new Error("没有会话");
if (defaultModel !== undefined) {
	await conversation.configure({ model: defaultModel }, BACKGROUND_CONTEXT);
	console.log("模型已配置到会话");
}

const sent = await ownerSpeak(shell, { channelId: "company", text: "@林越 你是谁？用一句话说清楚你在这个公司里负责什么。" });
console.log("老板发出 #", sent.seq, sent.delivery);

console.log("等他自己回……");
const deadline = Date.now() + 180_000;
let state: ChannelState = await shell.channels();
while (Date.now() < deadline) {
	state = await shell.channels();
	const list = state.messages.company ?? [];
	if (list.some((message) => message.from === slug)) break;
	await new Promise((resolve) => setTimeout(resolve, 1000));
}

// 第二轮：改 identity.md，验证「下一条消息就生效」（不重启、不重开会话）。
const identityPath = join(agents, slug, "identity.md");
const before = await readFile(identityPath, "utf8");
await writeFile(identityPath, `${before.trimEnd()}\n\n补充：你只跟老板一个人说话，说话风格是三个字以内的一句话。\n`, "utf8");
console.log("\n已改 identity.md，再问一次……");
await ownerSpeak(shell, { channelId: "company", text: "@林越 用一句话说，你现在最该干的一件事是什么。" });
const deadline2 = Date.now() + 180_000;
let replies = 0;
while (Date.now() < deadline2) {
	state = await shell.channels();
	replies = (state.messages.company ?? []).filter((message) => message.from === slug).length;
	if (replies >= 2) break;
	await new Promise((resolve) => setTimeout(resolve, 1000));
}

for (const message of state.messages.company ?? []) {
	console.log(`#${message.seq} ${message.from}: ${message.text.slice(0, 400)}`);
}

const ctx = await conversation.context(BACKGROUND_CONTEXT);
console.log("会话条目数：", ctx.entries.length, "消息数：", ctx.messages.length);
for (const entry of ctx.entries.slice(-5)) {
	console.log("  entry", entry.kind, JSON.stringify(entry.data ?? null).slice(0, 200));
}
const agent = await conversation.agent(BACKGROUND_CONTEXT);
console.log("模型：", JSON.stringify(agent.model ?? null), "工具数：", agent.tools.length, "段落：", agent.sections.map((section) => section.key));
console.log("指令前 200 字：", (agent.sections.map((s) => s.key).join(",")));

const inspection = await opened.harness.inspect(BACKGROUND_CONTEXT);
console.log("任务：", inspection.tasks.map((task) => {
	const record = task.record as unknown as { definition?: { name?: string }; state?: unknown; outcome?: unknown };
	return { kind: record.definition?.name, state: JSON.stringify(task.state).slice(0, 400) };
}));

await opened.close();
