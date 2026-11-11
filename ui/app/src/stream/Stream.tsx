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
import { seqOfRow, VirtualFeed } from "./VirtualFeed.tsx";
import type { VirtualFeedHandle } from "./VirtualFeed.tsx";
import { Slot } from "../plugin/Slot.tsx";
import { loadEarlier, openPerson, openTasks, setReply } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";


export function Stream(props: { onImage: (src: string) => void; onFile: (file: Attachment) => void }): JSX.Element {
	const currentId = useStore((state) => state.currentId);
	const detail = useStore((state) => state.detail);
	const hasMore = useStore((state) => state.hasMore);
	const loadingEarlier = useStore((state) => state.loadingEarlier);
	const people = useStore((state) => state.people);
	const runs = useStore((state) => state.runs);
	const presence = useStore((state) => state.presence);
	const [atBottom, setAtBottom] = useState(true);
	/** 点开的那条消息（复制 / 引用 / 看人）。点外面或「取消」收起。 */
	const [picked, setPicked] = useState<{ message: Message; name: string } | null>(null);

	const flowRef = useRef<HTMLDivElement | null>(null);
	const feedRef = useRef<HTMLDivElement | null>(null);
	const anchor = useRef<{ seq: number; top: number } | null>(null);
	/** 窗口化之后，跳转得跟 `VirtualFeed` 要位置 —— 目标行多半没挂载。 */
	const feed = useRef<VirtualFeedHandle | null>(null);
	const pinned = useRef(true);

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
	const rows = useMemo(
		() =>
			buildRows({
				messages,
				running,
				now: Date.now(),
				// `exactOptionalPropertyTypes` 下不能显式传 undefined：没有未读就干脆不给这个字段。
				...(unreadBefore === null ? {} : { unreadBefore }),
			}),
		[messages, running, unreadBefore],
	);

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

	/* ── 贴底与位置保持 ─────────────────────────────────────────── */

	const isPinned = useCallback((): boolean => {
		const flow = flowRef.current;
		if (flow === null) return true;
		return flow.scrollHeight - flow.scrollTop - flow.clientHeight < 120;
	}, []);

	const toBottom = useCallback((behavior: ScrollBehavior = "auto") => {
		const flow = flowRef.current;
		if (flow === null) return;
		flow.scrollTo({ top: flow.scrollHeight, behavior });
		pinned.current = true;
		setAtBottom(true);
	}, []);

	/**
	 * 上翻加载之前先记住视口顶部那一行（按 seq 认，不按文本）。
	 *
	 * 窗口化之后不能再从 DOM 里找 `.row`：一次只挂几十行，要认的那一行可能刚好没挂。
	 * 所以问 `VirtualFeed`「视口顶上现在是哪条消息、它离顶多少像素」，它从高度表里算。
	 */
	const rememberAnchor = useCallback(() => {
		const feedWindow = feed.current;
		if (feedWindow === null) return;
		anchor.current = feedWindow.anchorAtViewportTop();
	}, []);

	// 新消息到达：贴底就跟到底，否则原地不动（否则看上翻历史时会被拽回来）。
	useLayoutEffect(() => {
		if (pinned.current) toBottom();
		else setAtBottom(false);
	}, [messages, toBottom]);

	/**
	 * 补历史之后：把锚点那一行按回原来的位置，屏幕上的字不动。
	 *
	 * 早先的写法是「`querySelector` 找到那一行、量它现在离顶多少、补差值」。
	 * 虚拟化之后 DOM 里根本没有它（在上一屏之外），只能靠高度表：让 `VirtualFeed`
	 * 告诉我它现在离顶多少，再把 `scrollTop` 挪回来。
	 */
	useLayoutEffect(() => {
		const saved = anchor.current;
		const feedWindow = feed.current;
		if (saved === null || feedWindow === null) return;
		feedWindow.restoreAnchor(saved);
		anchor.current = null;
	}, [messages]);

	useEffect(() => {
		const flow = flowRef.current;
		if (flow === null) return;
		const onScroll = (): void => {
			const pinnedNow = isPinned();
			pinned.current = pinnedNow;
			setAtBottom(pinnedNow);
		};
		flow.addEventListener("scroll", onScroll, { passive: true });
		return () => flow.removeEventListener("scroll", onScroll);
	}, [isPinned]);

	/**
	 * 切频道：有未读就落在「以下是新的」那条横幅上，没未读才到底。
	 *
	 * 以前是一律到底 —— 未读横幅画在 1000 条以外的顶上，等于没人看得见。
	 *
	 * 两个细节：
	 * - **没未读时行为一点都不变**：还是 `toBottom()`，连 rAF 那一拍都照旧。
	 * - 横幅还没画出来（`detail` 刚被清空那一瞬间）就等下一帧再试，最多等 20 帧
	 *   （约 0.3 秒）；等不到就到底 —— 宁可到底，也不能让用户停在半空。
	 */
	useEffect(() => {
		anchor.current = null;
		pinned.current = true;
		setAtBottom(true);
		if (unreadBefore === null) {
			requestAnimationFrame(() => toBottom());
			return;
		}
		let tries = 0;
		let frame = 0;
		const jump = (): void => {
			const flow = flowRef.current;
			const banner = flow?.querySelector<HTMLElement>('[data-row="unread"]') ?? null;
			if (flow !== null && banner !== null) {
				// 横幅贴到视口顶上那一行：它上面留一屏上下文，人往下读就是新消息。
				const offset = banner.getBoundingClientRect().top - flow.getBoundingClientRect().top;
				flow.scrollTop += offset;
				// 落点不在底 → 不算贴底，不然下一条新消息会把人拽回底部。
				const nowPinned = isPinned();
				pinned.current = nowPinned;
				setAtBottom(nowPinned);
				return;
			}
			tries += 1;
			if (tries > 20) {
				toBottom();
				return;
			}
			frame = requestAnimationFrame(jump);
		};
		frame = requestAnimationFrame(jump);
		return () => cancelAnimationFrame(frame);
	}, [currentId, toBottom, unreadBefore, isPinned]);

	const onTop = useCallback(() => {
		if (!hasMore || loadingEarlier) return;
		rememberAnchor();
		void loadEarlier();
	}, [hasMore, loadingEarlier, rememberAnchor]);

	/**
	 * 上翻自动补历史：滚到顶部就自己加载，没有按钮。
	 *
	 * 两个触发点：滚到离顶 120px 以内，以及「这一屏还没填满但还有更早的」——
	 * 后者是短频道刚打开时的样子，不补的话会看到一屏空白和一句提示。
	 * 补完内容还不够高，`loadingEarlier` 落回 false 时这个 effect 会再跑一次，接着补。
	 */
	useEffect(() => {
		const flow = flowRef.current;
		if (flow === null) return;
		const maybeLoad = (): void => {
			const nearTop = flow.scrollTop < 120;
			const notFilled = flow.scrollHeight <= flow.clientHeight + 40;
			if ((nearTop || notFilled) && hasMore && !loadingEarlier) onTop();
		};
		flow.addEventListener("scroll", maybeLoad, { passive: true });
		const frame = requestAnimationFrame(maybeLoad);
		return () => {
			flow.removeEventListener("scroll", maybeLoad);
			cancelAnimationFrame(frame);
		};
	}, [hasMore, loadingEarlier, onTop, messages]);

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
	 * 窗口化之后不能再靠 `querySelector`：一次只挂几十行，被引用的那条多半在几千里外、
	 * 根本没挂载，`querySelector` 找不到就 `return`，于是「点引用永远没反应」。
	 * 所以改成**按 seq 反查**：位置在 `VirtualFeed` 的高度表里，让它滚过去。
	 *
	 * 滚过去之后那一行要下一帧才挂出来，所以高亮要等：等到了再闪，等不到（超过一小会儿）
	 * 就什么都不做 —— 宁可不闪，也不能报错、不能把视线挪到别处。
	 */
	const jumpTo = useCallback((seq: number, _node: HTMLElement): void => {
		const feedWindow = feed.current;
		if (feedWindow === null) return;
		if (!feedWindow.jumpToSeq(seq)) return;
		// 等它挂出来（通常下一帧就到），到了再闪一下。
		let tries = 0;
		const flash = (): void => {
			const flow = flowRef.current;
			const target = flow?.querySelector<HTMLElement>(`[data-seq="${String(seq)}"]`) ?? null;
			if (target === null) {
				tries += 1;
				if (tries > 10) return;
				requestAnimationFrame(flash);
				return;
			}
			target.classList.remove("row-flash");
			// 重新触发动画：先移除再加回来，同一帧里要读一次布局
			void target.offsetWidth;
			target.classList.add("row-flash");
			window.setTimeout(() => target.classList.remove("row-flash"), 1600);
		};
		requestAnimationFrame(flash);
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
						{/* 只挂视口附近的行（`VirtualFeed`）：5000 条的频道不再一次性塞满 DOM。 */}
						<VirtualFeed
							items={rows}
							scroller={flowRef}
							scope={detail?.channel.id ?? ""}
							handle={feed}
							seqOf={seqOfRow}
							// `atBottom` 就是「贴底没」：滚动事件里同步过，新消息到达时 `toBottom()` 也会置真。
							pinned={atBottom}
							render={(index) => {
								const row = rows[index];
								if (row === undefined) return null;
								return (
									<RowView
										row={row}
										labels={labels}
										onCopy={copy}
										onPick={(message, name) => setPicked({ message, name })}
										onImage={props.onImage}
										onFile={props.onFile}
										onJump={jumpTo}
										onJumpLatest={() => {
											toBottom("smooth");
										}}
									/>
								);
							}}
						/>
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
				onClick={() => toBottom("smooth")}
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
	if (row.type === "divider") {
		return (
			<div className="row-divider">
				<span>{row.label}</span>
			</div>
		);
	}
	if (row.type === "unread") {
		// 一条横线加一句「以下是新的」，右边是「跳到最新」—— 189 条未读时人需要一个落点，
		// 而不是从头往下翻。`data-row="unread"` 给「跳到未读」定位用。
		return (
			<div className="row-unread" data-row="unread">
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
			<LiveRow
				turn={row.turn}
				role={props.labels.get(row.turn.slug)?.role ?? ""}
				assistant={props.labels.get(row.turn.slug)?.assistant === true}
				onOpen={openTasks}
			/>
		);
	}
	// 后台命令跑完的留痕：正文是一坨终端输出，是给干活那个人看的。我这边收成一行，
	// 想看就点开 —— 它要是平铺，一屏对话里就插进二十行日志。
	if (row.message.noteOf === "run") {
		const [head = "", ...rest] = row.message.text.split("\n");
		return (
			<div className="row row-note row-note-run" data-seq={row.message.seq}>
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
		<div className="row row-note" data-seq={row.message.seq}>
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
							<img src={uploadUrl(item.id)} alt={item.name} loading="lazy" />
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
