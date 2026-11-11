/**
 * 「补一页」的排队闸门。
 *
 * 补历史是一页一页的动作（`loadEarlier` 一次只拉一页）。但触发点有很多：`scroll`、
 * `wheel`、每帧兜底、首帧落点 —— 同一次用户动作会被好几个触发点看见。如果「正在补」
 * 期间的请求直接丢掉，用户停在那儿界面就不动了；如果每个都发出去，就会一次灌进几千条。
 *
 * 这里把它变成「一次只跑一个」：正在补的时候再来的请求只记一笔「还欠」，不并发。
 * 这一页回来后要不要接着跑欠的那笔，由 `shouldContinue` 说了算 —— **默认不跑**。
 * 单独一个文件是为了能直接测：纯逻辑，不碰 DOM、不碰 store。
 */
export type LoadQueue = {
	/** 请求补一页。正在补就记一笔「还欠」，等这一页回来再跑。 */
	want: () => void;
	/** 还有没有没跑的请求。 */
	busy: () => boolean;
};

/**
 * @param load 真正去补一页的东西，resolve 就代表这一页已经落进 store 了。
 * @param shouldContinue 这一页回来之后还要不要接着补。**默认不补** —— 一次只给一页，
 *   下一次得有人重新「要」。「还欠就跑」那种写法会让一次贴顶把上面几千条全灌进来。
 */
export function createLoadQueue(load: () => Promise<void>, shouldContinue: () => boolean = () => false): LoadQueue {
	let running = false;
	let owed = false;
	const queue: LoadQueue = {
		want: (): void => {
			if (running) {
				owed = true;
				return;
			}
			running = true;
			owed = false;
			void (async () => {
				try {
					await load();
				} catch (error) {
					// 一页没拉到不该把闸门卡死。报一声，接着看下一次还叫不叫得动。
					console.error("[stream] 补历史这一页没拉到", error);
				} finally {
					running = false;
					if (owed && shouldContinue()) {
						owed = false;
						queue.want();
					} else {
						owed = false;
					}
				}
			})();
		},
		busy: (): boolean => running || owed,
	};
	return queue;
}
