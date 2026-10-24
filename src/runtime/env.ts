/**
 * 执行环境工厂。
 *
 * 底层库每次工具调用、每次职责描述渲染都要构建执行环境。重复创建会带来可观的
 * 系统开销（进程、文件句柄），所以按会话缓存实例（见 design.md 决策 8）。
 *
 * 没有工作目录的会话返回 undefined —— 此时内置文件工具会返回错误结果，
 * 而不会退化为使用进程当前目录（见 company-runtime 规格）。
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { isAbsolute, resolve } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/** 底层传入的环境构建目标（只声明我们实际用到的字段）。 */
export type EnvironmentTarget = {
	readonly conversationId: number;
	readonly cwd?: string | undefined;
};

/** 从文档推导工作目录的回调；返回 undefined 表示该会话没有工作空间。 */
export type CwdResolver = (target: EnvironmentTarget, context: Context) => Promise<string | undefined>;

export type EnvironmentFactory = (
	target: EnvironmentTarget,
	context: Context,
) => Promise<NodeExecutionEnv | undefined>;

export type EnvironmentRegistry = {
	readonly factory: EnvironmentFactory;
	/** 让某个会话的缓存失效（工作目录变更后调用）。 */
	invalidate(conversationId: number): void;
	/** 清理全部环境；运行时关闭时调用。 */
	cleanup(context?: Context): Promise<void>;
};

/**
 * 把会话工作目录规整成绝对路径。
 *
 * 底层的 `NodeExecutionEnv` 会把 `cwd` 当作「相对进程目录的路径」再解析一次：
 * 执行 bash 时 `resolve(this.cwd)`，也就是说相对 cwd 会被拼上进程目录。
 * 我们若把登记表里的相对路径（例如 `workspace/company-empty/projects/x`）
 * 原样交下去，最终目录变成 `<进程目录>/<相对路径>/<相对路径>`，永远不存在，
 * 表现为所有命令都报 `Working directory does not exist`，连 `echo` 都跑不了
 * （真实事故：员工三人全部无法执行任何命令）。
 *
 * 所以入口处统一 resolve 一次：绝对路径原样不动，相对路径按进程目录解析。
 */
function normalizeCwd(cwd: string): string {
	return isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd);
}

/**
 * 创建按会话缓存的执行环境工厂。
 *
 * @param resolveCwd 会话没有显式工作目录时，用它从文档推导。
 */
export function createEnvironmentRegistry(resolveCwd?: CwdResolver): EnvironmentRegistry {
	const cache = new Map<number, NodeExecutionEnv>();

	const factory: EnvironmentFactory = async (target, context) => {
		const cached = cache.get(target.conversationId);
		if (cached !== undefined) return cached;

		const raw = target.cwd ?? (await resolveCwd?.(target, context));
		if (raw === undefined || raw === "") return undefined;
		const cwd = normalizeCwd(raw);

		const env = new NodeExecutionEnv({ cwd });
		cache.set(target.conversationId, env);
		return env;
	};

	const invalidate = (conversationId: number): void => {
		const env = cache.get(conversationId);
		if (env === undefined) return;
		cache.delete(conversationId);
		void env.cleanup(BACKGROUND_CONTEXT).catch(() => undefined);
	};

	const cleanup = async (context: Context = BACKGROUND_CONTEXT): Promise<void> => {
		const envs = [...cache.values()];
		cache.clear();
		await Promise.all(envs.map((env) => env.cleanup(context).catch(() => undefined)));
	};

	return { factory, invalidate, cleanup };
}
