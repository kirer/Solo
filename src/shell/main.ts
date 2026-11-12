/**
 * 新核心的启动入口。
 *
 * 用法：`npm start`（`--port 7788 --host 127.0.0.1 --app-root ./.solo-app --user-root ~/.solo`）
 *
 * 它做的事按顺序只有五件，没有第六件：
 * 1. 读设置里的模型；
 * 2. 打开库（`openCore`，它顺带做一次启动自愈）；
 * 3. 装配组织（`assembleCore`：扫两个根里的身份 → 开会话 → 播种全员频道）；
 * 4. 起服务（`serveCore`）；
 * 5. 等 Ctrl-C。
 *
 * 已经有的：执行环境（`run` 工具，就是 shell）、启动自愈（`open.ts` 把强杀留下的
 * 半截任务树结算成 `terminal`）、收尾（`channel/turn/finish.ts`：结算 done 后，没被 `say` 说出来的最终回答自动成消息）。
 *
 * 刻意没有的：看门狗（定时巡检卡住的人）、崩溃后自动重跑、IM 出站、成本核算。
 * 目标只有一个：**能跑，能被人看见在跑什么**。加回任何一样之前先问
 * 「不修它，系统会不会停摆」，答案是否就别加。
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { createRegistry } from "../core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../core/runtime/open.ts";
import { setupModels, compactionSettings } from "../core/runtime/index.ts";
import { createDiag } from "../app/diag.ts";
import { wipeAll } from "../app/reset.ts";
import { assembleCore, type CoreShell } from "./assemble.ts";
import { createDesktopActor } from "./wire/system.ts";
import { isShippedPlugin, markRemoved, removedPlugins, restorePlugin, seedOwnerAssistant, seedPlugins, seedPromptTemplates, seedRules, seedTextFiles, syncAllSkills } from "./seed.ts";
import { downloadRemotePlugin, ensureDownloadablePlugins, remotePluginStatuses } from "./plugin-download.ts";
import { createFsx } from "../core/fsx.ts";
import { loadTextCatalog } from "../core/documents/base/catalog.ts";
import { loadTemplates, PROMPT_DIR } from "../core/documents/base/template.ts";
import { ensureDir, existsAt, listDirSorted, watchDirAt } from "../core/runtime/io.ts";
import { resolveLayout, type Layout } from "../core/layout.ts";
import { migrateWorkspace } from "./migrate.ts";
import { serveCore, type CoreServer } from "./serve.ts";

/** 重置 / 重启完成后用这个退出码退出；桌面壳（`desktop/src/backend.ts`）认它，收到就重开。 */
const RELAUNCH_EXIT_CODE = 75;

type Args = {
	readonly port: number;
	readonly host: string;
	/** 应用私有目录：助理、提示词、插件、配置、库、附件、日志。 */
	readonly appRoot: string;
	/** 我的组织：成员、团队、技能、规矩。 */
	readonly userRoot: string;
	/** 播种：两个根里一个人都没有时，建一个「离我最近的人」。 */
	readonly seed: boolean;
};

function parseArgs(argv: readonly string[]): Args {
	try {
		const { values } = parseNodeArgs({
			args: [...argv],
			options: {
				port: { type: "string" },
				host: { type: "string" },
				"app-root": { type: "string" },
				"user-root": { type: "string" },
				"no-seed": { type: "boolean" },
			},
			strict: true,
		});
		return {
			port: values.port === undefined ? 7788 : Number(values.port),
			host: values.host ?? "127.0.0.1",
			appRoot: values["app-root"] ?? join(process.cwd(), ".solo-app"),
			userRoot: values["user-root"] ?? join(homedir(), ".solo"),
			seed: values["no-seed"] !== true,
		};
	} catch (error) {
		console.error(`[core] 参数不对：${(error as Error).message}`);
		console.error(
			"用法：npm start -- [--port 7788] [--host 127.0.0.1] [--app-root ./.solo-app] [--user-root ~/.solo] [--no-seed]",
		);
		process.exit(2);
	}
}

/** 两个根里一共几个人（有一个就算「已经有人了」，不再播种）。 */
async function agentCount(layout: Layout): Promise<number> {
	const counts = await Promise.all(
		layout.agentRoots.map(async (root) => (await listDirSorted(root)).filter((entry) => entry.kind === "dir").length),
	);
	return counts.reduce((total, count) => total + count, 0);
}


/**
 * 源码仓库在哪：`<repo>/src/shell/main.ts` 往上两级就是仓库根。
 *
 * 为什么用 `import.meta.url` 而不是 `process.cwd()`：桌面壳从 `/Applications` 启动，
 * cwd 是 `/`，拿 cwd 猜仓库会猜到一个八竿子打不着的地方 —— 猜错的后果是「仓库相对路径
 * 点开全变找不到」，而且一声不响。装好的应用里这两级是 `Resources/app/`，那里就是
 * 源码树，同一个算法照样对。只有 `.git` 在才算数，别的（散装目录）不当仓库根。
 *
 * 找不着就返回 `undefined`：`files.preview` 退回只认两个根，别拿一个瞎猜的目录当根。
 */
async function projectRootOf(): Promise<string | undefined> {
	const here = fileURLToPath(new URL("../..", import.meta.url));
	try {
		const info = await stat(join(here, ".git"));
		return info.isDirectory() || info.isFile() ? here : undefined;
	} catch {
		return undefined;
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const projectRoot = await projectRootOf();
	const layout = resolveLayout({ appRoot: args.appRoot, userRoot: args.userRoot, projectRoot });
	await ensureDir(layout.assistantRoot);
	await ensureDir(layout.membersRoot);
	await ensureDir(layout.teamsRoot);
	// 先把磁盘上的旧形状改写掉，再播种、装配：读的代码只认一种形状。
	const migrated = await migrateWorkspace(layout);
	if (migrated.length > 0) console.log(`[core] 迁移了身份头：${migrated.join("、")}`);

	if (args.seed) {
		// 规矩与全员层技能**每次启动都同步**（不是「只在空工作区」）：它们是全员共用的文件，
		// 以前只在空工作区拷一次，于是「先给结论」「不回错频道」这类修正永远进不了已在跑的
		// 工作区。同步按 hash 判断用户改过没有，改过的不动（ADR-031）。
		const rules = await seedRules(layout);
		if (rules === "written") console.log(`[core] 写入了全员规矩：${layout.rulesFile}`);
		if (rules === "updated") console.log(`[core] 升级了全员规矩：${layout.rulesFile}`);
		// 提示词模板同理：缺哪一段补哪一段，改过的不动。
		const templates = await seedPromptTemplates(layout);
		if (templates.length > 0) console.log(`[core] 同步了提示词模板：${templates.join("、")}`);
		// 工具描述与拒绝话术同理：缺哪份补哪份，改过的不动。
		const texts = await seedTextFiles(layout);
		if (texts.length > 0) console.log(`[core] 补进了文案：${texts.join("、")}`);
		const synced = await syncAllSkills(layout);
		const touched = [...synced.copied, ...synced.updated];
		if (touched.length > 0) console.log(`[core] 同步了全员层技能：${touched.join("、")}`);
		// 出厂插件只在缺失时整份拷进来：插件是可以执行的代码，动过就归改的人。
		const plugins = await seedPlugins(layout);
		if (plugins.length > 0) console.log(`[core] 装上了出厂插件：${plugins.join("、")}`);
		// 出厂但在包外的两个插件（`Token统计`、`模型管理`）：缺了才去线上取。
		// **不 await**：断网时不能拿下载拖住启动，失败只留状态，界面给「重试」。
		void ensureDownloadablePlugins(layout)
			.then((done) => {
				if (done.length > 0) console.log(`[core] 联网装上了出厂插件：${done.join("、")}`);
			})
			.catch((error: unknown) => {
				console.warn(`[plugin] 联网补插件失败：${error instanceof Error ? error.message : String(error)}`);
			});
	}

	// 启动自检：提示词与技能里都写着「什么该记、什么时候整理看技能『记忆整理』」。
	// 那份技能不在工作区，整理就会变成「模型凭自己想法整理」—— 静默降级，没人知道。
	if (!(await existsAt(join(layout.skillsRoot, "记忆整理", "SKILL.md")))) {
		console.warn("[core] 全员技能「记忆整理」不在用户目录：整理记忆会读不到规矩（重新启动一次，或看 seed/skills/ 是否缺失）");
	}

	if (args.seed && (await agentCount(layout)) === 0) {
		const slug = await seedOwnerAssistant(layout);
		console.log(`[core] 播种了「助手」：assistant/${slug}/identity.md`);
	}

	// 播种之后立刻断言：system 模板一段都没有 = 播种或部署坏了。
	//
	// 不放在 `assembleCore` 里：测试故意在空 workspace 上装配（那是它们在测的东西），
	// 放进去会一次红 55 条。生产入口只有一个，在这里拦就够了。症状本来也很难查 ——
	// agent 醒过来不知道自己是谁，却照样能说话、能干活，看起来像模型变笨了。
	const systemTemplates = (await loadTemplates(createFsx(layout.appRoot), PROMPT_DIR)).filter(
		(template) => template.use === "system",
	);
	if (systemTemplates.length === 0) {
		throw new Error(
			`提示词模板一段都没有：${layout.promptRoot}（播种没跑，或者部署漏了 seed/prompt/）`,
		);
	}

	// 文案同理：目录是空的，模型读到的工具描述就是 `hire.fire.done` 这种键名。
	const text = await loadTextCatalog(createFsx(layout.appRoot));
	if (text.keys().length === 0) {
		throw new Error(`文案目录是空的：${layout.textRoot}（播种没跑，或者部署漏了 seed/text/）`);
	}

	const models = setupModels(process.env, { settingsFile: layout.settingsFile });
	const registry = createRegistry();
	// 诊断出口必须在 `openCore` **之前**建：底座的运行报告要写进同一个实例，
	// 才能和 `GET /api/diag` 看到的是同一条。
	const diag = createDiag(layout.logsRoot);
	let runtime: CoreRuntime | undefined;
	let shell: CoreShell | undefined;
	let server: CoreServer | undefined;
	let stopWatching: () => void = () => undefined;
	let pending: ReturnType<typeof setTimeout> | undefined;
	let exiting = false;

	/**
	 * 服务、库按依赖顺序收干净。重启与重置共用；重置要在这一步之后才删盘。
	 *
	 * 库只由运行时关（`shell` 与 `runtime` 拿的是同一个 harness）：两处都关是
	 * 同一件事做两遍，第二次会在已经关掉的库上再退一遍。
	 */
	const stopCore = async (): Promise<void> => {
		clearTimeout(pending);
		stopWatching();
		await server?.close();
		await runtime?.close();
	};

	const shutdown = async (signal: string): Promise<void> => {
		if (exiting) return;
		exiting = true;
		console.log(`\n[core] ${signal}，正在关闭…`);
		await stopCore();
		process.exit(0);
	};

	/**
	 * 重启：插件的前端入口只在界面启动时 import，装完带界面的插件得重来一遍。
	 * 退出码与重置相同，桌面壳收到就重开整个应用。
	 */
	const restartApp = (): void => {
		if (exiting) return;
		exiting = true;
		// 谁点的：`/api/restart` 只有界面在调（装完带界面的插件 / 设置里的重启）。
		console.log("[core] 重启：正在关闭…（来源=界面 POST /api/restart）");
		void stopCore()
			.then(() => {
				process.exit(RELAUNCH_EXIT_CODE);
			})
			.catch((error: unknown) => {
				console.error("[core] 重启失败：", error);
				process.exit(1);
			});
	};

	/**
	 * 重置：先把服务、库收干净，再删盘。库还开着的时候删不掉 `core.sqlite`，
	 * 所以删除不能放在接口 handler 里。删完退出，桌面壳会重开整个应用。
	 */
	const resetAll = (): void => {
		if (exiting) return;
		exiting = true;
		console.log("[core] 重置：清空所有数据…（来源=界面 POST /api/reset）");
		void (async () => {
			await stopCore();
			await wipeAll(layout);
			console.log("[core] 重置完成");
			process.exit(RELAUNCH_EXIT_CODE);
		})().catch((error: unknown) => {
			console.error("[core] 重置失败：", error);
			process.exit(1);
		});
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	try {
		runtime = await openCore({
			databasePath: layout.databasePath,
			models: models.models,
			registry,
			// 压缩阈值跟着每个模型的真实上下文窗口走（默认值会让 1M 窗口永不触发）。
			settings: { compaction: compactionSettings(models.models) },
			onReport: (report) => diag.recordRuntimeReport(report),
		});
		shell = await assembleCore(runtime.harness, registry, {
			layout,
			...(models.defaultModel === undefined ? {} : { defaultModel: models.defaultModel }),
			...(models.agentModels === undefined ? {} : { agentModels: models.agentModels }),
			models: models.models,
			diag,
			// 出厂插件账本：删的时候记一笔、装回的时候读它。不给的话播种分不清
			// 「用户删的」和「意外丢的」，删掉的就永远补不回来了。
			seededPlugins: {
				markRemoved: (name) => markRemoved(layout, name),
				removed: () => removedPlugins(layout),
				restore: (name) => restorePlugin(layout, name),
				isShipped: (name) => isShippedPlugin(layout, name),
				// 改成首次联网下载的那两个：状态与重试都走 `plugin-download.ts`。
				remote: () => remotePluginStatuses(layout),
				download: (name) => downloadRemotePlugin(layout, name),
			},
			// 重启把谁的一轮掐断了：留痕 + 交给底座重放（ADR-044 / ADR-074）。
			interrupted: runtime.interrupted,
			// 排队输入却没有人来取：装配完发 continue 接上。
			backlog: runtime.backlog,
			// 桌面壳把 Electron 的 shell / clipboard 从父子管道递进来了（见 `wire/system.ts`）。
			// 网页版没有这根管子 → `undefined` → 插件的系统动作一律抛「这个宿主不支持」。
			...(process.env.SOLO_SYSTEM_BRIDGE === "1"
				? (() => {
						const actor = createDesktopActor();
						return actor === undefined ? {} : { system: actor };
					})()
				: {}),
		});
		server = await serveCore({
			shell,
			port: args.port,
			host: args.host,
			onReset: resetAll,
			onRestart: restartApp,
		});
		// 插件是磁盘上的一堆文件夹：改了就重装，不用重启（ADR-026）。
		// 防抖是因为一次保存常常连着好几个事件，而装到一半时文件还没写完。
		const reload = shell.reloadPlugins;
		stopWatching = watchDirAt(layout.pluginsRoot, () => {
			clearTimeout(pending);
			pending = setTimeout(() => {
				void Promise.resolve(reload?.()).catch((error: unknown) => {
					console.warn(`[plugin] 重装失败：${error instanceof Error ? error.message : String(error)}`);
				});
			}, 200);
		});
		console.log(`[core] ${server.url}`);
		console.log(`[core] 应用目录: ${layout.appRoot}`);
		console.log(`[core] 用户目录: ${layout.userRoot}`);
		console.log(`[core] agents: ${(await shell.identities()).map((item) => item.slug).join(", ") || "（无）"}`);
		// 没有模型不是「坏了」，是「还没配」：说清去哪儿配，别让人对着不说话的界面猜。
		if (models.defaultModel === undefined) {
			console.log(`[core] 还没有配置模型：设置 → 模型，或写 ${layout.settingsFile}。在那之前没人回得了话。`);
		}
	} catch (error) {
		console.error("[core] 启动失败：", error);
		await server?.close().catch(() => undefined);
		await runtime?.close().catch(() => undefined);
		process.exit(1);
	}
}

await main();
