/**
 * 新核心的启动入口。
 *
 * 用法：`npm start`（`--port 7788 --host 127.0.0.1 --workspace workspace`）
 *
 * 它做的事按顺序只有五件，没有第六件：
 * 1. 读设置里的模型；
 * 2. 打开库（`openCore`，它顺带做一次启动自愈）；
 * 3. 装配组织（`assembleCore`：扫 `agents/` → 开会话 → 播种公司频道）；
 * 4. 起服务（`serveCore`）；
 * 5. 等 Ctrl-C。
 *
 * 已经有的：执行环境（`run` 工具，就是 shell）、启动自愈（`open.ts` 把强杀留下的
 * 半截任务树结算成 `terminal`）、答案兜底（`rescue.ts`：他答了但没调 `say` 时补发）。
 *
 * 刻意没有的：看门狗（定时巡检卡住的人）、崩溃后自动重跑、IM 出站、成本核算。
 * 目标只有一个：**能跑，能被人看见在跑什么**。加回任何一样之前先问
 * 「不修它，公司会不会停摆」，答案是否就别加。
 */
import { mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import { createRegistry } from "../runtime/index.ts";
import { openCore, type CoreRuntime } from "../runtime/open.ts";
import { setupModels, compactionSettings } from "../runtime/index.ts";
import { createDiag } from "../app/diag.ts";
import { assembleCore, type CoreShell } from "./assemble.ts";
import { seedOwnerAssistant, seedPromptTemplates, seedRules, syncCompanySkills } from "./seed.ts";
import { createFsx } from "../fsx.ts";
import { loadTemplates, PROMPT_DIR } from "../prompt.ts";
import { serveCore, type CoreServer } from "./serve.ts";

type Args = {
	readonly port: number;
	readonly host: string;
	readonly workspace: string;
	/** 播种：如果 `agents/` 是空的，建一个「离我最近的人」。 */
	readonly seed: boolean;
};

function parseArgs(argv: readonly string[]): Args {
	try {
		const { values } = parseNodeArgs({
			args: [...argv],
			options: {
				port: { type: "string" },
				host: { type: "string" },
				workspace: { type: "string" },
				"no-seed": { type: "boolean" },
			},
			strict: true,
		});
		return {
			port: values.port === undefined ? 7788 : Number(values.port),
			host: values.host ?? "127.0.0.1",
			workspace: values.workspace ?? join(process.cwd(), "workspace"),
			seed: values["no-seed"] !== true,
		};
	} catch (error) {
		console.error(`[core] 参数不对：${(error as Error).message}`);
		console.error("用法：npm start -- [--port 7788] [--host 127.0.0.1] [--workspace workspace] [--no-seed]");
		process.exit(2);
	}
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


async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const agentsRoot = join(args.workspace, "agents");
	const teamsRoot = join(args.workspace, "teams");
	const databasePath = join(args.workspace, "core.sqlite");
	await mkdir(agentsRoot, { recursive: true });
	await mkdir(teamsRoot, { recursive: true });

	if (args.seed) {
		// 规矩与公司层技能**每次启动都同步**（不是「只在空工作区」）：它们是公司发的文件，
		// 以前只在空工作区拷一次，于是「先给结论」「不回错频道」这类修正永远进不了已在跑的
		// 工作区。同步按 hash 判断用户改过没有，改过的不动（ADR-039）。
		const rules = await seedRules(args.workspace);
		if (rules === "written") console.log(`[core] 写入了工作区规矩：${join(args.workspace, "rules.md")}`);
		// 提示词模板同理：缺哪一段补哪一段，改过的不动。
		const templates = await seedPromptTemplates(args.workspace);
		if (templates.length > 0) console.log(`[core] 补进了提示词模板：${templates.join("、")}`);
		const synced = await syncCompanySkills(agentsRoot);
		const touched = [...synced.copied, ...synced.updated];
		if (touched.length > 0) console.log(`[core] 同步了公司层技能：${touched.join("、")}`);
	}

	// 启动自检：`team/memory.ts` 的沉淀指令让团队管理员 `skills(action=read, name="记忆整理")`，
	// 那份技能不在工作区，沉淀就会变成「模型凭自己想法整理」—— 静默降级，没人知道。
	if (!existsSync(join(args.workspace, "skills", "记忆整理", "SKILL.md"))) {
		console.warn("[core] 公司技能「记忆整理」不在工作区：团队记忆沉淀会读不到规矩（重新启动一次，或看 seed/skills/ 是否缺失）");
	}

	if (args.seed && (await agentCount(agentsRoot)) === 0) {
		const slug = await seedOwnerAssistant(agentsRoot);
		console.log(`[core] 播种了「离我最近的人」：agents/${slug}/identity.md`);
	}

	// 播种之后立刻断言：system 模板一段都没有 = 播种或部署坏了。
	//
	// 不放在 `assembleCore` 里：测试故意在空 workspace 上装配（那是它们在测的东西），
	// 放进去会一次红 55 条。生产入口只有一个，在这里拦就够了。症状本来也很难查 ——
	// agent 醒过来不知道自己是谁，却照样能说话、能干活，看起来像模型变笨了。
	const systemTemplates = (await loadTemplates(createFsx(args.workspace), PROMPT_DIR)).filter(
		(template) => template.use === "system",
	);
	if (systemTemplates.length === 0) {
		throw new Error(
			`提示词模板一段都没有：${join(args.workspace, PROMPT_DIR)}（播种没跑，或者部署漏了 seed/prompt/）`,
		);
	}

	const models = setupModels(process.env, { workspace: args.workspace });
	const registry = createRegistry();
	// 诊断出口必须在 `openCore` **之前**建：底座的运行报告要写进同一个实例，
	// 才能和 `GET /api/diag` 看到的是同一条。
	const diag = createDiag(args.workspace);
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
		runtime = await openCore({
			databasePath,
			models: models.models,
			registry,
			// 压缩阈值跟着每个模型的真实上下文窗口走（默认值会让 1M 窗口永不触发）。
			settings: { compaction: compactionSettings(models.models) },
			onReport: (report) => diag.recordRuntimeReport(report),
		});
		shell = await assembleCore(runtime.harness, registry, {
			agentsRoot,
			teamsRoot,
			defaultModel: models.defaultModel,
			diag,
		});
		server = await serveCore({
			shell,
			port: args.port,
			host: args.host,
		});
		console.log(`[core] ${server.url}`);
		console.log(`[core] workspace: ${args.workspace}`);
		console.log(`[core] agents: ${(await shell.identities()).map((item) => item.slug).join(", ") || "（无）"}`);
	} catch (error) {
		console.error("[core] 启动失败：", error);
		await server?.close().catch(() => undefined);
		await shell?.close().catch(() => undefined);
		await runtime?.close().catch(() => undefined);
		process.exit(1);
	}
}

await main();
