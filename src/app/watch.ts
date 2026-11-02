/**
 * 看门狗：底座报上来的异常，别再只躺在 `logs/runtime.jsonl` 里。
 *
 * 为什么不是一个人（一个 agent）：要看的东西（任务被挂起、会话失败、迁移失败）都是**机械
 * 判据**，代码本来就看得见，不需要模型来判断。做成人的代价是每次醒来都烧 token，而它
 * 99% 的时候只会说「一切正常」—— 那正是最该省掉的那种消息。
 *
 * 所以这里只有一件事：异常报告一到，在全员频道留一条 `note`。看见了才谈得上处理，
 * 而「看见了也不会自动救」是这个阶段的自觉取舍（`docs/CORE.md` §12）。
 */

/** 两条通报之间至少隔这么久：一个坏循环能连着报几十条，别让它刷屏。 */
const DEFAULT_GAP_MS = 10 * 60_000;

export type WatchDeps = {
	/** 订阅异常报告（`text` 已经是人话）；返回退订函数。 */
	readonly onAbnormal: (listener: (report: { readonly text: string }) => void) => () => void;
	/** 把一句话说进频道（系统留痕，不叫醒人）。 */
	readonly notify: (text: string) => Promise<void>;
	/** 现在几点（测试用）。 */
	readonly now?: () => number;
	readonly gapMs?: number;
};

export function createWatch(deps: WatchDeps) {
	const gap = deps.gapMs ?? DEFAULT_GAP_MS;
	let lastAt = Number.NEGATIVE_INFINITY;
	let unsubscribe: (() => void) | undefined;

	function start(): void {
		if (unsubscribe !== undefined) return;
		unsubscribe = deps.onAbnormal((report) => {
			const now = deps.now?.() ?? Date.now();
			if (now - lastAt < gap) return;
			lastAt = now;
			// 通报失败只写 stderr：看门狗自己出事，不该再制造一次事故。
			void deps.notify(`底座报告：${report.text}`).catch((error: unknown) => {
				process.stderr.write(`[看门狗] 通报失败：${error instanceof Error ? error.message : String(error)}\n`);
			});
		});
	}

	function stop(): void {
		unsubscribe?.();
		unsubscribe = undefined;
	}

	return { start, stop };
}
