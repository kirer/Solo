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
