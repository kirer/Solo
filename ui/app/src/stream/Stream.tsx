/**
 * 消息流。
 *
 * 这个文件只做三件事：把 `buildRows()` 算出来的行画出来、维护「贴底」与「上翻加载」。
 *
 * 屏幕上只有消息（`say` / `note`）和一条**正在跑的占位**（`live` 行，ADR-046）。
 * 占位是派生出来的：跑完就消失，真实回复顶上来；过程只进「后台任务」面板（ADR-062）。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Attachment, Message, Turn } from "../api/types.ts";
import { uploadUrl } from "../api/client.ts";
import { avatarSvg, groupAvatar } from "../lib/avatar.ts";
import { clockTime, copyText, humanBytes, humanDuration, relTime } from "../lib/format.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { CODE_COPY_CLASS } from "../lib/copy-code.ts";
import { buildRows } from "./model.ts";
import type { Row } from "./model.ts";
import { LiveRow } from "./LiveRow.tsx";
import { Slot } from "../plugin/Slot.tsx";
import { getState, loadEarlier, loadLater, openPerson, openTasks, setReply } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";
import { DEFAULT_ROW_HEIGHT, PLACEHOLDER_HEIGHT, averageHeight, buildHeights, offsetOf, pageSizeFor } from "./heights.ts";
import type { Heights } from "./heights.ts";
import { SAMPLER_MAX_IDLE_MS, createArbiter } from "./scroll.ts";
import type { Arbiter } from "./scroll.ts";


export function Stream(props: { onImage: (src: string) => void; onFile: (file: Attachment) => void }): JSX.Element {
	const currentId = useStore((state) => state.currentId);
	const detail = useStore((state) => state.detail);
	const hasMoreAbove = useStore((state) => state.hasMoreAbove);
	const loadingEarlier = useStore((state) => state.loadingEarlier);
	const earlierError = useStore((state) => state.earlierError);
	const loadingLater = useStore((state) => state.loadingLater);
	const unseenAfter = useStore((state) => state.unseenAfter);
	const people = useStore((state) => state.people);
	const runs = useStore((state) => state.runs);
	const presence = useStore((state) => state.presence);
	const [atBottom, setAtBottom] = useState(true);
	/** 点开的那条消息（复制 / 引用 / 看人）。点外面或「取消」收起。 */
	const [picked, setPicked] = useState<{ message: Message; name: string } | null>(null);

	const flowRef = useRef<HTMLDivElement | null>(null);
	const feedRef = useRef<HTMLDivElement | null>(null);
	/** 滚动仲裁者：谁是「人在动」（设计 §1）。**唯一**允许写 `scrollTop` 的地方在它里面。 */
	const arbiter = useRef<Arbiter | null>(null);
	/** 量到过的行高（`row.key → px`）。模型里每一行都有高度，锚点被回收也算得出 `ΔH`。 */
	const heights = useRef(new Map<string, number>());
	/** 上一次渲染时每一行的 key 与偏移，用来在补页前后算锚点补偿（设计 §3.1）。 */
	const layout = useRef<Heights>(buildHeights([]));
	/** 每帧取样循环：只在有滚动兴趣时跑，空闲 500ms 就停（设计 §1.2）。 */
	const sampler = useRef<number | null>(null);
	/** 这一帧渲染了哪些行（给「还没量到高度」时初始化模型用）。 */
	const rowsRef = useRef<Row[]>([]);

	const messages = detail?.messages ?? [];
	// 这个频道里正在跑、还没回话的那几轮 —— `live` 行只认它们（ADR-046）。
	const running = useMemo(() => {
		const out: Turn[] = [];
		for (const list of runs.values()) {
			for (const turn of list) {
				if (turn.channelId !== currentId || turn.status !== "running") continue;
				out.push(turn);
			}
		}
		return out;
	}, [runs, currentId]);
	const unreadBefore = useStore((state) => state.unreadBefore);
	/**
	 * 占位行要几条：一页 = 一屏 = N 条定高（设计 §3.4）。
	 *
	 * 一页还没回来时才画；回来了就整页换成真行 —— 高度相近，所以换的时候不跳。
	 * 失败时同一批占位行原地变成「没加载出来 · 重试」，**不缩成一行也不消失**：
	 * 一缩，用户眼前那屏字就会整体动一下（验收第 19–20 条）。
	 */
	const pending = useMemo(() => {
		if (!loadingEarlier && !earlierError) return null;
		const flow = flowRef.current;
		const size = flow === null ? 12 : pageSizeFor(flow.clientHeight, averageHeight(layout.current));
		return { count: Math.max(1, size), failed: earlierError && !loadingEarlier };
	}, [loadingEarlier, earlierError]);

	const rows = useMemo<Row[]>(
		() =>
			buildRows({
				messages,
				running,
				now: Date.now(),
				// `exactOptionalPropertyTypes` 下不能显式传 undefined：没有未读就干脆不给这个字段。
				...(unreadBefore === null ? {} : { unreadBefore }),
				...(pending === null ? {} : { pending }),
				// 到头了才说「到最上面了」：没有更早的、也不是正在补、也没失败。
				...(hasMoreAbove || pending !== null ? {} : { atCeiling: messages.length > 0 }),
			}),
		[messages, running, unreadBefore, pending, hasMoreAbove],
	);

	// 渲染时把这一屏的行交给 ref：仲裁者初始化模型时还没量到任何高度，按估算行高先摆上。
	rowsRef.current = rows;

	const labels = useMemo(() => {
		const map = new Map<string, { label: string; role: string; assistant: boolean }>();
		for (const actor of people) {
			map.set(actor.slug, { label: actor.label, role: actor.title, assistant: actor.assistant === true });
		}
		if (detail !== null) {
			for (const member of detail.members) {
				// 名册里没有这个人时（理论上不该发生）用频道的成员表兜底。`role` 是
				// `owner|assistant|member` 三个机器值，只有 `assistant` 值得印在名字后面。
				if (!map.has(member.slug)) {
					map.set(member.slug, {
						label: member.label,
						role: member.role === "assistant" ? "助理" : "",
						assistant: member.role === "assistant",
					});
				}
			}
		}
		return map;
	}, [people, detail]);

	// 和助理这一页是「信纸」（v6 D01）：抬头是他，不是一条消息。
	const hero = useMemo(() => {
		const assistant = people.find((person) => person.assistant === true);
		if (detail === null || assistant === undefined) return null;
		if (detail.channel.kind !== "dm" || detail.channel.title !== assistant.label) return null;
		const all = (runs.get(assistant.slug) ?? []).filter((turn) => turn.status === "running" || turn.stepCount > 0);
		const startOfDay = new Date();
		startOfDay.setHours(0, 0, 0, 0);
		const today = all.filter((turn) => turn.startedAt >= startOfDay.getTime());
		const total = today.reduce((sum, turn) => sum + (turn.endedAt === undefined ? 0 : turn.endedAt - turn.startedAt), 0);
		const last = today.reduce<number | undefined>(
			(best, turn) => (best === undefined || turn.startedAt > best ? turn.startedAt : best),
			undefined,
		);
		const parts = [
			`今天 ${String(today.length)} 轮`,
			total === 0 ? undefined : `共 ${humanDuration(total)}`,
			last === undefined ? undefined : `最近 ${relTime(last)}`,
		].filter((part) => part !== undefined);
		return {
			slug: assistant.slug,
			name: assistant.label,
			state: presence.get(assistant.slug)?.state ?? "idle",
			meta: parts.join(" · "),
		};
	}, [people, detail, runs, presence]);

	/* ── 贴底与位置保持（虚拟化重做 2026-11-11） ──────────────────── */

	/**
	 * 这是**唯一**给 `scrollTop` 赋值的地方。
	 *
	 * 它认领的两件事：① 写之前先在仲裁者里记一笔账（下一次取样会把这次跳变认领掉，
	 * 不然我们自己的补偿会被人当成「用户在滚」，前三轮就是这么把循环接回去的）；
	 * ② `reason` 只做日志用，不是判断依据 —— 判断只认账。
	 */
	const setScrollTop = useCallback((target: number, reason: "enter" | "anchor" | "user-return") => {
		arbiter.current?.setScrollTop(target, reason);
	}, []);

	/** 取样循环：有滚动兴趣时每帧跑一次，空闲 500ms 停（设计 §1.2：不许长驻 rAF）。 */
	const wake = useCallback(() => {
		if (sampler.current !== null) return;
		const tick = (): void => {
			const state = arbiter.current;
			if (state === null) {
				sampler.current = null;
				return;
			}
			state.sample();
			// 这次动作停了 → 结算一次（贴顶就补一页，credit 只有这一处会发）。
			const settled = state.settle();
			if (settled !== null) settleOnce(settled);
			if (state.idleFor() > SAMPLER_MAX_IDLE_MS) {
				sampler.current = null;
				return;
			}
			sampler.current = requestAnimationFrame(tick);
		};
		sampler.current = requestAnimationFrame(tick);
	}, []);

	/**
	 * 「到底」该滚到哪 —— **按模型算，不读 `scrollHeight`**。
	 *
	 * 进频道那一刻 DOM 里还没有这一批行，`scrollHeight` 只反映上一次渲染，拿它当目标是
	 * 「先写错再纠正」。模型里每一行都有高度（真行的、占位行的），末行底 = 总高，所以
	 * 这一次写就是终值；之后量到真行高，模型自己变准，位置跟着模型走（`compensate` 兜）。
	 */
	const bottomOf = useCallback((flow: HTMLElement): number => {
		const rows = layout.current.rows;
		const last = rows[rows.length - 1];
		const total = last === undefined ? 0 : (offsetOf(layout.current, last.key) ?? 0) + last.height;
		// 模型比屏幕还短：没得滚，回 0（否则写一个负数，`setScrollTop` 会当成一次位移记账）。
		return Math.max(0, Math.round(total - flow.clientHeight));
	}, []);

	/**
	 * 到底。只有三处会调：进频道（`reason="enter"`）、本窗口发消息成功、用户点「回到最新」
	 * （`reason="user-return"`）。**新消息到达不许调它** —— 那是验收第 26 条的挂点。
	 */
	const toBottom = useCallback(
		(reason: "enter" | "user-return" = "user-return", behavior: ScrollBehavior = "auto") => {
			const flow = flowRef.current;
			if (flow === null) return;
			if (behavior === "smooth") {
				// `scrollTo({behavior:"smooth"})` 是一串我们没记账的写；记账之后再滚，
				// 让中途的每一帧跳变都被认领掉，不会被当成「人在往上翻」。
				arbiter.current?.claim();
				flow.scrollTo({ top: flow.scrollHeight, behavior: "smooth" });
			} else {
				setScrollTop(flow.scrollHeight, reason);
			}
			setAtBottom(true);
		},
		[setScrollTop],
	);

	/** 一页补多少条：按屏算（Solo 已拍：一页按屏）。 */
	const pageSize = useCallback((): number => {
		const flow = flowRef.current;
		if (flow === null) return pageSizeFor(0, averageHeight(layout.current));
		return pageSizeFor(flow.clientHeight, averageHeight(layout.current));
	}, []);

	/**
	 * 进频道后台填满（设计 §2.4）：最多补 3 页就停。
	 *
	 * 停的理由是「用户没动」：进频道是程序在动，不是人在动，补到一屏装不满为止就够了。
	 * 补回来的每一页都走 3.1 补偿（上面那条 effect），这里**不碰 `scrollTop`**。
	 */
	const fillOnEnter = useCallback(async () => {
		for (let round = 0; round < 3; round += 1) {
			const flow = flowRef.current;
			if (flow === null) return;
			if (flow.scrollHeight > flow.clientHeight + 40) return;
			const state = getState();
			if (!state.hasMoreAbove || state.loadingEarlier) return;
			const pages = Math.ceil((flow.clientHeight + 40 - flow.scrollHeight) / Math.max(1, averageHeight(layout.current) * pageSize()));
			const before = state.detail?.messages.length ?? 0;
			await loadEarlier(pageSize() * Math.max(1, Math.min(3, pages)));
			const after = getState().detail?.messages.length ?? 0;
			if (after === before) return; // 一条都没补上（到底了 / 失败了）→ 不空转
		}
	}, [pageSize]);

	/** 屏幕最上面那一行的 key（锚点）。按 key 认，不按像素记。 */
	const firstVisibleKey = useCallback((): string | null => {
		const flow = flowRef.current;
		const feed = feedRef.current;
		if (flow === null || feed === null) return null;
		const top = flow.getBoundingClientRect().top;
		for (const node of feed.querySelectorAll<HTMLElement>("[data-row-key]")) {
			const rect = node.getBoundingClientRect();
			if (rect.bottom > top + 2) return node.dataset["rowKey"] ?? null;
		}
		return null;
	}, []);

	/**
	 * 补页前后把屏幕上的字钉住（设计 §3.1 / §3.3）。
	 *
	 * `ΔH` **由模型算法**（`offsetOf`），不查 DOM：虚拟化下上面的行本来就会被回收，
	 * 「找不到锚点」是常态，不是失败。模型里每一行都有高度 —— 真行的、占位行的、
	 * 已经回收但记得高度的，所以 `ΔH` 永远算得出来。
	 */
	const compensate = useCallback(() => {
		const anchorKey = firstVisibleKey();
		const flow = flowRef.current;
		if (anchorKey === null || flow === null) return;
		const beforeTop = offsetOf(layout.current, anchorKey);
		if (beforeTop === undefined) return; // 模型里还没有它（刚进来）→ 不补偿，没有位移可言
		// 等这一帧的 DOM 落地，按新模型算同一个 key 现在距内容顶多少。
		const apply = (): void => {
			const now = offsetOf(layout.current, anchorKey);
			if (now === undefined) return; // 兜底第 3 级：模型里也没有 → 不写（下一次渲染会带上）
			const delta = now - beforeTop;
			if (Math.abs(delta) < 1) return;
			setScrollTop(flow.scrollTop + delta, "anchor");
		};
		apply();
	}, [firstVisibleKey, setScrollTop]);

	/** 量一次真行高度，交给模型吸收（误差自愈：估的 → 真的）。 */
	const measureRows = useCallback(() => {
		const feed = feedRef.current;
		if (feed === null) return;
		let changed = false;
		for (const node of feed.querySelectorAll<HTMLElement>("[data-row-key]")) {
			const key = node.dataset["rowKey"];
			if (key === undefined) continue;
			// 占位行的高度是**定的**（`PLACEHOLDER_HEIGHT`），不量：量出来的 0（还没布局、
			// 被折叠）会把它当成「这行没高度」，占位就没占住位置，页回来时那一屏会整体往上跳。
			const height = key.startsWith("ph-") ? PLACEHOLDER_HEIGHT : node.getBoundingClientRect().height;
			if (!Number.isFinite(height) || height <= 0) continue;
			const rounded = Math.round(height);
			if (heights.current.get(key) === rounded) continue;
			heights.current.set(key, rounded);
			changed = true;
		}
		if (changed) {
			layout.current = buildHeights(
				layout.current.rows.map((row) => {
					const height = heights.current.get(row.key);
					return height === undefined ? row : { key: row.key, height };
				}),
			);
		}
	}, []);

	/**
	 * 一次动作结束时的结算（设计 §1.3）。
	 *
	 * 补页的**唯一**自动入口：贴顶 + 还有更早的 + 这次动作是往上走的 → 补一页。
	 * 补完还贴顶也不续补 —— 这次动作的 `credit` 已经用掉了，由仲裁者的保险丝兜住。
	 */
	const settleOnce = useCallback(
		(settled: { atTop: boolean; atBottom: boolean; upTo: number }) => {
			setAtBottom(settled.atBottom);
			const flow = flowRef.current;
			if (flow === null) return;
			const atTop = flow.scrollTop <= 24;
			if (hasMoreAbove && !loadingEarlier && atTop && settled.upTo > 0) {
				arbiter.current?.noteFilled();
				void loadEarlier(pageSize());
				return;
			}
			// 往下翻到窗口下界、下面还压着没接上的新消息 → 接一页（不跳到底，只接上）。
			if (unseenAfter !== null && !loadingLater && flow.scrollHeight - flow.scrollTop - flow.clientHeight <= 24) {
				void loadLater(pageSize());
			}
		},
		[hasMoreAbove, loadingEarlier, loadingLater, unseenAfter, pageSize],
	);

	/**
	 * 四条 effect 的第一条（原 `if (pinned.current) toBottom()`）—— **删掉了 `toBottom` 那一支**。
	 *
	 * 新消息到达**永不写 `scrollTop`**：那句话是验收第 26 条的挂点 —— B 停在底部时，
	 * A 的每条新消息都让 B 重算一次位置，屏上整体挪一格。现在这条 effect 只做两件事：
	 * ① 按 3.1 补偿（补页/更新把上面的行弄高了，把屏上的字钉住）；② 更新「回到最新」按钮。
	 * 「跟到底」只剩三个触发点：进频道、本窗口 `send()` 成功、用户点「回到最新」。
	 */
	useLayoutEffect(() => {
		const flow = flowRef.current;
		if (flow === null) return;
		compensate();
		setAtBottom(flow.scrollHeight - flow.scrollTop - flow.clientHeight <= 24);
	}, [messages, compensate]);

	/** 渲染之后量一次真行高（只做校正，不参与任何判断）。 */
	useEffect(() => {
		measureRows();
	});

	/**
	 * 四条 effect 的第三条（原 `if (Math.abs(delta) > 1) flow.scrollTop += delta`）——
	 * 补偿本身还在，但改成走 `setScrollTop(..., "anchor")` 记账。上面那条 effect 已经接管了它。
	 *
	 * 第二条（`requestAnimationFrame(maybeLoad)` + `scroll` 上的 `maybeLoad` + `notFilled`）
	 * 和第四条（`scroll` 里更新 `pinned`）**整块删掉**：补页入口只剩「一次动作结算」与
	 * 「进频道填满」，`pinned` 这个「我贴底」的开关也不再参与任何补页判断。
	 */
	/**
	 * 键位：PageUp / PageDown / Home / End（验收第 15–18 条 · 2026-11-11）。
	 *
	 * **为什么必须自己接管**：实测过（ego 浏览器，`overflow-y:auto` + 两万 px 内容）——
	 * 焦点在容器里的子元素上时按 PageUp，`scrollTop` 是从 4000 一步跳到 0，不是滚一屏；
	 * 焦点在滚动容器自己身上时，三个键一动不动。给它加 `tabindex` 只让 `keydown` 进得来，
	 * 原生滚动照样不发生。所以「按一次 PageUp 上移约一屏」在浏览器默认行为下**不成立**。
	 *
	 * **位移仍然只有 `setScrollTop` 一个入口**：这里是「人在动」，所以走 `reason="user-return"`，
	 * 由仲裁者记账、下一帧认领 —— 否则这笔位移会被当成程序写的，补偿会跟它打架。
	 * 一次按键就是一次动作，`settle()` 会在它停下来的那一帧结算，贴顶该补页就补一页。
	 */
	const onKey = useCallback(
		(event: KeyboardEvent): void => {
			const flow = flowRef.current;
			if (flow === null) return;
			// 输入框 / 可编辑区里的键位归它们自己（上下键选候选词之类），不许抢。
			const target = event.target as HTMLElement | null;
			if (target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
			if (event.metaKey || event.ctrlKey || event.altKey) return;

			const viewport = flow.clientHeight;
			// 一屏 = 视口高度减去两行留白，这样「上一次最上面那行」还能看见，人不会迷路。
			const step = Math.max(40, viewport - 2 * DEFAULT_ROW_HEIGHT);
			const bottom = flow.scrollHeight - viewport;
			let target2: number | null = null;
			switch (event.key) {
				case "PageUp":
					target2 = flow.scrollTop - step;
					break;
				case "PageDown":
					target2 = flow.scrollTop + step;
					break;
				case "Home":
					target2 = 0;
					break;
				case "End":
					target2 = bottom;
					break;
				default:
					return;
			}
			// 认了这个键就要吃掉默认行为：不 preventDefault 的话，浏览器那套「一步跳到 0」
			// 会在我们写完之后再写一次，等于把上面那条实测到的毛病原样带回来。
			event.preventDefault();
			const clamped = Math.min(bottom, Math.max(0, target2));
			// 走唯一入口，`reason="user-return"`（这是人在动）。位移的记账由它在同一个同步块里做完。
			// **不要额外 `claim()`**：那是给「浏览器自己写很多帧」的平滑滚动用的，按一次键写一次，
			// 认领之后反而会把接下来 800ms 里人真正的滚动全当成程序在动。
			// 已经贴顶还按 PageUp / Home：`clamped` 和当前位置相等，位置不会动 —— `sample()`
			// 看不到这一笔（它只认「`scrollTop` 变了」），补页就不会发生。真机实测：贴顶后
			// PageUp 三下 + Home 两下，191 条、first 9619 一动不动；同一个位置用滚轮撞是会补的
			// （106→134→163→191），差别只在滚轮把「撞了」直接报给了仲裁者。
			// 所以键盘撞边界也走同一个入口 `push()` —— 不另开一套补页，补页权仍只归结算。
			const hitEdge = clamped === flow.scrollTop;
			const direction = event.key === "PageUp" || event.key === "Home" ? "up" : "down";
			setScrollTop(clamped, "user-return");
			if (hitEdge) arbiter.current?.push(direction);
			if (event.key === "End") setAtBottom(true);
			if (event.key === "Home") setAtBottom(false);
			// 叫醒取样循环：`settle()` 要看到这一笔位移才结算，不叫醒它就没人补页。
			wake();
		},
		[setAtBottom, setScrollTop, wake],
	);

	useEffect(() => {
		const flow = flowRef.current;
		if (flow === null) return;
		// 任何会让位置动的输入都唤醒取样循环：滚轮、键盘、拖滚动条（`scroll`）、触摸。
		const onInput = (): void => wake();
		/**
		 * 滚轮要多做一件事：**贴顶还往上推、贴底还往下推时位置不会变**，`sample()` 看不见，
		 * 而那一刻正是补页该发生的时候。7791：离开顶部再滚回来每轮都补一页，停在顶部继续撞
		 * 就一动不动（24→30→37→43→50 之后停住）。这里把「撞」这个事实直接报给仲裁者。
		 */
		const onWheel = (event: WheelEvent): void => {
			if (event.deltaY !== 0) arbiter.current?.push(event.deltaY < 0 ? "up" : "down");
			wake();
		};
		flow.addEventListener("scroll", onInput, { passive: true });
		flow.addEventListener("wheel", onWheel, { passive: true });
		flow.addEventListener("touchstart", onInput, { passive: true });
		// 键必须挂在 `window` 上，不能挂在 `flow` 上：`.flow` 没有 `tabIndex`，永远不是焦点，
		// 平时焦点在 `body`（真机实测 `tgt: BODY`）—— 挂在 `flow` 上的 `keydown` 一次都收不到，
		// 表现就是「键到了页面、`scrollTop` 恒 0、什么都不动」。
		// 只在「当前就在这个频道」时才认，别把它变成全局快捷键。
		const onKeyWindow = (event: KeyboardEvent): void => {
			if (detail === null) return;
			if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target;
			// 输入框 / 可编辑区域里的方向键归打字，不抢。
			if (target instanceof HTMLElement) {
				const tag = target.tagName;
				if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
			}
			onKey(event);
		};
		window.addEventListener("keydown", onKeyWindow);
		return () => {
			flow.removeEventListener("scroll", onInput);
			flow.removeEventListener("wheel", onWheel);
			flow.removeEventListener("touchstart", onInput);
			window.removeEventListener("keydown", onKeyWindow);
			if (sampler.current !== null) cancelAnimationFrame(sampler.current);
			sampler.current = null;
		};
	}, [onKey, wake, detail]);

	/**
	 * 仲裁者：容器换了（切频道会重挂 `.flow`）就新建一个，读数基准按新容器来。
	 *
	 * `read` / `write` 是它对 DOM 的唯一入口 —— 因此 `Stream.tsx` 里不许再出现第二处
	 * 给 `scrollTop` 赋值的地方（单测 `stream-source-contract` 钉住）。
	 */
	useLayoutEffect(() => {
		const flow = flowRef.current;
		if (flow === null) {
			arbiter.current = null;
			return;
		}
		arbiter.current = createArbiter({
			read: () => ({ top: flow.scrollTop, height: flow.scrollHeight, client: flow.clientHeight }),
			write: (top) => {
				flow.scrollTop = top;
			},
		});
		heights.current.clear();
		// 一条都还没量到之前，模型按估算行高算 —— `offsetOf` 立刻就有数，锚点补偿不用等第一帧。
		layout.current = buildHeights(rowsRef.current.map((row) => ({ key: row.key, height: DEFAULT_ROW_HEIGHT })));
		wake();
		return () => {
			arbiter.current = null;
			if (sampler.current !== null) cancelAnimationFrame(sampler.current);
			sampler.current = null;
		};
	}, [currentId, wake]);

	/**
	 * 进频道 / 切频道：**立刻 `toBottom()`**（用已经拿到的那一页），`fillOnEnter()` 在后台补。
	 *
	 * 顺序是 Solo 2026-11-11 纠的：先补再到底的话，用户会先看到一屏历史再被扔到底
	 * （验收第 1、2 条）。`fillOnEnter` 补回来的页只走锚点补偿，全程不把视线挪走。
	 */
	useLayoutEffect(() => {
		if (detail === null) return;
		const flow = flowRef.current;
		if (flow === null) return;
		/**
		 * 这一刻 `.flow-wrap` 的 `key` 刚从 `"none"` 变成频道 id —— 容器是**新挂上的**，
		 * 还一次布局都没做过（实测：写下去时 `scrollHeight` / `clientHeight` 都是 0，
		 * `getBoundingClientRect().height` 也是 0）。浏览器在零高度、不可滚动的盒子上把这次写
		 * 夹回 0 —— 于是「到底」没发生，而界面上也看不出错：位置就是 0，跟没进去一样。
		 *
		 * 所以等容器真的有高度再落这一次写；那之后读到的 `scrollHeight` 是真值，用它。
		 * 轮询用 rAF，最多几帧。
		 */
		let frames = 0;
		let cancelled = false;
		const land = (): void => {
			if (cancelled) return;
			if (flow.scrollHeight > 0 && flow.clientHeight > 0) {
				// 到这一刻这一屏**已经渲染完、布局也是真的**，`scrollHeight` 就是真值 ——
				// 用它不是 Solo 否掉的那个用法（他否的是「渲染前拿上一次的 scrollHeight 当目标」）。
				//
				// 模型这条路在这件事上不够用，实测差了 691px：`.feed` 里除了消息行还有不归模型管的块
				// （频道开头的 `solo-hero` 164px + 40px 上边距），行与行之间还有 4px 外边距 ——
				// `bottomOf` 只算「末行偏移 + 末行高」，这些全在模型外面，算出来 top=524 / 真实 max=1215。
				// 所以：能读真值就用真值，模型只在布局还没落地时兜底。
				measureRows();
				const model = bottomOf(flow);
				const real = Math.max(0, flow.scrollHeight - flow.clientHeight);
				setScrollTop(Math.max(model, real), "enter");
				setAtBottom(true);
				return;
			}
			frames += 1;
			if (frames > 30) return; // 半秒还没有布局：放弃写入，别把循环挂在这儿
			requestAnimationFrame(land);
		};
		land();
		void fillOnEnter();
		return () => {
			cancelled = true;
		};
		// 只在「进了这个频道、第一页到手」那一刻跑一次。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [currentId, detail === null]);

	/**
	 * 双击整行复制正文。
	 *
	 * 代码块里的「复制」按钮在 `.md` 里也占文字，所以先拿一份去掉按钮的副本再读
	 * `textContent`，否则剪贴板里会多出两个「复制」字。
	 */
	const copy = useCallback((node: HTMLElement): void => {
		const body = node.querySelector(".md");
		const clean = body?.cloneNode(true);
		if (clean instanceof HTMLElement) {
			for (const button of clean.querySelectorAll(`.${CODE_COPY_CLASS}`)) button.remove();
		}
		void copyText(clean?.textContent ?? "");
	}, []);

	/**
	 * 点引用的那一行 → 滚到被引用的那条消息，并亮一下。
	 *
	 * 只在这一屏已渲染的消息里找（`data-seq`）：被引用的话要是早于已加载的历史，
	 * 就什么都不做 —— 宁可不跳，也别把「没找到」画成一条错误。
	 */
	const jumpTo = useCallback((seq: number, node: HTMLElement): void => {
		const target = node.closest(".feed")?.querySelector(`[data-seq="${seq}"]`);
		if (!(target instanceof HTMLElement)) return;
		arbiter.current?.claim();
		target.scrollIntoView({ block: "center", behavior: "smooth" });
		target.classList.remove("row-flash");
		// 重新触发动画：先移除再加回来，同一帧里要读一次布局
		void target.offsetWidth;
		target.classList.add("row-flash");
		window.setTimeout(() => target.classList.remove("row-flash"), 1600);
	}, []);

	return (
		// 换频道就重挂一次，整块消息流淡上来（`.flow-wrap` 的入场动画在 v6.css）。
		<div className="flow-wrap" key={detail?.channel.id ?? "none"}>
			<div className="flow" id="flow" ref={flowRef}>
				<div className="flow-inner" id="flow-inner">
					<div className="flow-top" id="flow-top" data-active={loadingEarlier ? "true" : "false"}>
						{loadingEarlier ? <span className="flow-spinner" role="status" aria-label="正在读更早的消息" /> : null}
					</div>

					{detail === null ? <Skeleton /> : null}

					{/* 插槽：消息流顶上一条横幅（第一条消息上方，仍在滚动区里）。 */}
					<Slot name="stream.banner" />

					<div className="feed" id="feed" ref={feedRef}>
						{hero === null ? null : <SoloHero hero={hero} />}
						{detail !== null && rows.length === 0 ? <Empty channelId={detail.channel.id} /> : null}
						{rows.map((row) => (
							<RowView
								key={row.key}
								row={row}
								labels={labels}
								onCopy={copy}
								onPick={(message, name) => setPicked({ message, name })}
								onImage={props.onImage}
								onFile={props.onFile}
								onJump={jumpTo}
								onJumpLatest={() => {
									toBottom("user-return", "smooth");
								}}
							/>
						))}
					</div>

				</div>
			</div>
			{/* 点一条消息：底下压一层，动作从底部升上来（稿子 19）。 */}
			{picked === null ? null : (
				<div className="press" role="dialog" aria-modal="true" onClick={() => setPicked(null)}>
					<div className="asheet" onClick={(event) => event.stopPropagation()}>
						<div className="asheet-quote">
							<div className="asheet-who">
								{picked.name} · {clockTime(picked.message.at)}
							</div>
							<div className="asheet-text">{picked.message.text}</div>
						</div>
						<button
							type="button"
							className="arow"
							onClick={() => {
								void copyText(picked.message.text);
								setPicked(null);
							}}
						>
							<span className="ai" aria-hidden="true">
								<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
									<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5" />
									<path d="M15.5 8.5v-2a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2" />
								</svg>
							</span>
							复制文字
						</button>
						<button
							type="button"
							className="arow"
							onClick={() => {
								setReply({
									seq: picked.message.seq,
									label: picked.name,
									excerpt: picked.message.text.slice(0, 60),
								});
								setPicked(null);
							}}
						>
							<span className="ai" aria-hidden="true">
								<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
									<path d="M9.5 7 4 12l5.5 5" />
									<path d="M4 12h9.5a5.5 5.5 0 0 1 5.5 5.5V19" />
								</svg>
							</span>
							引用回复
						</button>
						{picked.message.fromSlug === "owner" ? null : (
							<button
								type="button"
								className="arow"
								onClick={() => {
									void openPerson(picked.message.fromSlug);
									setPicked(null);
								}}
							>
								<span className="ai" aria-hidden="true">
									<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
										<circle cx="12" cy="8.2" r="3.4" />
										<path d="M5 20c.6-3.6 3.5-5.6 7-5.6s6.4 2 7 5.6" />
									</svg>
								</span>
								看看是谁 · {picked.name}
							</button>
						)}
					</div>
					<button type="button" className="acancel" onClick={() => setPicked(null)}>
						取消
					</button>
				</div>
			)}

			{/* 在滚动容器**外面**：它一进滚动区就算进 scrollHeight，滚到底永远差它那几十像素。 */}
			<button
				type="button"
				className="to-bottom"
				id="to-bottom"
				hidden={atBottom}
				onClick={() => toBottom("user-return", "smooth")}
			>
				回到最新
			</button>
		</div>
	);
}

function RowView(props: {
	row: Row;
	labels: Map<string, { label: string; role: string; assistant: boolean }>;
	onCopy: (node: HTMLElement) => void;
	onPick: (message: Message, name: string) => void;
	onImage: (src: string) => void;
	onFile: (file: Attachment) => void;
	onJump: (seq: number, node: HTMLElement) => void;
	/** 「跳到最新」：滚到底。 */
	onJumpLatest: () => void;
}): JSX.Element {
	const { row } = props;
	if (row.type === "placeholder") {
		// 一页里只让第一行带文案，其余是等高的灰条 —— 画 12 句「正在加载」会晃眼。
		return (
			<div className="row row-placeholder" data-row-key={row.key} aria-busy="true">
				{row.key !== "ph-0" ? (
					<span className="ph-bar" aria-hidden="true" />
				) : row.failed ? (
					<button type="button" className="ph-retry" onClick={() => void loadEarlier()}>
						没加载出来 · 重试
					</button>
				) : (
					<span className="ph-loading">正在读更早的消息…</span>
				)}
			</div>
		);
	}
	if (row.type === "ceiling") {
		// 验收第 21 条：到头了要有一句话。没有它，用户按了半天没反应，看起来就是卡死。
		return (
			<div className="row row-ceiling" data-row-key={row.key}>
				到最上面了
			</div>
		);
	}
	if (row.type === "divider") {
		return (
			<div className="row-divider" data-row-key={row.key}>
				<span>{row.label}</span>
			</div>
		);
	}
	if (row.type === "unread") {
		// 一条横线加一句「以下是新的」，右边是「跳到最新」—— 189 条未读时人需要一个落点，
		// 而不是从头往下翻。`data-row="unread"` 给「跳到未读」定位用。
		return (
			<div className="row-unread" data-row="unread" data-row-key={row.key}>
				<span className="row-unread-label">以下是新的 · {row.count} 条</span>
				<button type="button" className="row-unread-jump" onClick={props.onJumpLatest}>
					跳到最新
				</button>
			</div>
		);
	}
	if (row.type === "say")
		return (
			<SayRow
				row={row}
				labels={props.labels}
				onCopy={props.onCopy}
				onPick={props.onPick}
				onImage={props.onImage}
				onFile={props.onFile}
				onJump={props.onJump}
			/>
		);
	if (row.type === "live") {
		return (
			<div className="row-live-wrap" data-row-key={row.key}>
				<LiveRow
					turn={row.turn}
					role={props.labels.get(row.turn.slug)?.role ?? ""}
					assistant={props.labels.get(row.turn.slug)?.assistant === true}
					onOpen={openTasks}
				/>
			</div>
		);
	}
	// 后台命令跑完的留痕：正文是一坨终端输出，是给干活那个人看的。我这边收成一行，
	// 想看就点开 —— 它要是平铺，一屏对话里就插进二十行日志。
	if (row.message.noteOf === "run") {
		const [head = "", ...rest] = row.message.text.split("\n");
		return (
			<div className="row row-note row-note-run" data-seq={row.message.seq} data-row-key={row.key}>
				<details className="note-fold">
					<summary>
						<span className="note-mark" aria-hidden="true">
							i
						</span>
						<span className="note-text">{head}</span>
						<span className="row-time">{clockTime(row.message.at)}</span>
					</summary>
					<pre className="note-body">{rest.join("\n")}</pre>
				</details>
			</div>
		);
	}
	return (
		<div className="row row-note" data-seq={row.message.seq} data-row-key={row.key}>
			<div className="note-mark" aria-hidden="true">
				i
			</div>
			<span className="note-text">{row.message.text}</span>
			<span className="row-time">{clockTime(row.message.at)}</span>
		</div>
	);
}

function SayRow(props: {
	row: Extract<Row, { type: "say" }>;
	labels: Map<string, { label: string; role: string; assistant: boolean }>;
	onCopy: (node: HTMLElement) => void;
	onPick: (message: Message, name: string) => void;
	onImage: (src: string) => void;
	onFile: (file: Attachment) => void;
	onJump: (seq: number, node: HTMLElement) => void;
}): JSX.Element {
	const { row } = props;
	const message = row.message;
	const owner = message.fromSlug === "owner";
	const known = props.labels.get(message.fromSlug);
	const name = known?.label ?? message.fromLabel;
	// 我不在名册里，`member.role` 会漏出 slug（`owner`），所以硬性不给。
	const role = owner ? "" : (known?.role ?? "");

	return (
		<div
			className="row row-say"
			data-seq={message.seq}
			data-row-key={row.key}
			data-grouped={row.grouped ? "true" : "false"}
			data-cont={row.cont ? "true" : "false"}
			data-owner={owner ? "true" : "false"}
			data-need={row.need ? "true" : "false"}
			onDoubleClick={(event) => {
				const node = event.currentTarget;
				props.onCopy(node);
			}}
		>
			{owner ? (
				<div
					className="row-av"
					dangerouslySetInnerHTML={{
						__html: avatarSvg({
							slug: message.fromSlug,
							name,
							size: 40,
							state: "idle",
							assistant: known?.assistant === true,
						}),
					}}
				/>
			) : (
				<button
					type="button"
					className="row-av"
					aria-label={`看 ${name} 的资料`}
					title={`看 ${name} 的资料`}
					onClick={(event) => {
						event.stopPropagation();
						void openPerson(message.fromSlug);
					}}
					dangerouslySetInnerHTML={{
						__html: avatarSvg({
							slug: message.fromSlug,
							name,
							size: 40,
							state: "idle",
							assistant: known?.assistant === true,
						}),
					}}
				/>
			)}
			<div
				className="row-body"
				onClick={(event) => {
					// 链接、按钮、代码块里的东西各有各的用处；选了字也别弹层。
					const target = event.target;
					// 正文里贴的图：点一下开大图（和附件缩略图同一个灯箱），别落到「看这个人的资料」。
					const picture = target instanceof Element ? target.closest(".md-img img") : null;
					if (picture instanceof HTMLImageElement) {
						props.onImage(picture.src);
						return;
					}
					if (target instanceof Element && target.closest("a, button, summary, pre, input, textarea") !== null) return;
					if ((window.getSelection()?.toString() ?? "") !== "") return;
					props.onPick(message, name);
				}}
			>
				<div className="row-head">
					<span className="row-name">{name}</span>
					{role === "" ? null : <span className="row-role">{role}</span>}
					{row.need ? <span className="need-tag">需要你</span> : null}
					<span className="row-time">{clockTime(message.at)}</span>
				</div>

				{message.replyTo === undefined ? null : (
					<button
						type="button"
						className="row-quote"
						title="跳到这条消息"
						onClick={(event) => {
							// 别冒到整行：点引用是「跳过去」，不是开动作层。
							event.stopPropagation();
							const reply = message.replyTo;
							if (reply === undefined) return;
							props.onJump(reply.seq, event.currentTarget);
						}}
					>
						<span className="row-quote-who">{message.replyTo.fromLabel}</span>
						<span className="row-quote-text">{message.replyTo.excerpt}</span>
					</button>
				)}

				<Attachments attachments={message.attachments} onImage={props.onImage} onFile={props.onFile} />

				<div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
			</div>
		</div>
	);
}

function Attachments(props: {
	attachments?: readonly Attachment[] | undefined;
	onImage: (src: string) => void;
	onFile: (file: Attachment) => void;
}): JSX.Element | null {
	const list = props.attachments ?? [];
	if (list.length === 0) return null;
	const images = list.filter((item) => item.kind === "image");
	const files = list.filter((item) => item.kind !== "image");
	return (
		<>
			{images.length === 0 ? null : (
				<div className="attach-grid" data-count={String(Math.min(images.length, 4))}>
					{images.map((item) => (
						<button
							key={item.id}
							type="button"
							className="attach-thumb"
							onClick={() => props.onImage(uploadUrl(item.id))}
						>
							{/* 列表里这一格只要看得清，不该拉原图：加 `?preview=1` 走后端缩图。
							    点开大图那一下仍然用原图地址（上面 `onImage`）。 */}
							<img
								src={`${uploadUrl(item.id)}?preview=1`}
								alt={item.name}
								loading="lazy"
								onError={(event) => {
									// 缩图编不出来（后端返回坏图）时退回原图，不能留个白框。
									const node = event.currentTarget;
									if (node.dataset.fallback === "1") return;
									node.dataset.fallback = "1";
									node.src = uploadUrl(item.id);
								}}
							/>
						</button>
					))}
				</div>
			)}
			{files.length === 0 ? null : (
				<div className="attach-files">
					{files.map((item) => (
						// 点开先看，看不成的（zip、二进制）预览层里会写「点下载」。
						<button
							key={item.id}
							type="button"
							className="attach-file"
							onClick={() => props.onFile(item)}
						>
							<span className="attach-ico" aria-hidden="true">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
									<path d="M5 4h9l5 5v11H5z" />
									<path d="M14 4v5h5" />
								</svg>
							</span>
							<span className="attach-name">{item.name}</span>
							<span className="attach-size">{humanBytes(item.bytes)}</span>
						</button>
					))}
				</div>
			)}
		</>
	);
}

/** 和助理那一页的抬头（v6 D01）：标识 + 名字 + 状态 + 今天跑了多少。 */
function SoloHero(props: { hero: { slug: string; name: string; state: string; meta: string } }): JSX.Element {
	const state = props.hero.state === "working" ? "在做" : props.hero.state === "thinking" ? "在想" : "待命";
	return (
		<div className="solo-hero">
			<span
				className="solo-hero-mark"
				aria-hidden="true"
				dangerouslySetInnerHTML={{
					__html: avatarSvg({ slug: props.hero.slug, name: props.hero.name, size: 64, state: "idle", assistant: true }),
				}}
			/>
			<div className="solo-hero-name">{props.hero.name}</div>
			<div className="solo-hero-sub">
				<span className="presence">
					<span className="dot" />
					助理 · {state}
				</span>
			</div>
			<div className="solo-hero-meta">{props.hero.meta}</div>
		</div>
	);
}

function Skeleton(): JSX.Element {
	return (
		<div className="skel" id="skel" aria-hidden="true">
			{[0, 1, 2].map((index) => (
				<div className="sk-row" key={index}>
					<span className="sk-av" />
					<span className="sk-body">
						<span className="sk-bar" style={{ width: `${String(28 + index * 8)}%` }} />
						<span className="sk-bar" style={{ width: `${String(64 - index * 12)}%` }} />
					</span>
				</div>
			))}
		</div>
	);
}

/**
 * 空频道：还没开始，不是出错。
 *
 * 这一屏只有一个任务 —— 让我知道「跟谁说话、怎么开口」。所以画面上只放三样：
 * 这个频道里的人（叠头像）、一句标题、一句怎么做；下面给一排可以点的 `@名字`。
 * 点胶囊**不直接发消息**，只把 `@名字 ` 写进输入框：发不发、说什么还是我来定。
 */
function Empty(_props: { channelId: string }): JSX.Element {
	const people = useStore((state) => state.people);
	const detail = useStore((state) => state.detail);
	const members = (detail?.members ?? []).filter((member) => member.slug !== "owner");
	const fallback = people.slice(0, 4).map((actor) => ({
		slug: actor.slug,
		label: actor.label,
		assistant: actor.assistant === true,
	}));
	const picks = (
		members.length > 0
			? members.map((member) => ({
					slug: member.slug,
					label: member.label,
					assistant: member.role === "assistant",
				}))
			: fallback
	).slice(0, 4);
	const isDm = detail?.channel.kind === "dm";
	const other = picks[0]?.label;

	const title = isDm && other !== undefined ? `还没和${other}说过话` : "这个频道还没有消息";
	const hint = isDm
		? "直接说你想做什么，他会回你。"
		: picks.length === 0
			? "直接说你想做什么。"
			: "说点什么，或者 @ 一个人开始。";

	return (
		<div className="ch-empty">
			<div className="ch-empty-card">
				<div
					className="ch-empty-art"
					aria-hidden="true"
					dangerouslySetInnerHTML={{
						__html:
							picks.length <= 1
								? avatarSvg({
										slug: picks[0]?.slug ?? "all",
										name: other ?? "全员",
										size: 64,
										state: "idle",
										assistant: picks[0]?.assistant === true,
									})
								: groupAvatar({ people: picks, size: 64 }),
					}}
				/>
				<p className="ch-empty-title">{title}</p>
				<p className="ch-empty-hint">{hint}</p>
				{isDm || picks.length === 0 ? null : (
					<div className="ch-empty-people">
						{picks.map((pick) => (
							<button
								key={pick.slug}
								type="button"
								className="ch-empty-chip"
								onClick={() => {
									setReply(null);
									const input = document.querySelector<HTMLTextAreaElement>("#input");
									if (input === null) return;
									input.value = "";
									input.focus();
									// 用原生 setter 写值，再派发 input 让 React 的受控组件跟上。
									const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
									setter?.call(input, `@${pick.label} `);
									input.dispatchEvent(new Event("input", { bubbles: true }));
								}}
							>
								<span
									className="ch-empty-av"
									dangerouslySetInnerHTML={{
										__html: avatarSvg({
											slug: pick.slug,
											name: pick.label,
											size: 20,
											state: "idle",
											assistant: pick.assistant,
										}),
									}}
								/>
								{pick.label}
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
