#!/usr/bin/env node
/**
 * 入口：打开公司并启动三栏终端界面。
 *
 * 用法：
 *   node --experimental-strip-types src/tui/main.ts [--db path] [--company name] [--workspace dir]
 *
 * 启动流程（顺序重要）：
 * 1. 打开运行时（SQLite）
 * 2. 巡检：先报告受阻任务，再恢复调度（规格要求恢复前不跑任何处理器）
 * 3. 初始化公司（注册能力包 → 幂等创建角色）
 * 4. 挂上崩溃自愈
 * 5. 启动界面
 */
import { join, resolve } from "node:path";
import {
	BACKGROUND_CONTEXT,
	createRegistry,
	acquireInstanceLock,
	openCompany,
	recover,
	setupModels,
	setupSignalHandlers,
	watchForFailure,
	type CompanyRuntime,
	type RuntimeReport,
} from "../runtime/index.ts";
import { bootstrapCompany, COMPANY_TASKS_EXTENSION, DEFAULT_MODEL_CATALOG } from "../company/org.ts";
import { CompanyDoc } from "../company/docs.ts";
import { createEscalationTask } from "../company/escalation.ts";
import { createApp } from "./app.ts";

/** 解析命令行参数。 */
function parseArgs(argv: readonly string[]): { db: string; company: string; workspace: string } {
	let db = join(process.cwd(), "workspace", "company.sqlite");
	let company = "一人公司";
	let workspace = join(process.cwd(), "workspace");

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--db" && argv[index + 1] !== undefined) {
			db = resolve(argv[index + 1] as string);
			index += 1;
		} else if (arg === "--company" && argv[index + 1] !== undefined) {
			company = argv[index + 1] as string;
			index += 1;
		} else if (arg === "--workspace" && argv[index + 1] !== undefined) {
			// 关键：workspaceRoot 从这里派生，必须是绝对路径，否则会话 cwd 会被
			// 执行环境再拼一次进程目录，目录不存在、员工所有命令失败。
			workspace = resolve(argv[index + 1] as string);
			index += 1;
		}
	}

	return { db, company, workspace };
}

const args = parseArgs(process.argv.slice(2));

// 必须在启动界面前接管：被 Ctrl+C 打断时要恢复光标与回显
setupSignalHandlers();

const { models, defaultModel, catalog } = setupModels();
const registry = createRegistry();

/** 报告：既打到 stderr，也留在界面里可查。 */
const onReport = (report: RuntimeReport): void => {
	if (report.kind === "runtime-failed") {
		process.stderr.write(`[运行时失效] ${String(report.error)}\n`);
	} else if (report.kind === "task-parked") {
		process.stderr.write(`[任务受阻] ${report.taskId} (${report.taskKind})\n`);
	} else if (report.kind === "task-failed") {
		process.stderr.write(`[任务出错] ${report.taskId} (${report.taskKind}): ${String(report.error)}\n`);
	} else if (report.kind === "extension-failed") {
		process.stderr.write(`[能力包出错] ${report.extension}: ${String(report.error)}\n`);
	}
};

/** 打开并初始化一次公司。 */
async function openAndBoot(): Promise<{
	runtime: CompanyRuntime;
	ownerConversationId: number;
	parked: readonly string[];
}> {
	const runtime = await openCompany({ databasePath: args.db, models, registry, onReport }, BACKGROUND_CONTEXT);

	// 巡检在恢复之前：规格要求「恢复前不执行任何处理器」
	const recovery = await recover(runtime, BACKGROUND_CONTEXT);

	// 内置任务先注册：缺了它，员工的后台锚点会受阻
	registry.install(COMPANY_TASKS_EXTENSION);

	// 升级任务：装进注册表，并交给 bootstrap 让管理层的 escalate 真正生效
	const escalationTask = createEscalationTask(runtime);
	registry.install({ name: "escalation", tasks: [escalationTask] } as never);

	await bootstrapCompany(
		runtime,
		{
			companyName: args.company,
			registry,
			workspaceRoot: join(args.workspace, "projects"),
			defaultModel,
			modelCatalog: [...DEFAULT_MODEL_CATALOG, ...catalog],

			escalationTask,
			// 与网页入口一致：终端版同样要有人收尾僵住的任务、排空队列。
			watchdog: true,
		},
		BACKGROUND_CONTEXT,
	);

	const state = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
	return {
		runtime,
		ownerConversationId: state?.roles.ceo ?? 1,
		parked: recovery.parkedTasks.map((task) => task.taskId),
	};
}

const instanceLock = await acquireInstanceLock(args.db);

const started = await openAndBoot();
let runtime = started.runtime;
let ownerConversationId = started.ownerConversationId;

// 受阻任务：报告并提供重试入口
if (started.parked.length > 0) {
	process.stderr.write(
		`检测到 ${started.parked.length} 个受阻任务（连续崩溃达到上限）：${started.parked.join(", ")}\n` +
			`在界面里按 R 可重试。\n`,
	);
}

// 崩溃自愈：运行时因存储故障关闭后自动重开
watchForFailure(
	runtime,
	async () => {
		const reopened = await openAndBoot();
		runtime = reopened.runtime;
		ownerConversationId = reopened.ownerConversationId;
		return reopened.runtime;
	},
	{
		retryDelayMs: 1_000,
		onReport: (report) => process.stderr.write(`[自愈] ${JSON.stringify(report)}\n`),
		onReopen: () => {
			process.stderr.write("[自愈] 运行时已重新打开\n");
		},
	},
);

const app = await createApp({
	runtime,
	initialConversationId: ownerConversationId,
	parkedTaskIds: started.parked,
});

// 退出时保留未完成的工作
const shutdown = () => {
	void app
		.stop()
		.then(() => instanceLock.release())
		.catch(() => undefined)
		.finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// 同上：SIGHUP 需要入口自己收尾（见 src/runtime/signals.ts 的说明）
process.on("SIGHUP", shutdown);
