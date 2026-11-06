/**
 * 左栏：一列会话（头上一行「聊天」，不画品牌标 —— 品牌在窗口标题和图标上）。
 *
 * 只有一个列表，没有分组 —— 我要的是「一眼扫到哪个会话动了」，
 * 分组标题占的是垂直空间，换来的信息量是零（他自己分的组，他记得）。
 * 一行要么是一个人（私聊），要么是一群人（群聊）—— 形态由后端 `kind` 给。
 */

import { useState } from "react";
import { avatarSvg, groupAvatar } from "../lib/avatar.ts";
import { headParts, relTime, unreadLabel } from "../lib/format.ts";
import { Slot } from "../plugin/Slot.tsx";
import { openChannel, openWithPerson, setNewGroup } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";
import type { Channel } from "../api/types.ts";

export function Sidebar(): JSX.Element {
	const channels = useStore((state) => state.channels);
	const people = useStore((state) => state.people);
	const currentId = useStore((state) => state.currentId);
	const presence = useStore((state) => state.presence);
	/** 列表头顶的搜索（稿子 02）：只在名字与预览里找，不搜历史正文。 */
	const [query, setQuery] = useState("");
	const needle = query.trim().toLowerCase();

	const bySlug = new Map(
		people.map((person) => [
			person.slug,
			{
				label: person.label,
				title: person.title,
				slug: person.slug,
				assistant: person.assistant === true,
			},
		]),
	);
	// 助理（身份在应用根下的那个人）。**他不在列表里**：和助理的对话就是首屏，
	// 从列表抬头的返回箭头回去，不在这一列里和自己重复一格。
	const nearest = people.find((person) => person.assistant === true);
	const isAssistantDm = (channel: Channel): boolean =>
		nearest !== undefined && channel.kind === "dm" && channel.members.includes(nearest.slug);
	const matches = (text: string): boolean => needle === "" || text.toLowerCase().includes(needle);
	const shown = channels.filter(
		(channel) => !isAssistantDm(channel) && (matches(channel.title) || matches(channel.preview)),
	);

	return (
		<aside className="sidebar">
			<header className="side-logo">
				{/* 首屏是助理那屏（稿子 01），从这里能回去；没有助理就不画箭头，它本来就在最上面。 */}
				{nearest === undefined ? null : (
					<button
						type="button"
						className="icon-btn side-back"
						id="list-back"
						aria-label="回到助理"
						title="回到助理"
						onClick={() => void openWithPerson(nearest.slug)}
					>
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
							<path d="M14.5 5.5 8 12l6.5 6.5" />
						</svg>
					</button>
				)}
				<h1 className="side-title" id="bar-title">
					对话
				</h1>
				<span className="side-grow" />
				{/* 插槽：品牌行右侧，拉群按钮之前。 */}
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
			</header>
			{/* 搜对话（稿子 02）：按名字与预览筛这一列，不搜历史。 */}
			<div className="side-search">
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
					<circle cx="10.8" cy="10.8" r="6.3" />
					<path d="m15.6 15.6 4 4" />
				</svg>
				<input
					id="chat-search"
					type="search"
					autoComplete="off"
					placeholder="搜索对话"
					aria-label="搜索对话"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
			</div>
			{/* 插槽：会话列表上方。 */}
			<Slot name="sidebar.list.before" />
			<div className="channels" id="rows" role="list">
				{shown.length === 0 ? <p className="side-empty">没有匹配的对话</p> : null}
				{shown.map((channel) => (
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

function ChannelRow(props: {
	channel: Channel;
	active: boolean;
	presence: Map<string, { state: string; at: number }>;
	bySlug: Map<string, { label: string; title: string; slug: string; assistant: boolean }>;
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
							: avatarSvg({
									slug: person.slug,
									name: person.label,
									size: 36,
									state: avatarState(state),
									assistant: person.assistant === true,
								}),
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
	bySlug: Map<string, { label: string; title: string; slug: string; assistant: boolean }>,
): { label: string; title: string; slug: string; assistant: boolean } | undefined {
	for (const person of bySlug.values()) {
		if (person.label === channel.title) return person;
	}
	return undefined;
}

function groupPeopleOf(
	channel: Channel,
	bySlug: Map<string, { label: string; title: string; slug: string; assistant: boolean }>,
): { slug: string; label: string; assistant: boolean }[] {
	// 只有群聊才画群头像（私聊画那个人的脸）。画的是**这个群里真有的人**，按成员表取；
	// 拿全名册前四个凑会让每个群的头像长成一样，跟群里到底有谁无关（实测的 bug）。
	// 群头像只画得出 4 个座位，多的也没地方放。
	return channel.members
		.map((slug) => bySlug.get(slug))
		.filter(
			(person): person is { label: string; title: string; slug: string; assistant: boolean } =>
				person !== undefined,
		)
		.slice(0, 4)
		.map((person) => ({ slug: person.slug, label: person.label, assistant: person.assistant }));
}

function avatarState(state: string): "idle" | "thinking" | "working" | "done" {
	if (state === "working" || state === "thinking") return state;
	if (state === "asleep") return "idle";
	return "idle";
}
