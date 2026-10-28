/**
 * 打开「一个库 + 一个 harness」的唯一入口。
 *
 * 这里只做四件事：打开存储、建 harness、自愈脏数据、返回关闭句柄。
 */
import type { Models } from "@earendil-works/pi-ai";
import { Harness as DurableHarness, type Harness, type HarnessSettings } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
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
 * 自愈：把被 `kill -9`（或任何没走 `harness.close` 的退出）留下的脏数据修好。
 *
 * 根因（实测确诊）：
 * `Harness.open` 恢复任务时按 `tasks` 表的 `status` **列**扫描（pending/running/...）。
 * 一旦一个 task 的 `record.state.status` 已经是 `terminal`，但 `status` 列还停在
 * `running`，调度器就会把它当成「活着」去重放，于是抛
 * `Task N invocation has ended`，整个进程崩；而且库已脏，下次启动照样崩。
 *
 * 为什么旧方案（直接 `UPDATE tasks SET status='terminal'` 或 `reset()` 会话）都无效：
 * - 另一条 SQLite 连接改动会被 Harness 的连接/页缓存覆盖，等于没改（实测）。
 * - `harness.inspect()` 读的是调度器的**内存活映射**，open 之后还没 reconcile，里面是
 *   空的，所以基于 inspect 的 reset 永远看不到僵尸（实测：inspect().tasks 为空）。
 *
 * 修法：用 Harness 自己的 `storage.commit` 把每个 task 的整条记录原样重写一遍。
 * `storage.commit` 在写 `tasks` 表时会按 `record.state.status` **重新计算 `status` 列**，
 * 于是列与记录重新一致；这条写入走 Harness 自己的连接与事务，没有竞态。
 */
async function reconcileZombieTasks(
	harness: Harness,
	storage: Awaited<ReturnType<typeof openNodeSqliteStorage>>,
	context: Context,
): Promise<void> {
	// 调度器 open 时按这些列扫描「活着」的 task。逐列扫，覆盖一切可能残留的活状态。
	const LIVE_COLUMNS = ["pending", "running", "waiting", "sleeping", "completing"] as const;
	let fixed = 0;
	try {
		for (const status of LIVE_COLUMNS) {
			// 用 harness 自己的 tx 读，保证拿到的是存储里的真实记录（含 record.state）。
			const records = await harness.commit(
				async (tx) => {
					const page = await tx.scanTasks({ status }, 256, undefined);
					const full = [];
					for (const t of page.items) {
						const rec = await tx.task(t.id);
						if (rec !== undefined) full.push(rec);
					}
					return full;
				},
				context,
			);
			for (const rec of records) {
				const truth = rec.state?.status;
				// 列与记录不一致（脏数据），原样重写让列回到 truth。
				// 记录本身就是 terminal —— 重写后列变 terminal，调度器不再重放，崩溃消失。
				// 记录本身还活着 —— 同样重写（列本就一致，等于无害刷新），留给调度器正常 resume。
				if (truth === undefined) continue;
				await storage.commit([{ type: "task", value: rec }], context);
				fixed += 1;
			}
		}
		// 未结的 input submission（queued/placed）指向的 task 可能已经死了，留着会在
		// resume 时被重放。inspect 直接从存储扫 queued/placed，不依赖调度器内存映射，
		// 所以这里能拿到脏 submission，逐个撤销，避免半截输入再次触发僵尸链。
		const inspection = await harness.inspect(context);
		for (const sub of inspection.submissions) {
			if (sub.type === "input") {
				await harness.abortSubmission(sub.id, context, sub.conversationId).catch(() => undefined);
			}
		}
	} catch (error) {
		// 自愈失败也不要挡启动；最多下次还崩，但至少进程能起来，人能进界面手动处理。
		console.error("[reconcile] 跳过（不影响启动）：", (error as Error)?.message);
	}
	if (fixed > 0) console.error(`[reconcile] 已自愈 ${fixed} 条脏 task（列与记录不一致）`);
}

export async function openCore(options: OpenCoreOptions, context: Context = BACKGROUND_CONTEXT): Promise<CoreRuntime> {
	const storage = await openNodeSqliteStorage(options.databasePath);
	const harness = await DurableHarness.open(
		storage,
		{
			models: options.models,
			registry: options.registry,
			...(options.settings === undefined ? {} : { settings: options.settings }),
		},
		context,
	);
	// 自愈必须在 open 之后、装配之前：此时 Harness 已持有连接，用它的 storage.commit
	// 修复「列与记录不一致」的脏 task，才能根治 `Task N invocation has ended` 崩溃。
	await reconcileZombieTasks(harness, storage, context);
	return {
		harness,
		registry: options.registry,
		close: (ctx?: Context) => harness.close(ctx ?? context),
	};
}
