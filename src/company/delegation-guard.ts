/**
 * 同步转交的等待图。
 *
 * 背景：`delegate_to_role` / `delegate_to_leader` 是**同步**工具——调用方提交
 * 一条消息后 `await` 目标会话答复。两个会话互相转交时就会形成闭环：
 *
 *   CEO 等 CTO → CTO 等项目负责人 → 负责人又转交回 CTO（CTO 正忙，消息排队）
 *
 * 这个环一旦形成，三个会话都永远处于 running/waiting，老板的「立即处理」也
 * 因为 abort 要等 idle 而永远返回不了。
 *
 * 这里维护一张进程内的等待图：`waiter -> awaited`。进入一次同步转交前先
 * 检查「目标是否已经在直接或间接等我」，是则拒绝，让模型换异步路线，而不是
 * 把整台机器挂死。
 *
 * 单进程单库的部署模型下（见 ADR-020）内存图足够；进程重启后所有同步等待
 * 本来就会被底层标记为中断，图从空开始即可。
 */

/** 检测到循环等待。 */
export class DelegationCycleError extends Error {
	readonly path: readonly number[];

	constructor(path: readonly number[]) {
		super(`检测到互相等待：${path.join(" → ")}`);
		this.name = "DelegationCycleError";
		this.path = path;
	}
}

/**
 * 一次同步转交的默认等待上限（毫秒）。
 *
 * 为什么是 180 秒：一次转交里对方要跑完一轮完整生成（思考 + 若干工具调用）。
 * 真实库里 95 分位的单轮生成在 60–120 秒之间（含一次工具往返），180 秒给到 1.5–3 倍余量；
 * 再长就等于「界面卡住但什么都没发生」，而看门狗的 tool 阈值是 300 秒——
 * 转交的等待必须**短于**看门狗收尾的阈值，否则永远是看门狗先动手，
 * 模型拿不到「超时了，换条路」这个明确信号，只会看到工具被中断。
 */
export const DEFAULT_DELEGATION_TIMEOUT_MS = 180_000;

/** 同步转交等待超时。 */
export class DelegationTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`等待对方答复超过 ${Math.round(timeoutMs / 1000)} 秒，已放弃等待`);
		this.name = "DelegationTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

/**
 * 给一次同步等待加硬上限。
 *
 * 为什么必须有：ADR-025 只堵住了「环」和「目标正忙」两种死锁，还有第三种——
 * 目标接受了请求、但它的那一轮永远跑不完（工具中断后 `pi.generation` 停在
 * `waiting`）。这种情况下 `submission.wait()` 永不返回，调用方的工具任务
 * 就永远 `running`，整个会话看起来「正在忙」，后续派活全部排队。
 *
 * 超时只放弃**这一次等待**：已经投递出去的工作照旧在后台跑（ADR-005），
 * 不会因为调用方不等了而被撤销。调用方必须保证在 finally 里释放等待图。
 */
export async function waitWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number = DEFAULT_DELEGATION_TIMEOUT_MS,
	options: { readonly signal?: AbortSignal } = {},
): Promise<T> {
	// 超时后底层 Promise 仍在跑：挂一个空 catch，避免「未处理的拒绝」把进程带崩。
	promise.catch(() => undefined);

	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;

	try {
		return await new Promise<T>((resolve, reject) => {
			timer = setTimeout(() => reject(new DelegationTimeoutError(timeoutMs)), timeoutMs);
			// 超时定时器不该拖住进程退出（服务被 Ctrl+C 时能立刻走）
			(timer as { unref?: () => void }).unref?.();

			const signal = options.signal;
			if (signal !== undefined) {
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
			}

			promise.then(resolve, reject);
		});
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (onAbort !== undefined) options.signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * 强制释放某个调用方的等待边（诊断 / 超时兜底用）。
 *
 * 正常路径靠 `enterDelegation()` 返回的释放函数在 finally 里清；这里是
 * 「调用方已经不在等了，但边还挂着」的兜底，避免下一次转交被假环挡住。
 */
export function releaseDelegation(caller: number): void {
	waiting.delete(caller);
}

/** waiter 会话 → 它正在同步等待的会话。 */
const waiting = new Map<number, number>();

/**
 * 登记一次同步转交：`caller` 即将等待 `target`。
 *
 * - 有环时抛 {@link DelegationCycleError}，不改变等待图；
 * - 没有环时登记，并返回一个**必须**在 finally 里调用的释放函数。
 */
export function enterDelegation(caller: number, target: number): () => void {
	const cycle = findCycle(caller, target);
	if (cycle !== undefined) throw new DelegationCycleError(cycle);

	waiting.set(caller, target);
	return () => {
		// 同一会话可能连续转交多次：只删自己登记的那条边
		if (waiting.get(caller) === target) waiting.delete(caller);
	};
}

/** 当前等待图的只读快照（诊断与测试用）。 */
export function delegationWaits(): ReadonlyMap<number, number> {
	return new Map(waiting);
}

/** 清空等待图（仅测试用；正常运行由 release 函数维护）。 */
export function resetDelegationWaits(): void {
	waiting.clear();
}

/**
 * 如果 `caller` 等待 `target` 会形成环，返回闭环路径。
 *
 * 沿 `waiting` 从 target 往下走；走到 caller 说明 target 正在（间接）等我。
 */
function findCycle(caller: number, target: number): readonly number[] | undefined {
	if (caller === target) return [caller, target];

	const path: number[] = [caller, target];
	const seen = new Set<number>([caller, target]);
	let node = target;

	while (true) {
		const next = waiting.get(node);
		if (next === undefined) return undefined;

		path.push(next);
		if (next === caller) return path;
		// 走到一个已有的、与本次无关的环上：不会形成新的闭环
		if (seen.has(next)) return undefined;

		seen.add(next);
		node = next;
	}
}
