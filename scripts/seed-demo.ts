#!/usr/bin/env node
/**
 * 演示数据：建一家有项目、有员工、有待拍板的公司，方便立刻看到界面全貌。
 *
 * 用法：
 *   node --experimental-strip-types scripts/seed-demo.ts [--db path] [--workspace dir]
 *
 * 它不调用模型（不产生费用），只写数据。
 */
import { join } from "node:path";
import {
	BACKGROUND_CONTEXT,
	createRegistry,
	openCompany,
	recover,
	setupModels,
} from "../src/runtime/index.ts";
import { bootstrapCompany, COMPANY_TASKS_EXTENSION, createProject, hireStaff } from "../src/company/org.ts";
import { createEscalationTask, startEscalation } from "../src/company/escalation.ts";
import { recordMessage } from "../src/company/trail.ts";

/** 解析参数。 */
function parseArgs(argv: readonly string[]) {
	let db = join(process.cwd(), "workspace", "demo.sqlite");
	let workspace = join(process.cwd(), "workspace", "demo");
	for (let index = 0; index < argv.length; index += 1) {
		const next = argv[index + 1];
		if (argv[index] === "--db" && next !== undefined) {
			db = next;
			index += 1;
		} else if (argv[index] === "--workspace" && next !== undefined) {
			workspace = next;
			index += 1;
		}
	}
	return { db, workspace };
}

const args = parseArgs(process.argv.slice(2));
const { models, defaultModel, catalog } = setupModels();
const registry = createRegistry();

const runtime = await openCompany({ databasePath: args.db, models, registry }, BACKGROUND_CONTEXT);
await recover(runtime, BACKGROUND_CONTEXT);

registry.install(COMPANY_TASKS_EXTENSION);
const escalationTask = createEscalationTask(runtime);
registry.install({ name: "escalation", tasks: [escalationTask] } as never);

const boot = await bootstrapCompany(
	runtime,
	{
		companyName: "晨光科技",
		registry,
		workspaceRoot: join(args.workspace, "projects"),
		defaultModel,
		modelCatalog: [...catalog],
		escalationTask,
	},
	BACKGROUND_CONTEXT,
);

// 两个项目，各配员工
const alpha = await createProject(
	runtime,
	{
		name: "坦克大战",
		slug: "tank-battle",
		brief: "HTML5 Canvas 像素风坦克大战，单人闯关 + 双人对战，含地形与胜负判定。",
		acceptance: "浏览器打开即玩；双人可同屏；至少三关。",
		leaderName: "陆沉",
		workspaceRoot: join(args.workspace, "projects"),
	},
	BACKGROUND_CONTEXT,
);

const alphaStaff = new Map<string, number>();
for (const [name, role, manager] of [
	["林越", "开发", "cto"],
	["周牧", "开发", "cto"],
	["何晓", "设计", "cpo"],
	["沈舟", "测试", "cto"],
] as const) {
	const hired = await hireStaff(runtime, { project: "tank-battle", name, role, manager, registry }, BACKGROUND_CONTEXT);
	alphaStaff.set(name, hired.conversationId);
}

const beta = await createProject(
	runtime,
	{
		name: "客户门户",
		slug: "customer-portal",
		brief: "面向企业客户的自助门户：账号、工单、账单三块。",
		acceptance: "客户能自助提交工单并查看账单。",
		leaderName: "苏晚",
		workspaceRoot: join(args.workspace, "projects"),
	},
	BACKGROUND_CONTEXT,
);

const betaStaff = new Map<string, number>();
for (const [name, role, manager] of [
	["阿舟", "开发", "cto"],
	["阿禾", "开发", "cto"],
	["阿宁", "测试", "cto"],
] as const) {
	const hired = await hireStaff(runtime, { project: "customer-portal", name, role, manager, registry }, BACKGROUND_CONTEXT);
	betaStaff.set(name, hired.conversationId);
}

// 演示用的沟通连线：让界面一打开就能看到「谁在跟谁说话」。
// 这些是真实写入 TrailDoc 的记录，不是界面假数据；连线可在项目翻面后看到更细的归属。
const talk = async (input: {
	kind: "delegate" | "report" | "escalate" | "decide";
	from: string;
	to: string;
	fromConversationId: number;
	toConversationId: number;
	ref: string;
	project?: string;
	text?: string;
}) => recordMessage(runtime, input, BACKGROUND_CONTEXT);

await talk({
	kind: "delegate",
	from: "CEO",
	to: "CTO",
	fromConversationId: boot.roleConversations.ceo,
	toConversationId: boot.roleConversations.cto,
	ref: "demo-talk-1",
	text: "推进坦克大战与客户门户。",
});
await talk({
	kind: "delegate",
	from: "CTO",
	to: "陆沉",
	fromConversationId: boot.roleConversations.cto,
	toConversationId: alpha.project.leader,
	ref: "demo-talk-2",
	project: "tank-battle",
	text: "先拆渲染层，再跑冒烟测试。",
});
await talk({
	kind: "delegate",
	from: "陆沉",
	to: "林越",
	fromConversationId: alpha.project.leader,
	toConversationId: alphaStaff.get("林越") ?? alpha.project.leader,
	ref: "demo-talk-3",
	project: "tank-battle",
	text: "渲染层拆出来，保持 draw 接口不变。",
});
await talk({
	kind: "report",
	from: "林越",
	to: "陆沉",
	fromConversationId: alphaStaff.get("林越") ?? alpha.project.leader,
	toConversationId: alpha.project.leader,
	ref: "demo-talk-3:report",
	project: "tank-battle",
	text: "已拆完，冒烟测试 32/32 通过。",
});
await talk({
	kind: "delegate",
	from: "CPO",
	to: "苏晚",
	fromConversationId: boot.roleConversations.cpo,
	toConversationId: beta.project.leader,
	ref: "demo-talk-4",
	project: "customer-portal",
	text: "客户门户二期需求先出个提纲。",
});
await talk({
	kind: "delegate",
	from: "苏晚",
	to: "阿舟",
	fromConversationId: beta.project.leader,
	toConversationId: betaStaff.get("阿舟") ?? beta.project.leader,
	ref: "demo-talk-5",
	project: "customer-portal",
	text: "把登录页先搭起来。",
});

// 全部数据写完再退出：不调用模型，避免生成演示数据要等几分钟
// 一条等你拍板的升级（先由 CTO 上报，再升到 CEO，最后到你）
const key = "demo-esc-1";
await startEscalation(
	runtime,
	escalationTask,
	{
		question: "坦克大战要不要加联机对战？加了要多两周工期，不加只能本地双人。",
		from: "周牧",
		fromConversationId: alpha.project.leader,
		manager: "cto",
		project: "tank-battle",
		escalationKey: key,
	},
	BACKGROUND_CONTEXT,
);

// 假装 CTO 与 CEO 都拍不了，让它升到你这里
const { answerPending } = await import("../src/company/escalation.ts");
const waitFor = async (level: string) => {
	const { listPending } = await import("../src/company/escalation.ts");
	for (let index = 0; index < 100; index += 1) {
		const pending = await listPending(runtime, BACKGROUND_CONTEXT);
		if (pending.some((item) => item.level === level)) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
};

if (await waitFor("cto")) {
	await answerPending(runtime, { key, answer: "涉及工期与联机架构，我拍不了。", answeredBy: "cto", escalate: true }, BACKGROUND_CONTEXT);
}
if (await waitFor("ceo")) {
	await answerPending(runtime, { key, answer: "这是产品范围决策，请老板定。", answeredBy: "ceo", escalate: true }, BACKGROUND_CONTEXT);
}
await waitFor("owner");

await runtime.close();

process.stdout.write(`演示数据已生成\n  数据库：${args.db}\n  工作空间：${join(args.workspace, "projects")}\n`);
process.stdout.write(`\n启动界面查看：\n  npm start -- --db ${args.db} --workspace ${args.workspace}\n\n`);
void beta;
