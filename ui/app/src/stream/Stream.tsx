/**
 * 消息流。
 *
 * 这个文件只做三件事：把 `buildRows()` 算出来的行画出来、维护「贴底」与
 * 「上翻加载」、把过程组展开/收起记在本组件内（**不进 store**：展开状态是
 * 视图私事，塞进全局会让每次 SSE 都触发整棵重渲染）。
 *
 * 上一版的三个毛病在这里从结构上消失：
 * 1. 整列 `replaceChildren` → React 按 key 复用，只补增量；
 * 2. 过程行顺序靠「事后搬 DOM」→ 顺序在 `buildRows` 里就定了；
 * 3. 上翻时位置乱跳 → 插旧消息前后各量一次锚点行，按差值补 `scrollTop`。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Attachment, Message } from "../api/types.ts";
import { avatarSvg } from "../lib/avatar.ts";
import { clockTime, copyText } from "../lib/format.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { buildRows } from "./model.ts";
import type { EventGroupRow, Row } from "./model.ts";
import { DONE_HINT, eventDetail, eventPhrase } from "../rows.ts";
import { loadEarlier, openChannel, setReply } from "../state/store.ts";
import type { Presence } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";

const COPY_ICON =
	'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a2 2 0 0 0-2 2v9"/></svg>';
const DONE_ICON =
	'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';
const REPLY_ICON =
	'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7 4 12l5 5"/><path d="M4 12h9a7 7 0 0 1 7 7v1"/></svg>';
const CHEVRON =
	'<svg class="ev-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

const EVENT_ICONS: Record<string, string> = {
	think: '<path d="M12 3a7 7 0 0 1 4 12.7V19H8v-3.3A7 7 0 0 1 12 3z"/><path d="M9.5 21h5"/>',
	command: '<path d="M5 7l4 5-4 5"/><path d="M12 17h7"/>',
	read: '<path d="M4 5h7l2 2h7v12H4z"/>',
	write: '<path d="M5 19l1-4 9-9 3 3-9 9z"/>',
	talk: '<path d="M4 6h16v10H9l-5 4z"/>',
	other: '<circle cx="12" cy="12" r="7"/><path d="M12 9v3l2 2"/>',
};

export function Stream(props: { onImage: (src: string) => void }): JSX.Element {
	const currentId = useStore((state) => state.currentId);
	const detail = useStore((state) => state.detail);
	const hasMore = useStore((state) => state.hasMore);
	const loadingEarlier = useStore((state) => state.loadingEarlier);
	const presence = useStore((state) => state.presence);
	const drafts = useStore((state) => state.drafts);
	const people = useStore((state) => state.people);
	const [atBottom, setAtBottom] = useState(true);
	/** 展开过的过程组（key）。默认展开的那些由 `defaultOpen` 决定，不进这个表。 */
	const [opened, setOpened] = useState<Record<string, boolean>>({});

	const flowRef = useRef<HTMLDivElement | null>(null);
	const feedRef = useRef<HTMLDivElement | null>(null);
	const anchor = useRef<{ seq: number; top: number } | null>(null);
	const pinned = useRef(true);

	const messages = detail?.messages ?? [];
	const channelKind = detail?.channel.kind ?? "dm";
	const runningSlug = useMemo(() => {
		for (const [slug, entry] of presence) {
			if (entry.state === "thinking" || entry.state === "working") return slug;
		}
		return undefined;
	}, [presence]);

	const { rows, activity } = useMemo(
		() => buildRows({ messages, channelKind, runningSlug, now: Date.now() }),
		[messages, channelKind, runningSlug],
	);

	const labels = useMemo(() => {
		const map = new Map<string, { label: string; role: string }>();
		for (const actor of people) map.set(actor.slug, { label: actor.label, role: actor.title });
		if (detail !== null) {
			for (const member of detail.members) {
				if (!map.has(member.slug)) map.set(member.slug, { label: member.label, role: member.role });
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

	// 切频道：到底部，并把展开状态清掉（上一段的展开跟这一段无关）。
	useEffect(() => {
		setOpened({});
		anchor.current = null;
		pinned.current = true;
		requestAnimationFrame(() => toBottom());
	}, [currentId, toBottom]);

	const onTop = useCallback(() => {
		if (!hasMore || loadingEarlier) return;
		rememberAnchor();
		void loadEarlier();
	}, [hasMore, loadingEarlier, rememberAnchor]);

	const copy = useCallback((node: HTMLElement) => {
		const body = node.querySelector(".md")?.textContent ?? "";
		void copyText(body).then((ok) => {
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
		<>
			<div className="flow" id="flow" ref={flowRef}>
				<div className="flow-inner" id="flow-inner">
					<div className="flow-top" id="flow-top" data-active={hasMore ? "true" : "false"} ref={undefined}>
						{hasMore ? (
							<button type="button" className="load-earlier" onClick={onTop} disabled={loadingEarlier}>
								{loadingEarlier ? "正在读更早的…" : "加载更早的消息"}
							</button>
						) : null}
					</div>

					{detail === null ? <Skeleton /> : null}

					<div className="feed" id="feed" ref={feedRef}>
						{detail !== null && rows.length === 0 ? <Empty channelId={detail.channel.id} /> : null}
						{rows.map((row) => (
							<RowView
								key={row.key}
								row={row}
								labels={labels}
								opened={opened}
								onToggle={(key, next) => setOpened((current) => ({ ...current, [key]: next }))}
								onCopy={copy}
								onImage={props.onImage}
							/>
						))}
						{detail === null
							? null
							: [...drafts].map(([slug, draft]) => (
									<DraftRow key={`draft-${slug}`} slug={slug} text={draft.text} labels={labels} />
								))}
					</div>

					{activity === null ? null : (
						<div className="act" data-slug={activity.slug}>
							<span
								className="act-av"
								dangerouslySetInnerHTML={{
									__html: avatarSvg({ slug: activity.slug, name: activity.label, size: 22, state: "working" }),
								}}
							/>
							<span className="act-text">{activity.phrase}</span>
							<span className="act-time">
								<Living startAt={activity.startAt} />
							</span>
							<span className="act-live" aria-hidden="true">
								<i />
								<i />
								<i />
							</span>
						</div>
					)}
				</div>
			</div>
			<button
				type="button"
				className="to-bottom"
				id="to-bottom"
				hidden={atBottom}
				onClick={() => toBottom("smooth")}
			>
				回到最新
			</button>
		</>
	);
}

function RowView(props: {
	row: Row;
	labels: Map<string, { label: string; role: string }>;
	opened: Record<string, boolean>;
	onToggle: (key: string, next: boolean) => void;
	onCopy: (node: HTMLElement) => void;
	onImage: (src: string) => void;
}): JSX.Element {
	const { row } = props;
	if (row.type === "divider") {
		return (
			<div className="row-divider">
				<span>{row.label}</span>
			</div>
		);
	}
	if (row.type === "say") return <SayRow row={row} labels={props.labels} onCopy={props.onCopy} onImage={props.onImage} />;
	if (row.type === "note") {
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
	if (row.type === "processing") {
		return (
			<div className="row row-event row-processing" data-seq={row.message.seq}>
				<span className="ev-dot" aria-hidden="true" />
				<span className="ev">
					<b>{row.message.fromLabel}</b>
					<span className="ev-what">正在处理</span>
				</span>
				<span className="ev-time">
					<Living startAt={row.startAt} />
				</span>
			</div>
		);
	}
	return (
		<EventsRow
			row={row}
			open={props.opened[row.key] ?? row.defaultOpen}
			onToggle={(next) => props.onToggle(row.key, next)}
		/>
	);
}

/**
 * 「正在说…」：模型正在生成、还没落库的那句话。
 *
 * 为什么值得画：一条 200 字的话要生成十几秒，这期间界面上只有「想了 3 秒」。
 * 让老板看见它正在往外蹦字，是「它还活着」最直接的证据。
 *
 * 三条纪律：①不进 `buildRows`（它不是消息，不该参与分组/分隔的判定）；
 * ②样式上明确是「草稿」——浅一档的字色 + 光标，不让人误以为已经说完了；
 * ③真消息一到就消失（`applyMessage` 里删），否则同一句话会出现两遍。
 */
function DraftRow(props: {
	slug: string;
	text: string;
	labels: Map<string, { label: string; role: string }>;
}): JSX.Element {
	const known = props.labels.get(props.slug);
	const name = known?.label ?? props.slug;
	return (
		<div className="row row-say row-draft" data-slug={props.slug}>
			<div
				className="row-av"
				dangerouslySetInnerHTML={{
					__html: avatarSvg({ slug: props.slug, name, size: 40, state: "working" }),
				}}
			/>
			<div className="row-body">
				<div className="row-head">
					<span className="row-name">{name}</span>
					<span className="row-role">正在说</span>
				</div>
				<div className="md draft-text">
					{props.text}
					<span className="draft-caret" aria-hidden="true" />
				</div>
			</div>
		</div>
	);
}

function SayRow(props: {
	row: Extract<Row, { type: "say" }>;
	labels: Map<string, { label: string; role: string }>;
	onCopy: (node: HTMLElement) => void;
	onImage: (src: string) => void;
}): JSX.Element {
	const { row } = props;
	const message = row.message;
	const owner = message.fromSlug === "owner";
	const known = props.labels.get(message.fromSlug);
	const name = known?.label ?? message.fromLabel;
	// 老大不在名册里，`member.role` 会漏出 slug（`owner`），所以硬性不给。
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

				{message.replyTo === undefined ? null : (
					<div className="row-quote">
						<span className="row-quote-who">{message.replyTo.fromLabel}</span>
						<span className="row-quote-text">{message.replyTo.excerpt}</span>
					</div>
				)}

				<Attachments attachments={message.attachments} onImage={props.onImage} />

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
							onClick={() => props.onImage(`/api/uploads/${item.id}`)}
						>
							<img src={`/api/uploads/${item.id}`} alt={item.name} loading="lazy" />
						</button>
					))}
				</div>
			)}
			{files.length === 0 ? null : (
				<div className="attach-files">
					{files.map((item) => (
						<a key={item.id} className="attach-file" href={`/api/uploads/${item.id}?download=1`} download={item.name}>
							<span className="attach-ico" aria-hidden="true">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
									<path d="M5 4h9l5 5v11H5z" />
									<path d="M14 4v5h5" />
								</svg>
							</span>
							<span className="attach-name">{item.name}</span>
							<span className="attach-size">{Math.max(1, Math.round(item.bytes / 1024))} KB</span>
						</a>
					))}
				</div>
			)}
		</>
	);
}

function EventsRow(props: { row: EventGroupRow; open: boolean; onToggle: (next: boolean) => void }): JSX.Element {
	const { row } = props;
	return (
		<div
			className="row row-events"
			data-slug={row.slug}
			data-state={row.running ? "running" : "done"}
			data-open={props.open ? "true" : "false"}
		>
			<div
				className="row-av"
				dangerouslySetInnerHTML={{
					__html: avatarSvg({ slug: row.slug, name: row.label, size: 40, state: row.running ? "working" : "idle" }),
				}}
			/>
			<div className="row-body">
			<button
				type="button"
				className="evs"
				aria-expanded={props.open}
				aria-label={row.describe}
				title={row.describe}
				onClick={() => props.onToggle(!props.open)}
			>
				{row.running ? (
					<>
						<b>{row.label}</b>
						<span className="evs-what">{row.mix}</span>
						<span className="evs-time">
							<Living startAt={row.startAt} />
						</span>
					</>
				) : (
					<>
						<span className="evs-what">{DONE_HINT}</span>
					</>
				)}
				<span dangerouslySetInnerHTML={{ __html: CHEVRON }} style={{ display: "contents" }} />
			</button>
			<div className="evs-body" hidden={!props.open}>
				<div className="evs-list">
					{row.entries.map((entry) => (
						<EventLine key={entry.seq} message={entry} />
					))}
				</div>
			</div>
			</div>
		</div>
	);
}

function EventLine(props: { message: Message }): JSX.Element {
	const [open, setOpen] = useState(false);
	const detail = eventDetail(props.message);
	const kind = iconKindOf(props.message);
	const icon = EVENT_ICONS[kind] ?? EVENT_ICONS["other"] ?? "";
	return (
		<div className="row-event" data-seq={props.message.seq} data-open={open ? "true" : "false"}>
			{detail === "" ? (
				<span className="ev">
					<span className="ev-ico" aria-hidden="true" dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>` }} />
					<span className="ev-what">{eventPhrase(props.message)}</span>
				</span>
			) : (
				<button type="button" className="ev" aria-expanded={open} onClick={() => setOpen(!open)}>
					<span className="ev-ico" aria-hidden="true" dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>` }} />
					<span className="ev-what">{eventPhrase(props.message)}</span>
					<span className="ev-chevron" aria-hidden="true" dangerouslySetInnerHTML={{ __html: CHEVRON }} />
				</button>
			)}
			{detail === "" ? null : (
				<div className="ev-body" hidden={!open}>
					<pre>{detail}</pre>
				</div>
			)}
		</div>
	);
}

function iconKindOf(message: Message): string {
	// 工具名只在正文里（`run command=…` / `read_file path=…`），视图层没单独字段。
	const name = /^([a-z_]+)[\s(]/.exec(message.text)?.[1] ?? "";
	if (message.kind === "think") return "think";
	if (name === "run" || name === "bash") return "command";
	if (name === "read_file" || name === "read_channel" || name === "read_history") return "read";
	if (name === "write_file" || name === "edit_file") return "write";
	if (name === "say") return "talk";
	return "other";
}

/** 计时器：每 5 秒读一次真实时钟，不靠「帧」累加（切到后台会漏帧）。 */
function Living(props: { startAt: number }): JSX.Element {
	const [seconds, setSeconds] = useState(() => Math.max(0, Math.round((Date.now() - props.startAt) / 1000)));
	useEffect(() => {
		setSeconds(Math.max(0, Math.round((Date.now() - props.startAt) / 1000)));
		const timer = window.setInterval(() => {
			setSeconds((current) => Math.max(current, Math.round((Date.now() - props.startAt) / 1000)));
		}, 5000);
		return () => window.clearInterval(timer);
	}, [props.startAt]);
	return <>{seconds}s</>;
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

function Empty(_props: { channelId: string }): JSX.Element {
	const people = useStore((state) => state.people);
	const detail = useStore((state) => state.detail);
	const candidates = (detail?.members ?? []).filter((member) => member.slug !== "owner").slice(0, 4);
	const fallback = people.slice(0, 4).map((actor) => ({ slug: actor.slug, label: actor.label }));
	const picks = candidates.length > 0 ? candidates.map((member) => ({ slug: member.slug, label: member.label })) : fallback;
	return (
		<div className="ch-empty">
			<p className="ch-empty-title">这个频道还没有消息。</p>
			{picks.length === 0 ? null : <p className="ch-empty-hint">从谁开始</p>}
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
								__html: avatarSvg({ slug: pick.slug, name: pick.label, size: 22, state: "idle" }),
							}}
						/>
						{pick.label}
					</button>
				))}
			</div>
		</div>
	);
}

export { openChannel };
export type { Presence };
