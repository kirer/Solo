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

/** 一行最小该有的样子：一个稳定的 key（对高度表用）。 */
export type VirtualFeedItem = { readonly key: string };

export type VirtualFeedProps = {
	/** 行的 key，按显示顺序给。用来对高度表。 */
	items: readonly VirtualFeedItem[];
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
	/**
	 * 这一行对应的消息 seq（没有就 `undefined`：时间分隔、未读横幅这类不是消息）。
	 *
	 * 跳转要按 seq 找人，可人常常没挂载（几千里之外的某一条）。**位置只有高度表知道**，
	 * 所以得由外面告诉我「这个 seq 在第几行」，我再拿布局表把它换算成像素。
	 */
	seqOf?: ((item: VirtualFeedItem) => number | undefined) | undefined;
	/** 外面拿它来发跳转命令。 */
	handle?: React.MutableRefObject<VirtualFeedHandle | null> | undefined;
};

/**
 * 一行对应的消息 seq。时间分隔和未读横幅不是消息，返回 `undefined`。
 *
 * 单独拿出来是因为**两边都要用**：`Stream.tsx` 传给 `VirtualFeed` 建索引，
 * 测试里也直接拿它断言，不重复写第二份判断。
 */
export function seqOfRow(row: VirtualFeedItem): number | undefined {
	const type = (row as { type?: unknown }).type;
	if (type !== "say" && type !== "note") return undefined;
	const message = (row as { message?: unknown }).message;
	if (typeof message !== "object" || message === null) return undefined;
	const seq = (message as { seq?: unknown }).seq;
	return typeof seq === "number" ? seq : undefined;
}

/** 外面能对窗口做的事。只有一件：跳到某个 seq。 */
export type VirtualFeedHandle = {
	/**
	 * 滚到某个 seq 那一行。
	 *
	 * 返回那一行**现在**在不在窗口里：在的话调用方直接高亮；不在的话我滚过去了，
	 * 但要等下一帧它才挂出来。**找不到就返回 false 什么都不做** ——
	 * 被引用的话早于已加载的历史时就是这个样子，不该报错、也不该把视线挪走。
	 */
	jumpToSeq: (seq: number) => boolean;
	/**
	 * 视口顶部现在是哪条消息，以及它离视口顶多少像素（可能为负：已经滚过去一截）。
	 *
	 * 没有可比对的行（空列表、或者顶部落在不是消息的行上）就返回 `null`。
	 */
	anchorAtViewportTop: () => { seq: number; top: number } | null;
	/**
	 * 那一行现在离视口顶多少像素（正数在下面，负数已经滚过头）。
	 *
	 * `anchorAtViewportTop` 返回的是「现在是哪一行、它离顶多少」，这一条反过来：
	 * **给一个固定的 seq，问它现在离顶多少**。补历史之后内容长高了，同一个 seq 的偏移会变，
	 * 两边一比就知道差了多少。找不到那一行就 `null`。
	 */
	offsetOfSeq: (seq: number) => number | null;
};

export function VirtualFeed(props: VirtualFeedProps): JSX.Element {
	const { items, render, scroller, scope, pinned, seqOf, handle } = props;

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
	/** DEBUG 临时 */
	const rebuildCount = useRef(0);
	const recomputeCount = useRef(0);
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
		rebuildCount.current += 1;
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
		recomputeCount.current += 1;
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
		// DEBUG
		(globalThis as unknown as { __vf?: unknown }).__vf = {
			scrollTop: flow.scrollTop,
			scrollHeight: flow.scrollHeight,
			clientHeight: flow.clientHeight,
			items: items.length,
			range: { start, end },
			total: layout.current.total,
			estimate: estimate.current,
			measured: heights.current.size,
			rebuilds: rebuildCount.current,
			recomputes: recomputeCount.current,
		};
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
	 * seq → 行号。跳转要按 seq 找人，得先知道它是第几行。
	 *
	 * 只在 `items` 变时重建一次（一次遍历），跳转时 O(1) 查。
	 */
	const indexOfSeq = useRef(new Map<number, number>());
	/** `seqOf` 每次渲染都是新函数 —— 放进 ref，索引表才只跟着 `items` 重建。 */
	const seqOfRef = useRef(seqOf);
	seqOfRef.current = seqOf;
	useLayoutEffect(() => {
		const map = new Map<number, number>();
		const read = seqOfRef.current;
		if (read !== undefined) {
			for (let index = 0; index < items.length; index += 1) {
				const item = items[index];
				if (item === undefined) continue;
				const seq = read(item);
				if (seq !== undefined && !map.has(seq)) map.set(seq, index);
			}
		}
		indexOfSeq.current = map;
	}, [items]);

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

	/**
	 * 跳到某个 seq 那一行。
	 *
	 * 三件事：
	 * 1. **先查它在第几行**（`indexOfSeq`），查不到就直接 false 走人 —— 被引用的话早于
	 *    已加载的历史时就是这样，宁可不跳也不报错、也不把视线挪走。
	 * 2. **拿布局表换算成像素**滚过去。人没挂载是常态（几千行里挂着几十行），
	 *    但位置一直在表里，所以滚得动。
	 * 3. 滚完再问一次「现在挂出来没有」：挂出来了就是真跳到了；还没挂出来
	 *    （下一帧才挂）也返回 true —— 位置已经对了，调用方等下一帧高亮就行。
	 *
	 * 目标行落在哪儿：屏幕**中间偏上**（原来 `scrollIntoView({block:"center"})` 的效果），
	 * 上下都留出上下文，比贴到边上读得舒服。
	 */
	const jumpToSeq = useCallback(
		(seq: number): boolean => {
			const flow = scroller.current;
			const index = indexOfSeq.current.get(seq);
			if (flow === null || index === undefined) return false;
			rebuild();
			const { starts, heights: list, total } = layout.current;
			const rowTop = starts[index] ?? 0;
			const rowHeight = list[index] ?? estimate.current;
			// 让行中心落在视口中心；两头夹一下，别滚出可滚范围。
			const target = rowTop + rowHeight / 2 - flow.clientHeight / 2;
			const max = Math.max(0, total - flow.clientHeight);
			flow.scrollTop = Math.min(max, Math.max(0, target));
			recompute();
			return true;
		},
		[estimate, rebuild, recompute, scroller],
	);

	/**
	 * 视口顶部是哪条消息。从高度表里反查，不碰 DOM —— 那一行可能刚好没挂载。
	 *
	 * 反过来找：「顶边在视口顶之上」的最后一行。它要是时间分隔或未读横幅（没有 seq），
	 * 就往下顺延到第一条真正的消息。都没有就 `null`。
	 */
	const anchorAtViewportTop = useCallback((): { seq: number; top: number } | null => {
		const flow = scroller.current;
		if (flow === null) return null;
		rebuild();
		const { starts, heights: list } = layout.current;
		const viewTop = flow.scrollTop;
		let low = 0;
		let high = list.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if ((starts[mid] ?? 0) <= viewTop) low = mid + 1;
			else high = mid;
		}
		// `low - 1` 是顶边在视口顶之上的最后一行；它可能整个已经滚出去了，从它开始往下找。
		for (let index = Math.max(0, low - 1); index < items.length; index += 1) {
			const item = items[index];
			if (item === undefined) continue;
			const seq = seqOfRef.current?.(item);
			if (seq === undefined) continue;
			return { seq, top: (starts[index] ?? 0) - viewTop };
		}
		return null;
	}, [items, rebuild, scroller]);

	/** 把某个 seq 按回「离视口顶 `top` 像素」。 */
	const offsetOfSeq = useCallback(
		(seq: number): number | null => {
			const flow = scroller.current;
			const index = indexOfSeq.current.get(seq);
			if (flow === null || index === undefined) return null;
			rebuild();
			return (layout.current.starts[index] ?? 0) - flow.scrollTop;
		},
		[rebuild, scroller],
	);

	// 把这几条命令交给外面。
	useLayoutEffect(() => {
		if (handle === undefined) return;
		handle.current = { jumpToSeq, anchorAtViewportTop, offsetOfSeq };
		return () => {
			handle.current = null;
		};
	}, [anchorAtViewportTop, handle, jumpToSeq, offsetOfSeq]);

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
