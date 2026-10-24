#!/usr/bin/env node
/**
 * 网页界面入口。
 *
 * 用法：
 *   node --experimental-strip-types src/server/main.ts [--port 7788] [--db path] [--no-open]
 *
 * 启动流程与终端版一致：打开 → 巡检 → 初始化 → 起服务。
 */
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import {
	BACKGROUND_CONTEXT,
	createRegistry,
	openCompany,
	recover,
	setupModels,
	setupSignalHandlers,
	watchForFailure,
	type CompanyRuntime,
	type RuntimeReport,
} from "../runtime/index.ts";
import { bootstrapCompany, COMPANY_TASKS_EXTENSION } from "../company/org.ts";
import { CompanyDoc } from "../company/docs.ts";
import { createEscalationTask } from "../company/escalation.ts";
import { serve } from "./http.ts";

/** 解析命令行参数。 */
function parseArgs(argv: readonly string[]): {
	port: number;
	db: string;
	company: string;
	workspace: string;
	open: boolean;
} {
	let port = Number(process.env.PORT ?? 7788);
	let db = join(process.cwd(), "workspace", "company.sqlite");
	let company = "一人公司";
	let workspace = join(process.cwd(), "workspace");
	let open = true;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = argv[index + 1];
		if (arg === "--port" && next !== undefined) {
			port = Number(next);
			index += 1;
		} else if (arg === "--db" && next !== undefined) {
			// 命令行给相对路径时立刻转绝对：会话的 cwd 会原样进执行环境，
			// 相对路径会被再拼一次进程目录，导致目录不存在、所有命令失败。
			db = resolve(next);
			index += 1;
		} else if (arg === "--company" && next !== undefined) {
			company = next;
			index += 1;
		} else if (arg === "--workspace" && next !== undefined) {
			// 关键：workspaceRoot 从这里派生，必须是绝对路径（见上一条说明）。
			workspace = resolve(next);
			index += 1;
		} else if (arg === "--no-open") {
			open = false;
		}
	}

	return { port, db, company, workspace, open };
}

const args = parseArgs(process.argv.slice(2));
setupSignalHandlers();

const { models, defaultModel, catalog } = setupModels();
const registry = createRegistry();

const onReport = (report: RuntimeReport): void => {
	if (report.kind === "runtime-failed") process.stderr.write(`[运行时失效] ${String(report.error)}\n`);
	else if (report.kind === "task-parked") process.stderr.write(`[任务受阻] ${report.taskId} (${report.taskKind})\n`);
	else if (report.kind === "task-failed") process.stderr.write(`[任务出错] ${report.taskId}: ${String(report.error)}\n`);
	else if (report.kind === "extension-failed") process.stderr.write(`[能力包出错] ${report.extension}\n`);
};

/** 打开并初始化一次公司。 */
async function openAndBoot(): Promise<{ runtime: CompanyRuntime; parked: readonly string[] }> {
	const runtime = await openCompany({ databasePath: args.db, models, registry, onReport }, BACKGROUND_CONTEXT);

	// 巡检在恢复之前：规格要求「恢复前不执行任何处理器」
	const recovery = await recover(runtime, BACKGROUND_CONTEXT);

	registry.install(COMPANY_TASKS_EXTENSION);
	const escalationTask = createEscalationTask(runtime);
	registry.install({ name: "escalation", tasks: [escalationTask] } as never);

	await bootstrapCompany(
		runtime,
		{
			companyName: args.company,
			registry,
			workspaceRoot: join(args.workspace, "projects"),
			defaultModel,
			modelCatalog: [...catalog],
			escalationTask,
		},
		BACKGROUND_CONTEXT,
	);

	return { runtime, parked: recovery.parkedTasks.map((task) => task.taskId) };
}

const booted = await openAndBoot();
let runtime = booted.runtime;

if (booted.parked.length > 0) {
	process.stderr.write(`检测到 ${booted.parked.length} 个受阻任务：${booted.parked.join(", ")}\n`);
}

// 崩溃自愈
watchForFailure(
	runtime,
	async () => {
		const reopened = await openAndBoot();
		runtime = reopened.runtime;
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

const server = await serve({ runtime, port: args.port });

process.stdout.write(`\n  一人公司 · 网页界面\n`);
process.stdout.write(`  ${server.url}\n`);
process.stdout.write(`  数据：${args.db}\n`);
process.stdout.write(`  模型：${defaultModel.provider}/${defaultModel.modelId}\n`);
process.stdout.write(`\n  按 Ctrl+C 退出（未完成的工作会保留）\n\n`);

// macOS 上自动打开浏览器，方便直接看
if (args.open && process.platform === "darwin") {
	execFile("open", [server.url], () => {
		// 打开失败无所谓，用户手点也行
	});
}

process.on("SIGINT", () => {
	void server.close().then(() => {
		process.stderr.write("\n已退出。\n");
		process.exit(0);
	});
});
