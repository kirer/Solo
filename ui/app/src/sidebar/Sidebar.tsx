/**
 * 左栏：品牌头 + 一列会话。
 *
 * 只有一个列表，没有分组 —— 我要的是「一眼扫到哪个会话动了」，
 * 分组标题占的是垂直空间，换来的信息量是零（他自己分的组，他记得）。
 * 一行要么是一个人（私聊），要么是一群人（群聊）—— 形态由后端 `kind` 给。
 */

import { avatarSvg, groupAvatar } from "../lib/avatar.ts";
import { headParts, relTime, unreadLabel } from "../lib/format.ts";
import { openChannel, setRight, setSide } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";
import type { Channel } from "../api/types.ts";

export function Sidebar(): JSX.Element {
	const channels = useStore((state) => state.channels);
	const company = useStore((state) => state.company);
	const people = useStore((state) => state.people);
	const currentId = useStore((state) => state.currentId);
	const side = useStore((state) => state.side);
	const presence = useStore((state) => state.presence);
	const memberCount = useStore((state) => state.people.length);

	const bySlug = new Map(people.map((person) => [person.slug, person]));

	return (
		<aside className="sidebar" data-side={side}>
			<div className="side-logo">
				<span className="brand-mark" aria-hidden="true">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
						<path d="M12 3v18M4.5 7.5 12 12l7.5-4.5M4.5 16.5 12 12l7.5 4.5" />
					</svg>
				</span>
				<h1 className="brand-name" id="bar-title">
					{company}
				</h1>
				<span className="side-grow" />
				<button
					type="button"
					className="icon-btn side-toggle"
					id="side-toggle"
					aria-label={side === "rail" ? "展开侧栏" : "收起侧栏"}
					title={side === "rail" ? "展开侧栏" : "收起侧栏"}
					onClick={() => setSide(side === "rail" ? "open" : "rail")}
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
						<rect x="3" y="4" width="18" height="16" rx="3" />
						<path d="M9 4v16" />
					</svg>
				</button>
			</div>
			<div className="side-head">
				<span>工作区</span>
				<span className="side-meta" id="company-meta">
					{memberCount} 人 · {channels.length} 个会话
				</span>
			</div>
			<div className="channels" id="rows" role="list">
				{channels.map((channel) => (
					<ChannelRow
						key={channel.id}
						channel={channel}
						active={channel.id === currentId}
						presence={presence}
						bySlug={bySlug}
						onOpen={() => {
							void openChannel(channel.id);
							setRight({ tab: "detail" });
						}}
					/>
				))}
			</div>
		</aside>
	);
}

function ChannelRow(props: {
	channel: Channel;
	active: boolean;
	presence: Map<string, { state: string; at: number }>;
	bySlug: Map<string, { label: string; title: string; slug: string }>;
	onOpen: () => void;
}): JSX.Element {
	const { channel } = props;
	const person = channel.kind === "dm" ? peerOf(channel, props.bySlug) : undefined;
	const state = person === undefined ? "idle" : (props.presence.get(person.slug)?.state ?? "idle");
	const title = channel.title;
	const parts = headParts(channel);
	const unread = channel.unread;
	const badge = unreadLabel(unread);

	return (
		<button
			type="button"
			role="listitem"
			className="ch"
			data-channel={channel.id}
			data-kind={channel.kind}
			aria-current={props.active ? "true" : "false"}
			title={parts.join(" · ")}
			onClick={props.onOpen}
		>
			<span
				className="ch-av"
				dangerouslySetInnerHTML={{
					__html:
						person === undefined
							? groupAvatar({
									people: groupPeopleOf(channel, props.bySlug),
									size: 32,
									state: "idle",
								})
							: avatarSvg({ slug: person.slug, name: person.label, size: 32, state: avatarState(state) }),
				}}
			/>
			<span className="ch-main">
				<span className="ch-top">
					<span className="ch-title">{title}</span>
					{person === undefined ? null : (
						<span className="ch-state" data-state={state}>
							{stateLabel(state)}
						</span>
					)}
					{unread > 0 ? (
						<span className="ch-badge" aria-label={`${String(unread)} 条未读`}>
							{badge}
						</span>
					) : null}
				</span>
				<span className="ch-sub">
					<span className="ch-time">{channel.lastAt === 0 ? "" : relTime(channel.lastAt)}</span>
					<span className="ch-preview">{channel.preview}</span>
				</span>
			</span>
		</button>
	);
}

/**
 * 私聊里对面是谁：后端已经把私聊标题写成对方的名字（`chatKind` 推的），
 * 所以按标题在名册里找人 —— 不去拆 id 前缀，也不往后端要新字段。
 */
function peerOf(
	channel: Channel,
	bySlug: Map<string, { label: string; title: string; slug: string }>,
): { label: string; title: string; slug: string } | undefined {
	for (const person of bySlug.values()) {
		if (person.label === channel.title) return person;
	}
	return undefined;
}

function groupPeopleOf(
	channel: Channel,
	bySlug: Map<string, { label: string; title: string; slug: string }>,
): { slug: string; label: string }[] {
	// 只有群聊才画群头像（私聊画那个人的脸）。群头像只画得出 4 个座位，多的也没地方放。
	return channel.kind === "dm"
		? []
		: [...bySlug.values()].slice(0, 4).map((person) => ({ slug: person.slug, label: person.label }));
}

function avatarState(state: string): "idle" | "thinking" | "working" | "done" {
	if (state === "working" || state === "thinking") return state;
	if (state === "asleep") return "idle";
	return "idle";
}

function stateLabel(state: string): string {
	if (state === "working") return "在做";
	if (state === "thinking") return "在想";
	if (state === "asleep") return "睡了";
	return "待命";
}
