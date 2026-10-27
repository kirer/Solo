/**
 * 打开「一个库 + 一个 harness」的唯一入口。
 *
 * 这里刻意只做三件事：打开存储、建 harness、返回关闭句柄。不做执行环境缓存、
 * 不做失败扫描、不做 WAL 巡检 —— 那是运维外壳的职责，不该出现在核心的启动路径里。
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
	return {
		harness,
		registry: options.registry,
		close: (ctx?: Context) => harness.close(ctx ?? context),
	};
}
