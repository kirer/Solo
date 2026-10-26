/**
 * 等待原语的共享实现。
 *
 * 为什么单独一个文件：仓库里有好几处「等一个 promise，但绝不允许无限等」的
 * 场景——圆桌等参与者发言、HTTP 打断等 abort 收尾。它们各自抄了一份
 * `Promise.race` + `setTimeout` + `clearTimeout`，看上去一样但细节容易写错
 * （忘记清定时器会让进程多挂几秒；超时后不管被放弃的 promise 会变成
 * 「未处理的拒绝」把进程带崩）。
 *
 * 这里只放这一个原语。**不**把轮询、退避、重试也塞进来：那几种各有各的
 * 语义（见 `escalation.ts` 的 `pollDelay`），压成同一个抽象只会含混。
 */

/** 一次带超时的等待结果。 */
export type Waited<T> = { readonly timedOut: true } | { readonly timedOut: false; readonly value: T };

/**
 * 等一个 promise，超时返回 `{ timedOut: true }`。
 *
 * 被放弃的 promise 已经挂在 `Promise.race` 上，之后 reject 不会变成未处理拒绝。
 * `ms <= 0` 视为「不等」，但同样会给 promise 挂空 catch——调用方常常是
 * 「预算已经耗光了，只想收个尾」。
 */
export async function waitOrTimeout<T>(promise: Promise<T>, ms: number): Promise<Waited<T>> {
	if (ms <= 0) {
		promise.catch(() => undefined);
		return { timedOut: true };
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<Waited<T>>((resolve) => {
		timer = setTimeout(() => resolve({ timedOut: true }), ms);
	});
	try {
		const raced = await Promise.race([
			promise.then((value): Waited<T> => ({ timedOut: false, value })),
			timeout,
		]);
		return raced;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
