/**
 * 打开「一个库 + 一个 harness」的唯一入口。
 *
 * 这里刻意只做三件事：打开存储、建 harness、返回关闭句柄。不做执行环境缓存、
 * 不做失败扫描、不做 WAL 巡检 —— 那是运维外壳的职责，不该出现在核心的启动路径里。
 */
import type { Models } from "@earendil-works/pi-ai";
import { Harness as DurableHarness, type Harness, type HarnessSettings } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Registry } from "@earendil-works/pi-durable";

export type OpenCoreOptions = {
	/** SQLite 文件路径。 */
	readonly databasePath: string;
	/** 模型访问。 */
	readonly models: Models;
	/** 能力注册表（新核心只装一个「基础能力包」）。 */
	readonly registry: Registry;
	/** 底层运行设置。 */
	readonly settings?: HarnessSettings;
};

export type CoreRuntime = {
	readonly harness: Harness;
	readonly registry: Registry;
	readonly close: (context?: Context) => Promise<void>;
};

/**
 * 把数据库里「进行中」的僵尸 task 结算成 terminal。
 *
 * 为什么要这里做：`Harness.open` 会恢复未完成的任务。一次 `kill -9`（或任何没走
 * `harness.close` 的退出）会把正在跑的 task 留在 `running` / `waiting` 状态，且它
 * 的 `record.state` 与底层调度器的调用记录自相矛盾。Harness 一恢复就抛
 * `Task N invocation has ended`，整个进程崩——而且库已经脏，下次启动照样崩。
 *
 * 修法：在 `Harness.open` 之前，用底层 `node:sqlite` 直接把这种 task 标成 `terminal`
 * （`state.status = "terminal"` + `outcome`），让 Harness 看到的是「已结束」状态，
 * 不再触发恢复崩溃。这是自愈：被强杀过的库下次启动自动修好，不用手动清库。
 *
 * 只读底层 storage、不调用 pi-durable，边界清晰；文件不存在（全新库）时静默跳过。
 */
function reconcileZombieTasks(databasePath: string): void {
	let connection: DatabaseSync | undefined;
	try {
		connection = new DatabaseSync(databasePath, { open: true });
		// 任何「非终态」的 task 都是僵尸（被强杀留下）：running / waiting / parked /
		// queued / blocked 等，一律结算成 terminal，避免 Harness.open 恢复时崩。
		const rows = connection
			.prepare(
				"SELECT id, record FROM tasks WHERE status NOT IN ('terminal', 'orphaned')",
			)
			.all() as { id: number; record: string }[];
		for (const row of rows) {
			let parsed: Record<string, unknown> | undefined;
			try {
				parsed = JSON.parse(row.record) as Record<string, unknown>;
			} catch {
				parsed = undefined;
			}
			if (parsed !== undefined) {
				const state = (parsed.state ?? {}) as Record<string, unknown>;
				if (state.status === "terminal") continue;
				parsed.state = { ...state, status: "terminal" };
				parsed.record_terminalAt = parsed.record_terminalAt ?? Date.now();
				connection
					.prepare("UPDATE tasks SET status = 'terminal', record = ? WHERE id = ?")
					.run(JSON.stringify(parsed), row.id);
			} else {
				connection.prepare("UPDATE tasks SET status = 'terminal' WHERE id = ?").run(row.id);
			}
		}
	} catch {
		// 库不存在 / 表还没建 / 损坏 —— 都交给 Harness.open 去报错，这里不挡启动。
	} finally {
		connection?.close();
	}
}

export async function openCore(options: OpenCoreOptions, context: Context = BACKGROUND_CONTEXT): Promise<CoreRuntime> {
	const storage = await openNodeSqliteStorage(options.databasePath);
	// 自愈：把被强杀（`kill -9`）残留在「进行中」的僵尸 task 就地结算成 terminal，
	// 再交给 Harness.open。否则 Harness 恢复未完成任务时，状态自相矛盾会抛
	// `Task N invocation has ended` 让整个进程崩溃，且下次启动依旧崩（脏库）。
	// 直接用底层 sqlite 改 tasks 表，不依赖 pi-durable 的私有恢复逻辑。
	reconcileZombieTasks(options.databasePath);
	const harness = await DurableHarness.open(
		storage,
		{
			models: options.models,
			registry: options.registry,
			...(options.settings === undefined ? {} : { settings: options.settings }),
		},
		context,
	);
	return {
		harness,
		registry: options.registry,
		close: (ctx?: Context) => harness.close(ctx ?? context),
	};
}
