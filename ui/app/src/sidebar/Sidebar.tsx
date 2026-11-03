/**
 * 左栏：一列会话（头上一行「聊天」，不画品牌标 —— 品牌在窗口标题和图标上）。
 *
 * 只有一个列表，没有分组 —— 我要的是「一眼扫到哪个会话动了」，
 * 分组标题占的是垂直空间，换来的信息量是零（他自己分的组，他记得）。
 * 一行要么是一个人（私聊），要么是一群人（群聊）—— 形态由后端 `kind` 给。
 */

import { avatarSvg, groupAvatar } from "../lib/avatar.ts";
import { headParts, relTime, unreadLabel } from "../lib/format.ts";
import { Slot } from "../plugin/Slot.tsx";
import { openChannel, openWithPerson, setNewGroup, setSide } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";
import type { Actor, Channel } from "../api/types.ts";

export function Sidebar(): JSX.Element {
	const channels = useStore((state) => state.channels);
	const people = useStore((state) => state.people);
	const currentId = useStore((state) => state.currentId);
	const side = useStore((state) => state.side);
	const presence = useStore((state) => state.presence);

	const bySlug = new Map(people.map((person) => [person.slug, person]));
	// 助理（身份在应用根下的那个人）。私聊还没开过时，他是侧栏第一格；
	// 开过之后那一格由真实频道顶上（`sortChannels` 已经把他钉在最前）。
	const nearest = people.find((person) => person.assistant === true);
	const nearestOpened =
		nearest === undefined ||
		channels.some((channel) => channel.kind === "dm" && channel.title === nearest.label);

	return (
		<aside className="sidebar" data-side={side}>
			<div className="side-logo">
				{/* 不画品牌标：这一列的头只说明「这里是聊天」，和左边那格图标连成一条线。 */}
				<h1 className="brand-name" id="bar-title">
					聊天
				</h1>
				<span className="side-grow" />
				{/* 插槽：品牌行右侧，收放按钮之前。 */}
				<Slot name="sidebar.header" />
				{/* 拉群就在会话列表头顶：它长出来的是一格会话，不是一项「管理」。 */}
				<button
					type="button"
					className="icon-btn side-new"
					id="new-group"
					aria-label="拉群"
					title="拉群"
					onClick={() => setNewGroup(true)}
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
						<path d="M12 5v14M5 12h14" />
					</svg>
				</button>
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
			{/* 列表脚下只剩插件的地盘（团队 / 插件 / 设置三格已经搬到最左那列，docs/DESIGN.md §1.1）。 */}
			<div className="side-foot">
				<div className="side-slot">
					<Slot name="sidebar.footer" />
				</div>
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
			// 行底色：有人点名找我 = 淡红；只是有新消息 = 淡灰；选中态优先（CSS 里写死）。
			data-need={unread > 0 && channel.mentions > 0 ? "true" : undefined}
			data-unread={unread > 0 ? "true" : undefined}
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
						// 红色 = 有消息点名找我；灰色 = 只是有新消息。颜色规则在 CSS（`.ch-badge`）。
						<span
							className="ch-badge"
							data-kind={channel.mentions > 0 ? "mention" : "unread"}
							aria-label={`${String(unread)} 条未读`}
						>
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
	// 只有群聊才画群头像（私聊画那个人的脸）。画的是**这个群里真有的人**，按成员表取；
	// 拿全名册前四个凑会让每个群的头像长成一样，跟群里到底有谁无关（实测的 bug）。
	// 群头像只画得出 4 个座位，多的也没地方放。
	return channel.members
		.map((slug) => bySlug.get(slug))
		.filter((person): person is { label: string; title: string; slug: string } => person !== undefined)
		.slice(0, 4)
		.map((person) => ({ slug: person.slug, label: person.label }));
}

function avatarState(state: string): "idle" | "thinking" | "working" | "done" {
	if (state === "working" || state === "thinking") return state;
	if (state === "asleep") return "idle";
	return "idle";
}
