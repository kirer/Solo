/**
 * 滚动位置的仲裁者 —— 「人在动」这件事到底怎么认（2026-11-11 重做）。
 *
 * 这个文件**不碰 React、不碰 DOM 之外的任何东西**：给它一个 `Host`（几个数 + 一个写函数），
 * 它负责回答三件事：**谁在动、动了多久、这次动作该不该补页**。这样每一条都能在 node 里单测。
 *
 * 判法（设计 §1，季衡第一节）：**不问这是什么输入，只问「谁让这三个数变了」。**
 * 每帧取 `scrollTop` / `scrollHeight` / `clientHeight`：
 *
 *   - `scrollTop` 变了、**我们没写过**、另两个也没变 → 人在动；
 *   - 我们写过（写之前记了账，这次跳变认领掉）→ 程序位移，丢弃；
 *   - 内容高度变了 → 补偿/夹紧/浏览器行为，丢弃（这一支永远不触发补页）。
 *
 * 前三轮的死因正是：只在滚轮上认人（后两轮加了键盘），拖滚动条、浏览器夹紧、程序补偿
 * 全被当成「人在滚」，于是自己把循环接回去 —— 一次贴顶补到 5031 条。
 */

/** 位置稳定多久算「这次动作结束了」。 */
export const GESTURE_IDLE_MS = 200;
/** 两个位置之间小于这个差算没变（Retina 下 `scrollTop` 可以是小数）。 */
export const MOVE_EPSILON = 0.5;
/** 记账没被认领多久就作废（浏览器判「位置没变」不发 scroll 的那种情况）。 */
export const WRITE_TTL_MS = 300;
/** 一次动作结束、真的补过页之后，这个时间内再结算就跳过（保险丝，设计 §1.3）。 */
export const SETTLE_COOLDOWN_MS = 400;
/** 平滑滚动 / `scrollIntoView` 的认领有效期：一串我们没法的帧，认这么久就够。 */
const SMOOTH_TTL_MS = 800;
/** 每帧取样最多跑这么久就停，靠下一次用户输入重新起（设计 §1.2：不许长驻 rAF）。 */
export const SAMPLER_MAX_IDLE_MS = 500;

type Snap = { top: number; height: number; client: number };

/** 程序写一次 `scrollTop` 的记账。 */
export type ProgramWrite = { from: number; to: number; at: number };

/**
 * 仲裁者的输入：读三个数、写一次位置、以及「该补页了」的回调。
 *
 * 注意 `write` 是**唯一**允许给 `scrollTop` 赋值的地方 —— `Stream.tsx` 里不许出现第二处
 * （设计 §1.2，用测试钉住）。
 */
export type Host = {
	read(): Snap;
	write(top: number): void;
	now?: () => number;
};

export type Settle = {
	/** 结算时位置是不是贴顶（`top <= nearTop`）。 */
	atTop: boolean;
	atBottom: boolean;
	/** 这一次动作里位置总共被移动了多少（人给的量，正数=往下滚）。 */
	moved: number;
	/** 这次动作里人一共「往上」走子多远 —— 决定补页的方向（往上才补历史）。 */
	upTo: number;
};

export type Arbiter = {
	/** 每帧调一次（由 `Stream` 的 rAF 循环驱动）。返回这一帧是不是人在动。 */
	sample(): boolean;
	/** 程序写 `scrollTop`：**先记账再赋值，同一个同步块**。 */
	setScrollTop(target: number, reason: string): void;
	/**
	 * 认领一次「我们马上要做的、不是一步到位的写」（`scrollTo({behavior:"smooth"})`、
	 * `scrollIntoView` 都属于这一种：浏览器会连着写很多帧）。
	 *
	 * 只记账、不写。接下来的 `SMOOTH_TTL_MS` 内的跳变一律按「程序在动」处理。
	 */
	claim(): void;
	/** 用户动作结束后结算一次；返回 `null` = 这一帧不该结算（还在动 / 刚结算过）。 */
	settle(now?: number): Settle | null;
	/**
	 * 报一次「这一次结算真的发起补页了」。
	 *
	 * 保险丝（`SETTLE_COOLDOWN_MS`）只咬紧接着的下一次结算 —— 判据是「上一次结算补过页」。
	 * 不报就永不冷却；报错了会把用户下一次正常的补页吞掉，所以只在这一处报。
	 */
	noteFilled(): void;
	/** 现在是不是「一次动作」进行中。 */
	moving(): boolean;
	/** 距离最后一次「人在动」过去了多久（给 rAF 循环判断要不要停）。 */
	idleFor(now?: number): number;
	/** 认领了几次程序写入 —— 日志与单测的判据（设计 §1.4）。 */
	claimed(): number;
	/** 写了几次 —— 应该恒等于 `claimed() + 还没认领的笔数`。 */
	writes(): number;
	reset(): void;
};

export function createArbiter(host: Host, options: { nearTop?: number; nearBottom?: number } = {}): Arbiter {
	const nearTop = options.nearTop ?? 24;
	const nearBottom = options.nearBottom ?? 24;
	const now = host.now ?? (() => Date.now());

	let last: Snap = host.read();
	/**
	 * 我们写之后、**下一次取样之前**的那份读数。
	 *
	 * 不能直接把 `last` 改成「写完之后的状态」再指望下一帧认领：那样下一帧的比较基准
	 * 已经是写到的位置，`topChanged` 为假，这笔账永远没人认领，300ms 后过期 ——
	 * 于是「补偿被当成人」这个前几轮的死因会原样回来。
	 * 所以写完之后把基准定在**写之前**的 `top`，下一帧一定看到 `from → to` 的那次跳变。
	 */
	let pending: Snap | null = null;
	let writes: ProgramWrite[] = [];
	let writeCount = 0;
	let claimCount = 0;
	/** 平滑写的认领：这之前的所有跳变都算程序在动。 */
	let smoothUntil = Number.NEGATIVE_INFINITY;
	/** 一次平滑写没认领上就只丢这一笔，别让一条记账吃掉整串。 */
	let smoothBudget = 0;
	let lastMoveAt = now();
	let gestureStartTop = last.top;
	let gestureMoved = 0;
	let everMoved = false;
	let lastSettleAt = Number.NEGATIVE_INFINITY;
	let lastSettleFilled = false;

	const expire = (at: number): void => {
		writes = writes.filter((item) => at - item.at <= WRITE_TTL_MS);
	};

	/** 这一次动作的方向与净位移（正数=往下走了这么多，负数=往上）。 */
	const net = (): number => {
		if (!everMoved) return 0;
		return last.top - gestureStartTop;
	};

	const near = (): { atTop: boolean; atBottom: boolean } => ({
		atTop: last.top <= nearTop,
		atBottom: last.height - last.top - last.client <= nearBottom,
	});

	return {
		sample(): boolean {
			const at = now();
			// 注意顺序：**先认领、后清过期**。反过来会让「我们写的那次跳变来得慢一点」
			// 被当成人在滚 —— 那正是前几轮自己把循环接回去的形状。
			const next = host.read();
			// 有「我们刚写过」的基准就用它：保证下一帧能看到那次跳变。
			const prev = pending ?? last;
			pending = null;
			last = next;

			const topChanged = Math.abs(next.top - prev.top) >= MOVE_EPSILON;
			const layoutChanged = next.height !== prev.height || next.client !== prev.client;

			// 位置没动：什么都不用判，但「动作进行中」的状态由 `settle()` 按时间判结束。
			if (!topChanged) return false;

			// ① 我们写的：认领并丢弃。只认「从 from 到 to 的这一次跳变」。
			const match = writes.find((item) => Math.abs(next.top - item.to) < MOVE_EPSILON);
			if (match !== undefined) {
				writes = writes.filter((item) => item !== match);
				claimCount += 1;
				expire(at);
				return false;
			}
			// ①' 平滑写的认领：`scrollTo({behavior:"smooth"})` 的每一帧都是我们发起的。
			if (at <= smoothUntil && smoothBudget > 0) {
				smoothBudget -= 1;
				claimCount += 1;
				expire(at);
				return false;
			}
			// 没认领上：这时才清掉过期账（记账是「还没落地的写入」，过期就当浏览器没采纳）。
			expire(at);

			// ② 内容变了导致的位置变化（补偿、夹紧、浏览器自己收）：不补页。
			//    夹紧只发生在内容变短时，那时 height 一定一起变 —— 所以这条挡得住夹紧。
			if (layoutChanged) return false;

			// ③ 位置变了、不是我们写的、内容也没变 → 只能是人。
			if (!everMoved) {
				everMoved = true;
				gestureStartTop = prev.top;
				gestureMoved = 0;
			}
			gestureMoved += next.top - prev.top;
			lastMoveAt = at;
			return true;
		},

		setScrollTop(target: number, _reason: string): void {
			const at = now();
			const from = host.read().top;
			if (Math.abs(from - target) < MOVE_EPSILON) return; // 没动就别记账，否则会吞掉下一次人的滚动。
			writes.push({ from, to: target, at });
			writeCount += 1;
			host.write(target);
			// 记账和赋值在同一个同步块里完成（中间不许 await / rAF）。
			// 下一帧的比较基准停在**写之前**的位置，那次 from→to 的跳变才认领得到。
			pending = { top: from, height: last.height, client: last.client };
			last = { ...last, top: from };
		},

		claim(): void {
			smoothUntil = now() + SMOOTH_TTL_MS;
			// 一屏按 8~40 条算，平滑滚一屏也就几十帧；给 120 帧足够，又不至于把人的滚动吞掉。
			smoothBudget = 120;
		},

		settle(at = now()): Settle | null {
			if (!everMoved) return null;
			if (at - lastMoveAt < GESTURE_IDLE_MS) return null; // 还在动
			// 保险丝：上一次结算真的补过页，且距今不到 400ms → 这次不结算（设计 §1.3）。
			if (lastSettleFilled && at - lastSettleAt < SETTLE_COOLDOWN_MS) {
				everMoved = false;
				gestureMoved = 0;
				lastSettleAt = at;
				lastSettleFilled = false;
				return null;
			}
			const netMoved = net();
			everMoved = false;
			const moved = gestureMoved;
			gestureMoved = 0;
			const nearNow = near();
			const result: Settle = {
				atTop: nearNow.atTop,
				atBottom: nearNow.atBottom,
				moved,
				upTo: Math.max(0, -netMoved),
			};
			lastSettleAt = at;
			// 这一轮先用掉保险丝：没人报「补了」就当它补了（保守，宁可少补一次也不狂补）。
			lastSettleFilled = true;
			return result;
		},

		noteFilled(): void {
			lastSettleFilled = true;
		},

		moving(): boolean {
			return everMoved;
		},

		idleFor(at = now()): number {
			return at - lastMoveAt;
		},

		claimed(): number {
			return claimCount;
		},

		writes(): number {
			return writeCount;
		},

		reset(): void {
			last = host.read();
			pending = null;
			writes = [];
			everMoved = false;
			gestureMoved = 0;
			gestureStartTop = last.top;
			lastMoveAt = now();
			lastSettleAt = Number.NEGATIVE_INFINITY;
			lastSettleFilled = false;
		},
	};
}
