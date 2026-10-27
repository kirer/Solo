/**
 * 新核心的启动入口。
 *
 * 用法：`npm run core -- --port 7790 --workspace workspace-core`
 *
 * 它做的事按顺序只有五件，没有第六件：
 * 1. 读设置里的模型；
 * 2. 打开库（`openCore`）；
 * 3. 装配组织（`assembleCore`：扫 `agents/` → 开会话 → 播种公司频道）；
 * 4. 起服务（`serveCore`）；
 * 5. 等 Ctrl-C。
 *
 * 与旧入口（`src/server/main.ts`）的差别：没有执行环境注册表、没有看门狗、
 * 没有崩溃自愈、没有 IM 出站。那些是旧核心为了在长跑中活下来攒的运维设施，
 * 新核心现在的目标只有一个：**能跑，能被人看见在跑什么**。
 */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../runtime/index.ts";
import { openCore, type CoreRuntime } from "../runtime/open.ts";
import { setupModels } from "../runtime/index.ts";
import { assembleCore, seedOwnerAssistant, type CoreShell } from "./assemble.ts";
import { serveCore, type CoreServer } from "./serve.ts";

type Args = {
	readonly port: number;
	readonly host: string;
	readonly workspace: string;
	/** 播种：如果 `agents/` 是空的，建一个「离老板最近的人」。 */
	readonly seed: boolean;
};

function parseArgs(argv: readonly string[]): Args {
	let port = 7790;
	let host = "127.0.0.1";
	let workspace = join(process.cwd(), "workspace-core");
	let seed = true;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = argv[index + 1];
		if (arg === "--port" && next !== undefined) {
			port = Number(next);
			index += 1;
		} else if (arg === "--host" && next !== undefined) {
			host = next;
			index += 1;
		} else if (arg === "--workspace" && next !== undefined) {
			workspace = next;
			index += 1;
		} else if (arg === "--no-seed") {
			seed = false;
		}
	}
	return { port, host, workspace, seed };
}

/** `agents/` 下有几个文件夹（有一个就算「已经有人了」，不再播种）。 */
async function agentCount(agentsRoot: string): Promise<number> {
	try {
		const entries = await readdir(agentsRoot, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).length;
	} catch {
		return 0;
	}
}

/**
 * 补漏扫描的间隔。选 5 分钟的理由：沉淀不是实时需求（一条结论晚 5 分钟进记忆没人受损），
 * 但太稀会让「负责人当时不在」的结论迟迟不被处理。
 */
const SETTLE_SWEEP_MS = 5 * 60 * 1000;

/**
 * 定时补漏：把「该沉淀但还没等到答复」的结论再问一次。
 *
 * 为什么需要它（`afterPost` 补不了的三种漏）：
 * 1. 一条 decision 发出时，负责人还没有会话（刚被 hire，名册还没落盘）；
 * 2. 进程崩在 `afterPost` 执行到一半；
 * 3. 负责人当时忙，`whenBusy:"followUp"` 排队后进程重启，队列丢了。
 *
 * 幂等靠两样东西：`settleProject` 里「已在等答复就不再问」，以及
 * `remember_project` 落盘时才推进游标（见 `project/settle.ts`）。
 */
function startSettleSweep(shell: CoreShell): NodeJS.Timeout {
	let busy = false;
	const timer = setInterval(() => {
		if (busy) return;
		busy = true;
		void shell
			.settleSweep()
			.then((report) => {
				for (const item of report.asked) {
					console.log(`[core] 补漏沉淀：${item.project} → ${item.to}（${item.count} 条）`);
				}
				for (const item of report.stranded) {
					console.log(`[core] 补漏沉淀：${item.project} 有 ${item.count} 条结论但没有能写的人`);
				}
			})
			.catch((error: unknown) => {
				console.error("[core] 补漏沉淀失败：", error);
			})
			.finally(() => {
				busy = false;
			});
	}, SETTLE_SWEEP_MS);
	// 定时器不该拖住进程退出。
	timer.unref();
	return timer;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const agentsRoot = join(args.workspace, "agents");
	const projectsRoot = join(args.workspace, "projects");
	const databasePath = join(args.workspace, "core.sqlite");
	await mkdir(agentsRoot, { recursive: true });
	await mkdir(projectsRoot, { recursive: true });

	if (args.seed && (await agentCount(agentsRoot)) === 0) {
		const slug = await seedOwnerAssistant(agentsRoot, { name: "助理" });
		console.log(`[core] 播种了「离老板最近的人」：agents/${slug}/identity.md`);
	}

	const models = setupModels(process.env, { workspace: args.workspace });
	const registry = createRegistry();
	let runtime: CoreRuntime | undefined;
	let shell: CoreShell | undefined;
	let server: CoreServer | undefined;

	const shutdown = async (signal: string): Promise<void> => {
		console.log(`\n[core] ${signal}，正在关闭…`);
		await server?.close();
		await shell?.close();
		await runtime?.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	try {
		runtime = await openCore({ databasePath, models: models.models, registry });
		shell = await assembleCore(runtime.harness, registry, {
			agentsRoot,
			projectsRoot,
			ownerName: "老板",
			defaultModel: models.defaultModel,
		});
		server = await serveCore({
			shell,
			models,
			port: args.port,
			host: args.host,
			workspace: args.workspace,
		});
		console.log(`[core] ${server.url}`);
		console.log(`[core] workspace: ${args.workspace}`);
			console.log(`[core] agents: ${(await shell.identities()).map((item) => item.slug).join(", ") || "（无）"}`);
		startSettleSweep(shell);
	} catch (error) {
		console.error("[core] 启动失败：", error);
		await server?.close().catch(() => undefined);
		await shell?.close().catch(() => undefined);
		await runtime?.close().catch(() => undefined);
		process.exit(1);
	}
}

await main();
