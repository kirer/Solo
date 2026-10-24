/**
 * 打开公司的唯一入口。
 *
 * 这是防腐层最重要的一块：所有对底层运行时的构造参数都在这里组装，
 * 上层拿到的是一个受限的、语义化的句柄。
 *
 * 设计要点（见 design.md 决策 1/8、ADR-001/002）：
 * - 存储固定为 SQLite：进程崩溃安全；JSONL 会把全部历史放内存，长跑必爆。
 * - 模型访问通过工厂传入，便于测试替换为 faux provider。
 * - 执行环境按会话缓存，关闭时统一清理。
 * - 错误上报统一转成本层的报告类型，不把底层类型泄漏出去。
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	type Harness,
	Harness as DurableHarness,
	type HarnessSettings,
	type ReportInfo,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createEnvironmentRegistry, type CwdResolver, type EnvironmentRegistry } from "./env.ts";
import type { Registry } from "./registry.ts";

/** 我们关心的失败类别，屏蔽底层报告类型的细节。 */
export type RuntimeReport =
	/** 整个运行时因存储错误失效。 */
	| { readonly kind: "runtime-failed"; readonly error: unknown }
	/** 任务出错但运行时仍可用。 */
	| { readonly kind: "task-failed"; readonly taskId: string; readonly taskKind: string; readonly error: unknown }
	/** 任务因反复崩溃被暂停，需要人工重试。 */
	| { readonly kind: "task-parked"; readonly taskId: string; readonly taskKind: string }
	/** 能力包（角色）里的代码出错。 */
	| { readonly kind: "extension-failed"; readonly extension: string; readonly error: unknown }
	/** 其它：宿主回调、监听器等。 */
	| { readonly kind: "other"; readonly error: unknown };

export type OpenCompanyOptions = {
	/** SQLite 文件路径。 */
	readonly databasePath: string;
	/** 模型访问。 */
	readonly models: Models;
	/** 能力注册表。 */
	readonly registry: Registry;
	/** 运行设置（排队策略、重启上限等）。 */
	readonly settings?: HarnessSettings;
	/** 会话没有显式工作目录时，从文档推导工作目录。 */
	readonly resolveCwd?: CwdResolver;
	/** 失败上报。 */
	readonly onReport?: (report: RuntimeReport) => void;
};

/** 打开后的公司运行时句柄。 */
export type CompanyRuntime = {
	/** 底层 harness。**仅供本层与 runtime 内部模块使用**，业务层不应直接触碰。 */
	readonly harness: Harness;
	/** 执行环境注册表。 */
	readonly environments: EnvironmentRegistry;
	/** 最近一次失败（若运行时已失效）。 */
	readonly failure: () => unknown;
	/** 关闭运行时：清理环境、关闭存储。未完成的工作保留至下次打开。 */
	close(context?: Context): Promise<void>;
};

/** 把底层报告翻译成本层的类别。 */
type Translated = {
	readonly kind: RuntimeReport["kind"];
	readonly taskId?: string;
	readonly taskKind?: string;
	readonly extension?: string;
};

function translate(info: ReportInfo): Translated {
	switch (info.type) {
		case "session_failed":
			return { kind: "runtime-failed" };
		case "task_faulted":
		case "task_error":
			return { kind: "task-failed", taskId: String(info.task.id), taskKind: info.task.kind };
		case "task_parked":
			return { kind: "task-parked", taskId: String(info.task.id), taskKind: info.task.kind };
		case "extension_error":
			return info.extension === undefined
				? { kind: "extension-failed" }
				: { kind: "extension-failed", extension: info.extension };
		case "migration_failed":
		case "task_outdated":
			return { kind: "task-failed", taskId: String(info.task.id), taskKind: info.task.kind };
		default:
			return { kind: "other" };
	}
}

/**
 * 打开公司运行时。
 *
 * 幂等性由底层保证：同一存储重复打开返回同一个根会话（见 company-runtime 规格）。
 */
export async function openCompany(options: OpenCompanyOptions, context: Context = BACKGROUND_CONTEXT): Promise<CompanyRuntime> {
	const environments = createEnvironmentRegistry(options.resolveCwd);
	let failure: unknown;

	const harness = await DurableHarness.open(
		await openNodeSqliteStorage(options.databasePath),
		{
			models: options.models,
			registry: options.registry,
			...(options.settings === undefined ? {} : { settings: options.settings }),
			env: (target, envContext) => environments.factory(target, envContext),
			onReport: (error, info) => {
				const translated = translate(info);
				if (translated.kind === "runtime-failed") failure = error;
				options.onReport?.(buildReport(translated, error));
			},
		},
		context,
	);

	// 底层在因存储故障关闭时会自我关闭；这里把错误记下来，供宿主决定是否重开。
	void harness.closed.then((end) => {
		if (end.reason === "failed") failure = end.error;
	});

	return {
		harness,
		environments,
		failure: () => failure,
		async close(closeContext: Context = BACKGROUND_CONTEXT): Promise<void> {
			await environments.cleanup(closeContext);
			await harness.close(closeContext);
		},
	};
}

function buildReport(translated: Translated, error: unknown): RuntimeReport {
	switch (translated.kind) {
		case "runtime-failed":
			return { kind: "runtime-failed", error };
		case "task-failed":
			return {
				kind: "task-failed",
				taskId: translated.taskId ?? "?",
				taskKind: translated.taskKind ?? "?",
				error,
			};
		case "task-parked":
			return { kind: "task-parked", taskId: translated.taskId ?? "?", taskKind: translated.taskKind ?? "?" };
		case "extension-failed":
			return { kind: "extension-failed", extension: translated.extension ?? "?", error };
		default:
			return { kind: "other", error };
	}
}
