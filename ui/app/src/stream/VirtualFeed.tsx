/**
 * 消息流的窗口化渲染。
 *
 * 5000 条的频道原来是把每一行都挂进 DOM 的：首屏要布局几千个节点，
 * 滚动时浏览器每帧都在给它们算样式。这个文件只干一件事 —— **只挂视口附近的那些行**，
 * 上下用两个空盒子把高度撑住，滚动条长度和「滚到哪儿」都不变。
 *
 * 三个必须一起成立的东西，缺一个就抖：
 *
 * 1. **高度表**：每行多高不靠猜。行挂出来之后量一次，记进 `heightOf`；
 *    没量过的行先用上次的估计（`estimate`），一量到就替换。
 * 2. **动态测高**：行高会变 —— `<details>` 展开、图片加载完、窄屏换行。
 *    所以每个挂出来的行外面套一个 `ResizeObserver`，高了矮了都立刻回写高度表并重算窗口。
 * 3. **首帧落在哪儿**：原来的流是底部对齐的（内容不足一屏时贴着输入框），挂进 spacer 之后
 *    这条会失效。所以自己补：内容总高不足一屏就一直到底；够一屏就按算出来的总高
 *    定位到「最后一屏」，落点用已经量到的高重新算一次 —— 不让估算误差留在屏幕上。
 *
 * 不在这里做的事（第二步）：补历史之后的锚点搬运、跳转目标不在窗口里时先滚过去。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** 视口上下各留多少像素的缓冲。一屏大约 700–900，留一屏半，快速甩动时不至于露白。 */
const OVERSCAN_PX = 1200;

/**
 * 没量过的行先用这个高度。
 *
 * 故意取小不取大：估高了，滚动条虚长一段、停在那儿就是空白；估小了只是先渲染多几行。
 * 一行普通消息（头像 + 两行字）大约 60–80，取 72 是中位。
 */
const DEFAULT_HEIGHT = 72;

export type VirtualFeedProps = {
	/** 行的 key，按显示顺序给。用来对高度表。 */
	items: readonly { readonly key: string }[];
	/** 画一行。`index` 是本行在 `items` 里的位置（第一版没用上，第二步跳转会要）。 */
	render: (index: number) => ReactNode;
	/** 滚动容器。窗口位置靠它的 `scrollTop` / `clientHeight` 算。 */
	scroller: React.RefObject<HTMLDivElement | null>;
	/** 为了在缓存里区分频道：换频道时高度表要整个作废（同一个 seq 的图可能不一样高）。 */
	scope: string;
	/**
	 * 我是不是在「看最新」。
	 *
	 * 是的话，行数一变就重新贴到底（新消息来了要看得见）；不是的话一动不动 ——
	 * 翻着历史被拽回底部是最讨人厌的那种毛病。
	 */
	pinned: boolean;
};

export function VirtualFeed(props: VirtualFeedProps): JSX.Element {
	const { items, render, scroller, scope, pinned } = props;

	/** 量到过的高度，按行 key 存。换频道清空。 */
	const heights = useRef(new Map<string, number>());
	/** 量不到时的估计值：所有量到的高度的平均。空的时候用 `DEFAULT_HEIGHT`。 */
	const estimate = useRef(DEFAULT_HEIGHT);
	/** 每个挂出来的行到它的观察器；行卸掉时断开，不然观察器会攒。 */
	const observers = useRef(new Map<Element, ResizeObserver>());

	const layout = useRef<{ starts: number[]; heights: number[]; total: number; estimate: number }>({
		starts: [],
		heights: [],
		total: 0,
		estimate: DEFAULT_HEIGHT,
	});

	const [range, setRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
	/** 位置算完了没有。第一帧不知道在哪儿，先别画，免得画在 0 然后跳一下。 */
	const [ready, setReady] = useState(false);

	// 换频道：高度表作废，否则上一个频道的行高会套到这个频道上（图片、长文差别很大）。
	useLayoutEffect(() => {
		heights.current.clear();
		estimate.current = DEFAULT_HEIGHT;
		layout.current = { starts: [], heights: [], total: 0, estimate: DEFAULT_HEIGHT };
		setReady(false);
	}, [scope]);

	/**
	 * 按当前滚动位置算该挂哪一段。
	 *
	 * 从最近一次算过的位置顺着找 —— 滚动是一格一格走的，大多数时候走几步就到位；
	 * 一次跳跃（拖滚动条、切频道）落得太远时再从头累。**别每次全量累加**：
	 * 上千行时那是每帧几千次加法，占的就是滚动本身的那点时间。
	 *
	 * 布局是「从上往下正常排」：挂出来的那段天然落在该在的位置，上下两个空盒子
	 * 各把自己那半边的总高度撑住。定好这个就不会抖 —— 滚动条长度只跟两个 spacer 有关，
	 * 跟当前挂了多少行无关。
	 */
	const rebuild = useCallback(() => {
		const heightOf = (index: number): number => {
			const item = items[index];
			if (item === undefined) return 0;
			return heights.current.get(item.key) ?? estimate.current;
		};
		const starts: number[] = [];
		const list: number[] = [];
		let total = 0;
		for (let index = 0; index < items.length; index += 1) {
			starts.push(total);
			const height = heightOf(index);
			list.push(height);
			total += height;
		}
		layout.current = { starts, heights: list, total, estimate: estimate.current };
	}, [items]);

	const recompute = useCallback(() => {
		const flow = scroller.current;
		if (flow === null) return;
		// 行数或估计值变了就重建；单个行量到真值也走 `measure` 那条路重建。
		// 不重建的话，下一条消息到达时 `estimate` 变了、布局表却还是旧的那份。
		if (layout.current.starts.length !== items.length || layout.current.estimate !== estimate.current) {
			rebuild();
		}
		const { starts, heights: list } = layout.current;

		const viewTop = flow.scrollTop;
		const viewBottom = viewTop + flow.clientHeight;

		/** 第一个「底边超过 y」的行。二分：`starts` 递增，`starts[i] + h[i]` 也递增。 */
		const findFirst = (y: number): number => {
			let low = 0;
			let high = list.length;
			while (low < high) {
				const mid = (low + high) >> 1;
				if ((starts[mid] ?? 0) + (list[mid] ?? 0) > y) high = mid;
				else low = mid + 1;
			}
			return low;
		};
		/** 最后一个「顶边在 y 之上」的行。 */
		const findLast = (y: number): number => {
			let low = 0;
			let high = list.length;
			while (low < high) {
				const mid = (low + high) >> 1;
				if ((starts[mid] ?? 0) < y) low = mid + 1;
				else high = mid;
			}
			return low - 1;
		};

		let start = findFirst(viewTop - OVERSCAN_PX);
		let end = findLast(viewBottom + OVERSCAN_PX) + 1;
		if (list.length === 0) {
			start = 0;
			end = 0;
		}
		start = Math.max(0, Math.min(start, Math.max(0, list.length - 1)));
		end = Math.max(start, Math.min(end, list.length));
		// 一屏都装不下时（极窄的窗口、极矮的行）至少给一行，不然会空。
		if (end - start < 1 && list.length > 0) end = Math.min(list.length, start + 1);

		setRange((current) => (current.start === start && current.end === end ? current : { start, end }));
		setReady(true);
	}, [items, rebuild, scroller]);

	// 滚动、窗口尺寸变化、行数变化都重算。
	useEffect(() => {
		const flow = scroller.current;
		if (flow === null) return;
		recompute();
		const onScroll = (): void => recompute();
		flow.addEventListener("scroll", onScroll, { passive: true });
		const resize = new ResizeObserver(() => recompute());
		resize.observe(flow);
		// 第一条量到之前 `estimate` 是默认值，可能算出很离谱的窗口；量到之后要再来一次。
		return () => {
			flow.removeEventListener("scroll", onScroll);
			resize.disconnect();
		};
	}, [recompute, scroller]);

	/**
	 * 我有没有为这一屏定过落点。
	 *
	 * `scope` 一换（切频道）就重置 —— 进去得落在「最后一屏」，不是上次停的那个位置。
	 */
	const placed = useRef<string | null>(null);

	/**
	 * 把视口贴到底，用**已经量到的**高度重算一次。
	 *
	 * 第一帧只有估算：5000 条里 60 条是量过的，另外 4940 条按平均值猜，总高能差出几千像素。
	 * 所以落完点、行挂出来、`ResizeObserver` 报回真实高度之后，再来一次 —— 用真值纠偏，
	 * 用户看到的就是一次到位的底，不是先停半空再滑下去。
	 */
	const stickToEnd = useCallback(() => {
		const flow = scroller.current;
		if (flow === null) return;
		rebuild();
		flow.scrollTop = Math.max(0, layout.current.total - flow.clientHeight);
		recompute();
	}, [rebuild, recompute, scroller]);

	// 行数变了（新消息、补历史、切频道）也要重算；看最新的话顺带跟到底。
	useLayoutEffect(() => {
		if (placed.current !== scope) {
			// 刚进这一屏：内容不足一屏就到底，够一屏就落到最后一屏。
			placed.current = scope;
			stickToEnd();
			return;
		}
		if (pinned) stickToEnd();
		else recompute();
	}, [items, recompute, scope, stickToEnd, pinned]);

	/** 某个行量到了新高度：回写、更新估计值、重算窗口。 */
	const measure = useCallback(
		(node: HTMLElement, key: string) => {
			const height = node.getBoundingClientRect().height;
			if (height <= 0) return;
			const before = heights.current.get(key);
			if (before !== undefined && Math.abs(before - height) < 1) return;
			heights.current.set(key, height);
			// 估计值跟着走：已经量过的那些的平均，比固定常数准得多。
			let sum = 0;
			for (const value of heights.current.values()) sum += value;
			estimate.current = sum / heights.current.size;
			rebuild();
			recompute();
		},
		[rebuild, recompute],
	);

	/**
	 * 行挂上来：量一次，之后靠观察器盯着它变高变矮。
	 *
	 * React 19 会拿 `null` 调一次 ref 表示卸载 —— 那里必须把这一行的观察器断掉，
	 * 不然滚动甩几圈就攒下几千个观察器，全都在盯着已经被垃圾回收的节点。
	 */
	const attach = useCallback(
		(node: HTMLElement | null, key: string) => {
			if (node === null) return;
			if (observers.current.has(node)) return;
			measure(node, key);
			if (typeof ResizeObserver === "undefined") return;
			const observer = new ResizeObserver(() => {
				measure(node, key);
			});
			observer.observe(node);
			observers.current.set(node, observer);
		},
		[measure],
	);

	/** ref 的清理函数：节点卸下来了，把盯着它的观察器断掉。 */
	const detach = useCallback((node: HTMLElement | null) => {
		if (node === null) return;
		const observer = observers.current.get(node);
		if (observer === undefined) return;
		observer.disconnect();
		observers.current.delete(node);
	}, []);

	// 卸载时断开所有观察器。
	useEffect(() => {
		const map = observers.current;
		return () => {
			for (const observer of map.values()) observer.disconnect();
			map.clear();
		};
	}, []);

	// 挂出来的是哪一段。
	const shown = items.slice(range.start, range.end);

	// 上下 spacer 的高度用「没挂出来的那些行」算，量到的用真值、没量到的用估计。
	const spacerHeight = (from: number, to: number): number => {
		let sum = 0;
		for (let index = from; index < to; index += 1) {
			const item = items[index];
			if (item === undefined) continue;
			sum += heights.current.get(item.key) ?? estimate.current;
		}
		return sum;
	};

	if (!ready) return <div className="vfeed" />;

	return (
		<>
			<div className="vfeed-gap" style={{ height: spacerHeight(0, range.start) }} aria-hidden="true" />
			<div className="vfeed">
				{shown.map((item, offset) => (
					<div
						className="vfeed-item"
						key={item.key}
						ref={(node) => {
							attach(node, item.key);
							return () => {
								detach(node);
							};
						}}
					>
						{render(range.start + offset)}
					</div>
				))}
			</div>
			<div
				className="vfeed-gap"
				style={{ height: spacerHeight(range.end, items.length) }}
				aria-hidden="true"
			/>
		</>
	);
}
