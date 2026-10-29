/**
 * 串行化提交：同一个进程里所有 `harness.commit` 排队跑。
 *
 * 为什么必须这么做：底层（chord）的文档代理用「读覆盖层」表达一次事务的读集。
 * 两个 commit 在**同一进程内并发**时，先完成的那次会让另一次手里的覆盖层失效，
 * 后者的提交抛 `Cannot use a settled overlay` —— 但**读是在抛错之前就写完了**。
 *
 * 症状（线上抓到两次）：agent 调 `say` 发了一句话，工具回一个错误，模型以为没发出去
 * 于是重发一遍 —— 频道里出现两条一模一样的消息。老板看到的是「他重复说话」，
 * 日志里看到的是一个底层错误，两边都对不上。
 *
 * 只锁 `postMessage` 不管用：同一个文档还会被别的路径写（补读标记、投影游标、
 * 占位吸收、通知 note）。所以把闸装在**唯一的写入口**上。
 *
 * 三条注意：
 *
 * 1. 用 `AsyncLocalStorage` 记录「我已经在一个 commit 里了」，嵌套调用直接放行 ——
 *    否则一次提交内部再提交会自己等自己，永久挂住。
 * 2. 队列只保证**顺序**，不保证吞吐：这是一人公司的写入量，串行的代价可以忽略。
 * 3. 失败不阻塞后面：每个 `tail` 都 `catch` 掉，一次提交报错不会让队列停摆。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Harness } from "./index.ts";

/** 标记「当前异步上下文已经在一次 commit 内部」。 */
const inside = new AsyncLocalStorage<true>();

/**
 * 把一个 harness 的 `commit` 包成进程内串行。其余成员原样透传。
 *
 * 返回的是 Proxy，不是副本：`harness` 的其它方法（`conversation` / `snapshot` /
 * `inspect` …）必须还是**同一个实例上**的方法，否则会话句柄对不上。
 */
export function serializedHarness<T extends Harness>(harness: T): T {
	let tail: Promise<unknown> = Promise.resolve();

	const run = <R>(operation: () => Promise<R>): Promise<R> => {
		// 已经在一次 commit 里：直接跑。这里不做真互斥，是为了避免自锁 ——
		// 真正的嵌套提交由文档层自己判错，不需要这层闸再参与。
		if (inside.getStore() === true) return operation();
		const next = tail.then(
			() => inside.run(true, operation),
			() => inside.run(true, operation),
		);
		tail = next.catch(() => undefined);
		return next;
	};

	return new Proxy(harness, {
		get(target, property, receiver) {
			if (property === "commit") {
				return (change: Parameters<Harness["commit"]>[0], context: Parameters<Harness["commit"]>[1]) =>
					run(() => target.commit(change, context));
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
