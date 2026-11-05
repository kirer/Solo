/**
 * kill -9 测试的子进程：造出「答案已提交、收尾任务还没跑」这个崩溃窗口。
 *
 * 真模型答完的瞬间没法在外面卡住，所以这里把那一瞬间的**durable 状态**直接写出来：
 * 会话里有一条正文、名册里有唤醒记录、频道里还没有这句话、`core.turn-report`
 * 任务已创建但调度没开（`openCore` 之后不 `resume()`）。
 *
 * 父进程杀掉它之后用真装配重启：`assembleCore` 会装上同一个任务名并 `resume()`，
 * 这一轮收尾就该跑完。
 *
 * `SEED_POSTED=1`：把「消息已经落盘、终态还没提交」那个窗口也造出来 —— 重启后
 * 收尾应当看到同文而跳过，不能双发。
 */
import { createModels, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	BACKGROUND_CONTEXT,
	createRegistry,
	defineExtension,
	openCore,
} from "../../src/core/runtime/index.ts";
import { ChannelDoc, type ChannelState } from "../../src/core/channel/types.ts";
import { DirectoryDoc, type DirectoryState } from "../../src/core/agent/roster.ts";
import { createTurnReport } from "../../src/core/channel/turn/report.ts";

const databasePath = process.env.CRASH_DB;
if (databasePath === undefined) throw new Error("缺少 CRASH_DB");

const channelId = "dm:owner-林越";
const answer = "在的。";
const wake = {
	reply: { channelId, seq: 1, from: "owner", at: 1 },
	task: { channelId, seq: 1, from: "owner", at: 1 },
};

const report = createTurnReport(async () => undefined);
const fixture = defineExtension({ name: "turn-report-fixture", tasks: [report.task] });
const registry = createRegistry();
registry.install(fixture);

const runtime = await openCore({ databasePath, models: createModels(), registry });
const conversation = await runtime.harness.createConversation(
	{ ownership: { kind: "ownerless" }, agent: { extensions: [fixture] } },
	BACKGROUND_CONTEXT,
);
const conversationId = Number(conversation.id);

await runtime.harness.commit(async (tx) => {
	const doc = (await tx.doc(ChannelDoc)) as ChannelState;
	doc.channels = {
		[channelId]: { id: channelId, title: "林越", members: ["owner", "林越"], wakeOnAll: [], createdAt: 1 },
	};
	doc.messages = {
		[channelId]: [
			{ seq: 1, from: "owner", at: 1, text: "@林越 在吗", mentions: ["林越"], kind: "chat" },
			...(process.env.SEED_POSTED === "1"
				? [{ seq: 2, from: "林越", at: 2, text: answer, mentions: [], kind: "chat" }]
				: []),
		],
	};
	doc.nextSeq = { [channelId]: process.env.SEED_POSTED === "1" ? 3 : 2 };
	doc.readMarks = {};
}, BACKGROUND_CONTEXT);

const answerId = await conversation.commit(
	(tx) => tx.appendEntry(conversation.id, { kind: "pi.assistant", model: [fauxAssistantMessage(answer)] }),
	BACKGROUND_CONTEXT,
);

await runtime.harness.commit(async (tx) => {
	const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
	doc.slugToConversation = { 林越: conversationId };
	doc.conversationToSlug = { [String(conversationId)]: "林越" };
	doc.wake = { [String(conversationId)]: wake };
}, BACKGROUND_CONTEXT);

const taskId = await conversation.commit(
	(tx) =>
		tx.createTask(
			report.task,
			{ slug: "林越", answer: String(answerId.id), wake },
			{ ownership: { kind: "conversation" } },
		),
	BACKGROUND_CONTEXT,
);

console.log(`TURN_REPORT ${JSON.stringify({ taskId: Number(taskId), conversationId, channelId, answer })}`);

// 调度没开（不调用 `resume()`）：任务停在 pending，等父进程杀。
setInterval(() => undefined, 1_000);
