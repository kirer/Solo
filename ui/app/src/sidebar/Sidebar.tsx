/**
 * 左栏：品牌头 + 一列会话。
 *
 * 只有一个列表，没有分组 —— 我要的是「一眼扫到哪个会话动了」，
 * 分组标题占的是垂直空间，换来的信息量是零（他自己分的组，他记得）。
 * 一行要么是一个人（私聊），要么是一群人（群聊）—— 形态由后端 `kind` 给。
 */

import { avatarSvg, groupAvatar } from "../lib/avatar.ts";
import { headParts, relTime, unreadLabel } from "../lib/format.ts";
import { Slot } from "../plugin/Slot.tsx";
import { openChannel, openWithPerson, setPluginSheet, setSettings, setSide, setTeam } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";
import type { Actor, Channel } from "../api/types.ts";

export function Sidebar(): JSX.Element {
	const channels = useStore((state) => state.channels);
	const workspaceName = useStore((state) => state.workspaceName);
	const people = useStore((state) => state.people);
	const currentId = useStore((state) => state.currentId);
	const side = useStore((state) => state.side);
	const presence = useStore((state) => state.presence);

	const bySlug = new Map(people.map((person) => [person.slug, person]));
	// 「离我最近的人」= `identity.md` 里 `manager: owner` 的那一个。私聊还没开过时，
	// 他是侧栏第一格；开过之后那一格由真实频道顶上（`sortChannels` 已经把他钉在最前）。
	const nearest = people.find((person) => person.manager === "owner");
	const nearestOpened =
		nearest === undefined ||
		channels.some((channel) => channel.kind === "dm" && channel.title === nearest.label);

	return (
		<aside className="sidebar" data-side={side}>
			<div className="side-logo">
				{/* 品牌标：一颗自己的星，和绕着它转的轨道（和 `desktop/icon.svg` 同一套形状）。 */}
				<span className="brand-mark" aria-hidden="true">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
						<g transform="rotate(-28 12 12)">
							<ellipse cx="12" cy="12" rx="8.8" ry="3.5" stroke="currentColor" strokeWidth="1.8" opacity="0.65" />
						</g>
						<circle cx="12" cy="12" r="3.3" fill="currentColor" />
					</svg>
				</span>
				<h1 className="brand-name" id="bar-title">
					{workspaceName}
				</h1>
				<span className="side-grow" />
				{/* 插槽：品牌行右侧，收放按钮之前。 */}
				<Slot name="sidebar.header" />
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
			{/* 插槽：会话列表上方。 */}
			<Slot name="sidebar.list.before" />
			<div className="channels" id="rows" role="list">
				{nearest === undefined || nearestOpened ? null : (
					<AssistantRow
						person={nearest}
						state={presence.get(nearest.slug)?.state ?? "idle"}
						onOpen={() => void openWithPerson(nearest.slug)}
					/>
				)}
				{channels.map((channel) => (
					<ChannelRow
						key={channel.id}
						channel={channel}
						active={channel.id === currentId}
						presence={presence}
						bySlug={bySlug}
						onOpen={() => void openChannel(channel.id)}
					/>
				))}
			</div>
			{/* 团队与设置放在列表脚下：那是「管理」，不是随手要做的事。 */}
			<div className="side-foot">
				{/* 插件的地盘：没有插件时它不占一行。 */}
				<div className="side-slot">
					<Slot name="sidebar.footer" />
				</div>
				<button
					type="button"
					className="side-action"
					id="team-btn"
					aria-label="团队管理"
					title="团队管理"
					onClick={() => setTeam(true)}
				>
					<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
						<circle cx="9" cy="8" r="3.2" />
						<path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
						<path d="M16 5.5a3.2 3.2 0 0 1 0 6" />
						<path d="M17.5 13.6A5 5 0 0 1 21 18.5" />
					</svg>
					团队管理
				</button>
				<button
					type="button"
					className="side-action"
					id="plugins-btn"
					aria-label="插件"
					title="插件"
					onClick={() => setPluginSheet(true)}
				>
					<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
						<path d="M9 3h6v3.2a2 2 0 0 0 2 2h3.2v5.6H17a2 2 0 0 0-2 2V21H9v-3.2a2 2 0 0 0-2-2H3.8V9.2H7a2 2 0 0 0 2-2z" />
					</svg>
					插件
				</button>
				<button
					type="button"
					className="side-action"
					id="settings-btn"
					aria-label="偏好设置"
					title="偏好设置"
					onClick={() => setSettings(true)}
				>
					<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
						<circle cx="12" cy="12" r="3" />
						<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-2.9-1.2l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.11a1.7 1.7 0 0 0 1.2-2.9l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 3.09V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 2.9 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.49.96z" />
					</svg>
					偏好设置
				</button>
			</div>
		</aside>
	);
}

/**
 * 助理那一格：私聊还没开过时的入口。
 *
 * 它**不是一条会话**（没有频道 id、没有消息），所以第二行写的是他的身份而不是预览 ——
 * 不能编一句「还没有消息」假装那里有历史。点下去才真的建频道（`openWithPerson`）。
 */
function AssistantRow(props: { person: Actor; state: string; onOpen: () => void }): JSX.Element {
	const { person, state } = props;
	return (
		<button
			type="button"
			role="listitem"
			className="ch"
			data-entry="assistant"
			data-kind="dm"
			aria-current="false"
			title={person.title}
			onClick={props.onOpen}
		>
			<span
				className="ch-av"
				dangerouslySetInnerHTML={{
					__html: avatarSvg({ slug: person.slug, name: person.label, size: 36, state: avatarState(state) }),
				}}
			/>
			<span className="ch-main">
				<span className="ch-top">
					<span className="ch-title">{person.label}</span>
				</span>
				<span className="ch-sub">{person.title}</span>
			</span>
		</button>
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
									size: 36,
									state: "idle",
								})
							: avatarSvg({ slug: person.slug, name: person.label, size: 36, state: avatarState(state) }),
				}}
			/>
			<span className="ch-main">
				<span className="ch-top">
					<span className="ch-title">{title}</span>
					{channel.team === undefined ? null : <span className="ch-tag">团队</span>}
					{person === undefined || person.title === "" ? null : (
						<span className="ch-role">{person.title}</span>
					)}
					{unread > 0 ? (
						<span className="ch-badge" aria-label={`${String(unread)} 条未读`}>
							{badge}
						</span>
					) : null}
					<span className="ch-time">{channel.lastAt === 0 ? "" : relTime(channel.lastAt)}</span>
				</span>
				<span className="ch-sub">{channel.preview}</span>
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
