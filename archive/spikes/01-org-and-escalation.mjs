// 一人公司骨架验证：角色 = extension，项目 = conversation(cwd)，员工 = task-owned conversation，
// 升级链 = 自定义 task 多 phase，成本 = UsageDoc。全部用 faux provider，不需要 API key。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	AssistantEntry,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	Harness,
	UsageDoc,
	section,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const ctx = BACKGROUND_CONTEXT;

// ── 组织总表：session 级单例 document ────────────────────────────────────────
const Org = defineDoc({
	kind: "app.org",
	version: 1,
	scope: "session",
	history: "latest",
	fork: "initial",
	initial: () => ({ projects: {}, employees: {}, escalations: {} }),
	checkpointWhen: () => false,
});

// ── 角色 = extension ────────────────────────────────────────────────────────
const role = (name, prompt) =>
	defineExtension({ name: `role-${name}`, sections: [section("role", () => prompt)] });

const CEO = role("ceo", "你是 CEO。只做决策与拆解，把执行派给项目。回复要短。");
const CTO = role("cto", "你是 CTO。技术选型与架构风险。不要写代码。");
const CFO = role("cfo", "你是 CFO。只谈 token 成本与预算。");
const Employee = role("employee", "你是项目员工。只做被指派的事，遇到不确定就上报。");

// ── 员工 = 后台常驻子会话（anchor task 作为 ownership 边界） ─────────────────
const Anchor = defineTask({
	name: "app.anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: async (_t, runtime, c) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), c),
	},
	abort: async (_t, runtime, c) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), c),
});

const Hire = defineTool({
	name: "hire",
	description: "为一个项目招聘一名员工，返回员工 id",
	parameters: Type.Object({ project: Type.String(), name: Type.String(), cwd: Type.String() }),
	replay: "safe",
	execute: async (args, api, c) => {
		const childId = await api.commit(async (tx) => {
			const org = await tx.doc(Org);
			const key = `${args.project}/${args.name}`;
			const exist = org.employees[key];
			if (exist !== undefined) return exist;
			const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			await configure(tx, child.id, {
				extensions: [Employee],
				instructions: `你是 ${args.project} 项目的 ${args.name}，向管理层汇报。`,
				cwd: args.cwd,
			});
			org.employees[key] = child.id;
			return child.id;
		}, c);
		return { output: [{ type: "text", text: `hired ${args.project}/${args.name} -> conversation ${childId}` }] };
	},
});

const Assign = defineTool({
	name: "assign",
	description: "给某项目员工派一个任务并等它答完",
	parameters: Type.Object({ project: Type.String(), name: Type.String(), task: Type.String() }),
	replay: "safe",
	execute: async (args, api, c) => {
		const org = await api.snapshot(Org, c);
		const childId = org.employees[`${args.project}/${args.name}`];
		if (childId === undefined) return { output: [{ type: "text", text: "no such employee" }] };
		api.details({ conversationId: childId }, c);
		const conv = await api.conversation(childId, c);
		const settled = await (await conv.submit({ type: "input", content: args.task }, c)).wait(c);
		return { output: [{ type: "text", text: String(settled.status) }] };
	},
});

const ManagementTools = defineExtension({ name: "mgmt", tools: [Hire, Assign] });

// ── 升级链 = 自定义 task，每级一个 phase ────────────────────────────────────
const Escalation = defineTask({
	name: "app.escalation",
	version: 1,
	initial: () => ({ phase: "manager" }),
	phases: {
		manager: async (task, runtime, c) => {
			// 管理层能拍板就拍板，否则上报 CEO，再否则上报老板
			const level = task.input.level;
			const next = level === "manager" ? "ceo" : level === "ceo" ? "owner" : "owner";
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: next, level: next } }), c);
		},
		ceo: async (task, runtime, c) =>
			runtime.commit(
				() => ({ status: "running", checkpoint: { phase: "owner", level: "owner" } }),
				c,
			),
		owner: async (task, runtime, c) => {
			// 老板拍板可能要很久：真实实现用 runtime.sleepUntil()
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: `resolved:${task.input.question}` } }),
				c,
			);
		},
	},
	abort: async (_t, runtime, c) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), c),
});

// ── 装配 ────────────────────────────────────────────────────────────────────
const workspace = await mkdtemp(join(tmpdir(), "aico-"));
const dbPath = join(workspace, "company.sqlite");
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);

const registry = createRegistry();
registry.install(ManagementTools);
registry.install(defineExtension({ name: "roles", tasks: [Anchor, Escalation] }));
for (const r of [CEO, CTO, CFO, Employee]) registry.install(r);

const harness = await Harness.open(await openNodeSqliteStorage(dbPath), { models, registry }, ctx);

// CEO 会话 = 老板的直属对话
const ceo = await harness.root(ctx, {
	agent: {
		model: { provider: "faux", modelId: "faux-1" },
		extensions: [ManagementTools, CEO],
		instructions: "你是这家一人公司的 CEO，直接向老板汇报。",
		cwd: workspace,
	},
});

// 项目 = 一个 conversation，cwd 指向项目文件夹
const project = await harness.createConversation(
	{
		ownership: { kind: "ownerless" },
		agent: {
			model: { provider: "faux", modelId: "faux-1" },
			extensions: [ManagementTools, CTO],
			cwd: workspace,
			instructions: "你是项目 leader。",
		},
	},
	ctx,
);

faux.setResponses([
	fauxAssistantMessage([fauxToolCall("hire", { project: "alpha", name: "dev-1", cwd: workspace })], { stopReason: "toolUse" }),
	fauxAssistantMessage("hired."),
	fauxAssistantMessage([fauxToolCall("assign", { project: "alpha", name: "dev-1", task: "实现登录" })], { stopReason: "toolUse" }),
	fauxAssistantMessage("assigned."),
	fauxAssistantMessage("员工说：登录做完了。"),
	fauxAssistantMessage("收到，我转给管理层。"),
	fauxAssistantMessage("好的。"),
	fauxAssistantMessage("明白。"),
]);

const r1 = await (await ceo.submit({ type: "input", content: "招一个开发" }, ctx)).wait(ctx);
console.log("1) CEO run:", r1.status);

const r2 = await (await project.submit({ type: "input", content: "派活给 dev-1" }, ctx)).wait(ctx);
console.log("2) project run:", r2.status, JSON.stringify(r2));

// 升级链
const esc = await ceo.commit(
	(tx) => tx.createTask(Escalation, { question: "要不要买 GPU", level: "manager" }, { ownership: { kind: "conversation" } }),
	ctx,
);
harness.resume();
const settledTask = await harness.waitForTask(esc, ctx);
console.log("3) escalation:", JSON.stringify(settledTask.outcome ?? settledTask.state));

// 成本
const org = await harness.snapshot(Org, undefined, ctx).catch(() => undefined);
const ceoUsage = await harness.snapshot(UsageDoc, ceo.id, ctx);
const total = await harness.usage(ctx);
console.log("4) ceo usage:", JSON.stringify(ceoUsage?.models ?? {}));
console.log("5) company usage:", JSON.stringify(Object.keys(total.models)));

// 老板分叉沟通：在 CEO 第 1 条答案处分叉
const page = await ceo.entries({ order: "ascending" }, 50, undefined, ctx);
const firstAnswer = page.items.find((e) => e.kind === "pi.assistant");
if (firstAnswer !== undefined) {
	const fork = await ceo.fork(firstAnswer.id, { ownership: { kind: "ownerless" } }, ctx);
	faux.setResponses([fauxAssistantMessage("分叉里的一句话")]);
	const fr = await (await fork.submit({ type: "input", content: "等等，换个方向" }, ctx)).wait(ctx);
	const forkEntries = await fork.entries({ order: "ascending" }, 100, undefined, ctx);
	console.log(`6) fork ${fork.id}: ${fr.status}, entries=${forkEntries.items.length} (parent had ${page.items.length})`);
}

// 任务图
const graph = await harness.watchTaskGraph(ctx);
console.log("7) task graph nodes:", Object.keys(graph.value.tasks).length);
await graph.stop();

await harness.close(ctx);
await rm(workspace, { recursive: true, force: true });
console.log("OK");
