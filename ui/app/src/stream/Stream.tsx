/**
 * 消息流。
 *
 * 这个文件只做三件事：把 `buildRows()` 算出来的行画出来、维护「贴底」与「上翻加载」。
 *
 * 屏幕上只有消息（`say` / `note`）和一条**正在跑的占位**（`live` 行，ADR-046）。
 * 占位是派生出来的：跑完就消失，真实回复顶上来；历史过程进「后台任务」面板。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Attachment, Turn } from "../api/types.ts";
import { uploadUrl } from "../api/client.ts";
import { avatarSvg, groupAvatar } from "../lib/avatar.ts";
import { clockTime, copyText, humanBytes } from "../lib/format.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { CODE_COPY_CLASS } from "../lib/copy-code.ts";
import { buildRows } from "./model.ts";
import type { Row } from "./model.ts";
import { LiveRow } from "./LiveRow.tsx";
import { RunBlock } from "./RunBlock.tsx";
import { Slot } from "../plugin/Slot.tsx";
import { loadEarlier, openTasks, setReply } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";

const COPY_ICON =
	'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a2 2 0 0 0-2 2v9"/></svg>';
const DONE_ICON =
	'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';
const REPLY_ICON =
	'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7 4 12l5 5"/><path d="M4 12h9a7 7 0 0 1 7 7v1"/></svg>';

export function Stream(props: { onImage: (src: string) => void; onFile: (file: Attachment) => void }): JSX.Element {
	const currentId = useStore((state) => state.currentId);
	const detail = useStore((state) => state.detail);
	const hasMore = useStore((state) => state.hasMore);
	const loadingEarlier = useStore((state) => state.loadingEarlier);
	const people = useStore((state) => state.people);
	const runs = useStore((state) => state.runs);
	const [atBottom, setAtBottom] = useState(true);

	const flowRef = useRef<HTMLDivElement | null>(null);
	const feedRef = useRef<HTMLDivElement | null>(null);
	const anchor = useRef<{ seq: number; top: number } | null>(null);
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
	// 已经回话的那几轮：它们的 `replySeq` 决定过程块挂在哪条消息上面。
	const settled = useMemo(() => {
		const out: Turn[] = [];
		for (const list of runs.values()) {
			for (const turn of list) {
				if (turn.channelId !== currentId || turn.replySeq === undefined) continue;
				out.push(turn);
			}
		}
		return out;
	}, [runs, currentId]);
	const rows = useMemo(() => buildRows({ messages, running, settled, now: Date.now() }), [messages, running, settled]);

	const labels = useMemo(() => {
		const map = new Map<string, { label: string; role: string }>();
		for (const actor of people) map.set(actor.slug, { label: actor.label, role: actor.title });
		if (detail !== null) {
			for (const member of detail.members) {
				// 名册里没有这个人时（理论上不该发生）用频道的成员表兜底。`role` 是
				// `owner|assistant|member` 三个机器值，只有 `assistant` 值得印在名字后面。
				if (!map.has(member.slug)) {
					map.set(member.slug, { label: member.label, role: member.role === "assistant" ? "助理" : "" });
				}
			}
		}
		return map;
	}, [people, detail]);

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

	// 上翻加载之前先记住视口顶部那一行（按 seq 认，不按文本）。
	const rememberAnchor = useCallback(() => {
		const flow = flowRef.current;
		const feed = feedRef.current;
		if (flow === null || feed === null) return;
		const top = flow.getBoundingClientRect().top;
		for (const node of feed.querySelectorAll<HTMLElement>(".row")) {
			const rect = node.getBoundingClientRect();
			if (rect.bottom > top + 4) {
				anchor.current = { seq: Number(node.dataset["seq"] ?? "0"), top: rect.top - top };
				return;
			}
		}
	}, []);

	// 新消息到达：贴底就跟到底，否则原地不动（否则看上翻历史时会被拽回来）。
	useLayoutEffect(() => {
		if (pinned.current) toBottom();
		else setAtBottom(false);
	}, [messages, toBottom]);

	// 补历史之后：按锚点行补回滚动的差值，屏幕上的字不动。
	useLayoutEffect(() => {
		const saved = anchor.current;
		const flow = flowRef.current;
		const feed = feedRef.current;
		if (saved === null || flow === null || feed === null) return;
		const node = feed.querySelector<HTMLElement>(`[data-seq="${String(saved.seq)}"]`);
		if (node === null) return;
		const delta = node.getBoundingClientRect().top - flow.getBoundingClientRect().top - saved.top;
		if (Math.abs(delta) > 1) flow.scrollTop += delta;
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

	// 切频道：到底部。
	useEffect(() => {
		anchor.current = null;
		pinned.current = true;
		requestAnimationFrame(() => toBottom());
	}, [currentId, toBottom]);

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
		void copyText(clean?.textContent ?? "").then((ok) => {
			if (!ok) return;
			const button = node.querySelector<HTMLElement>('[data-act="copy"]');
			if (button === null) return;
			button.dataset["done"] = "true";
			button.innerHTML = DONE_ICON;
			window.setTimeout(() => {
				delete button.dataset["done"];
				button.innerHTML = COPY_ICON;
			}, 1200);
		});
	}, []);

	return (
		<div className="flow-wrap">
			<div className="flow" id="flow" ref={flowRef}>
				<div className="flow-inner" id="flow-inner">
					<div className="flow-top" id="flow-top" data-active={loadingEarlier ? "true" : "false"}>
						{loadingEarlier ? <span className="flow-spinner" role="status" aria-label="正在读更早的消息" /> : null}
					</div>

					{detail === null ? <Skeleton /> : null}

					{/* 插槽：消息流顶部（第一条消息上方）。 */}
					<Slot name="stream.top" />

					<div className="feed" id="feed" ref={feedRef}>
						{detail !== null && rows.length === 0 ? <Empty channelId={detail.channel.id} /> : null}
						{rows.map((row) => (
							<RowView key={row.key} row={row} labels={labels} onCopy={copy} onImage={props.onImage} onFile={props.onFile} />
						))}
					</div>

					{/* 插槽：消息流底部（最后一条消息之后，仍在滚动区里）。 */}
					<Slot name="stream.bottom" />
				</div>
			</div>
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
	labels: Map<string, { label: string; role: string }>;
	onCopy: (node: HTMLElement) => void;
	onImage: (src: string) => void;
	onFile: (file: Attachment) => void;
}): JSX.Element {
	const { row } = props;
	if (row.type === "divider") {
		return (
			<div className="row-divider">
				<span>{row.label}</span>
			</div>
		);
	}
	if (row.type === "say")
		return (
			<SayRow
				row={row}
				labels={props.labels}
				onCopy={props.onCopy}
				onImage={props.onImage}
				onFile={props.onFile}
			/>
		);
	if (row.type === "live") {
		return (
			<LiveRow turn={row.turn} role={props.labels.get(row.turn.slug)?.role ?? ""} onOpen={openTasks} />
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
	labels: Map<string, { label: string; role: string }>;
	onCopy: (node: HTMLElement) => void;
	onImage: (src: string) => void;
	onFile: (file: Attachment) => void;
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
			<div
				className="row-av"
				dangerouslySetInnerHTML={{
					__html: avatarSvg({ slug: message.fromSlug, name, size: 40, state: "idle" }),
				}}
			/>
			<div className="row-body">
				<div className="row-head">
					<span className="row-name">{name}</span>
					{role === "" ? null : <span className="row-role">{role}</span>}
					{row.need ? <span className="need-tag">需要你</span> : null}
					<span className="row-time">{clockTime(message.at)}</span>
				</div>

				{/* 这一轮怎么做的：思考 / 命令 / 文件，折叠一行，点开是步骤树。
				    复用后台任务面板那一套（`RunBlock`），不给聊天流再造一份。 */}
				{row.turn === undefined ? null : (
					<div className="row-process">
						<RunBlock turn={row.turn} role={role} grouped />
					</div>
				)}

				{message.replyTo === undefined ? null : (
					<div className="row-quote">
						<span className="row-quote-who">{message.replyTo.fromLabel}</span>
						<span className="row-quote-text">{message.replyTo.excerpt}</span>
					</div>
				)}

				<Attachments attachments={message.attachments} onImage={props.onImage} onFile={props.onFile} />

				<div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />

				<div className="row-tools">
					<button
						type="button"
						className="tool"
						data-act="copy"
						aria-label="复制这条"
						title="复制"
						dangerouslySetInnerHTML={{ __html: COPY_ICON }}
						onClick={(event) => {
							event.stopPropagation();
							const node = event.currentTarget.closest(".row");
							if (node instanceof HTMLElement) props.onCopy(node);
						}}
					/>
					<button
						type="button"
						className="tool"
						data-act="reply"
						aria-label="引用这条"
						title="引用"
						dangerouslySetInnerHTML={{ __html: REPLY_ICON }}
						onClick={() => setReply({ seq: message.seq, label: name, excerpt: message.text.slice(0, 60) })}
					/>
				</div>
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
	const fallback = people.slice(0, 4).map((actor) => ({ slug: actor.slug, label: actor.label }));
	const picks = (members.length > 0 ? members : fallback)
		.slice(0, 4)
		.map((member) => ({ slug: member.slug, label: member.label }));
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
								? avatarSvg({ slug: picks[0]?.slug ?? "all", name: other ?? "全员", size: 64, state: "idle" })
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
										__html: avatarSvg({ slug: pick.slug, name: pick.label, size: 20, state: "idle" }),
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
