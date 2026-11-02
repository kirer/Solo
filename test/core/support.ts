/**
 * 测试脚手架：一个临时工作区 + 开库 + 装配 + 收尾。
 *
 * 二十来个文件原本各抄一遍 `mkdtemp` / `setupModels` / `openCore` / `afterEach`。
 * 抄错的代价没人看得见：漏关一个库、漏删一个目录，测试照样绿。
 * 这里只收**机械**部分 —— 每个文件建一个 sandbox，用它开库（可以重复开，模拟重启），
 * 在 `afterEach` 里 `cleanup()`。断言与「为什么」留在各自的文件里。
 *
 * 为什么不是全局 hook：一个文件能同时持有多个 sandbox（例如分别代表两个工作区），
 * 谁建的谁收，收的顺序也由文件决定。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, setupModels } from "../../src/core/runtime/index.ts";
import { openCore, type CoreRuntime } from "../../src/core/runtime/open.ts";
import type { ModelSetup } from "../../src/core/runtime/models.ts";
import { assembleCore, type CoreShell } from "../../src/shell/assemble.ts";
import { resolveLayout, type Layout } from "../../src/core/layout.ts";
import { seedPromptTemplates, seedTextFiles } from "../../src/shell/seed.ts";

/** `openCore` 的选项，除了 `databasePath` / `models` 由 sandbox 默认给。 */
type OpenOptions = Partial<Parameters<typeof openCore>[0]>;

/** 装配选项（装配函数自己的选项类型不外露，从签名里取）。 */
type AssembleOptions = Partial<Parameters<typeof assembleCore>[2]>;

export type Sandbox = {
	/** 用户根。成员、团队、技能、规矩在它下面。 */
	readonly root: string;
	readonly layout: Layout;
	/** 成员根（`userRoot/members`）。助理不在这里，在 `layout.assistantRoot`。 */
	readonly agentsRoot: string;
	readonly teamsRoot: string;
	/** 开一个库。同一个 sandbox 可以开多次（同一个 `databasePath` 就是「重启」）。 */
	open(options?: OpenOptions): Promise<CoreRuntime>;
	/** 装配。默认用 sandbox 的 `layout`，能被 options 覆盖。 */
	assemble(runtime: CoreRuntime, options?: AssembleOptions): Promise<CoreShell>;
	/** 播种提示词模板（只有要读提示词的测试需要）。 */
	seedTemplates(): Promise<void>;
	/** 关掉这里开过的所有库，再删掉整个工作区。可以重复调用。 */
	cleanup(): Promise<void>;
};

/** 建一个临时工作区。`teams/` 先建好：装配会扫它。 */
async function sandbox(prefix = "core-"): Promise<Sandbox> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	// 应用私有的东西落在 `.app/`，组织直接落在临时根里。
	const layout = resolveLayout({ appRoot: join(root, ".app"), userRoot: root });
	const agentsRoot = layout.membersRoot;
	const teamsRoot = layout.teamsRoot;
	await mkdir(layout.appRoot, { recursive: true });
	await mkdir(agentsRoot, { recursive: true });
	await mkdir(teamsRoot, { recursive: true });
	// 文案目录（`text/`）是装配时的必需输入：空目录会让工具描述变成空串。
	// 生产里由 `main.ts` 播种，测试里在这里播一次。
	await seedTextFiles(layout);

	const opened: CoreRuntime[] = [];
	let configured: ModelSetup | undefined;
	const setup = (): ModelSetup => (configured ??= setupModels(process.env, { settingsFile: layout.settingsFile }));

	return {
		root,
		layout,
		agentsRoot,
		teamsRoot,
		async open(options: OpenOptions = {}) {
			const runtime = await openCore({
				databasePath: layout.databasePath,
				registry: createRegistry(),
				...options,
				models: options.models ?? setup().models,
			});
			opened.push(runtime);
			return runtime;
		},
		async assemble(runtime: CoreRuntime, options: AssembleOptions = {}) {
			return assembleCore(runtime.harness, runtime.registry, { ...options, layout: options.layout ?? layout });
		},
		seedTemplates: () => seedPromptTemplates(layout),
		async cleanup() {
			for (const runtime of opened.splice(0).reverse()) await runtime.close().catch(() => undefined);
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** 一个文件里的 sandbox 集合：建的时候顺手记下，`afterEach` 里一次收完。 */
export type SandboxPool = {
	make(prefix?: string): Promise<Sandbox>;
	cleanup(): Promise<void>;
};

export function sandboxPool(): SandboxPool {
	const boxes: Sandbox[] = [];
	return {
		async make(prefix) {
			const box = await sandbox(prefix);
			boxes.push(box);
			return box;
		},
		async cleanup() {
			for (const box of boxes.splice(0).reverse()) await box.cleanup();
		},
	};
}
