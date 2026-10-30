/**
 * 右栏：只有「详情」一页（文件页已删，ADR-091）。
 *
 * 它是布局的第三列，不是浮层：我要一边看对话一边看详情，浮层会把对话盖住。
 * 靠 `--rightbar` 从 0 变 360 让整列滑出来（见 `styles/shell.css`），
 * 所以「关」的时候必须等过渡跑完再 `hidden`，否则没有动画。
 */

import { useEffect, useState } from "react";
import { avatarSvg, groupAvatar } from "../lib/avatar.ts";
import type { PersonProfile } from "../api/types.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { backRight, openMemory, openPerson, setRight } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";

export function RightPanel(): JSX.Element {
	const open = useStore((state) => state.right.open);
	const [mounted, setMounted] = useState(open);

	useEffect(() => {
		if (open) {
			setMounted(true);
			return;
		}
		// 关：等 300ms 过渡（CSS 里那条）跑完再真正卸载，否则直接「啪」地消失。
		const timer = window.setTimeout(() => setMounted(false), 300);
		return () => window.clearTimeout(timer);
	}, [open]);

	if (!open && !mounted) return <aside className="detail" hidden />;

	return (
		<aside
			className="detail"
			id="detail"
			data-open={open ? "true" : "false"}
			aria-label="右侧栏"
			{...(open ? {} : { hidden: true })}
		>
			<div className="detail-bar">
				<span className="sheet-grow" />
				<button
					type="button"
					className="icon-btn"
					id="detail-close"
					aria-label="收起右侧栏"
					title="收起右侧栏"
					onClick={() => setRight({ open: false })}
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
						<path d="M6 6l12 12M18 6 6 18" />
					</svg>
				</button>
			</div>
			<div className="detail-panel" id="detail-panel">
				<BackButton />
				<div className="detail-body" id="detail-body">
					<DetailTab />
				</div>
			</div>
		</aside>
	);
}

function BackButton(): JSX.Element | null {
	const trail = useStore((state) => state.trail);
	if (trail.length < 2) return null;
	return (
		<button type="button" className="detail-back" id="detail-back" onClick={() => backRight()}>
			‹ 返回
		</button>
	);
}

/* ── 详情 ────────────────────────────────────────────────────────────── */

function DetailTab(): JSX.Element {
	const person = useStore((state) => state.person);
	const detail = useStore((state) => state.detail);
	const people = useStore((state) => state.people);
	if (person !== null) return <PersonView person={person} />;
	if (detail === null) return <p className="detail-empty">左边选一个会话。</p>;

	const channel = detail.channel;
	const members = detail.members.filter((member) => member.slug !== "owner");
	const recent = detail.messages
		.filter((message) => ["say", "chat", "question", "decision", "report"].includes(message.kind))
		.at(-1);

	return (
		<div className="detail-sec">
			<div className="detail-head">
				<div
					className="detail-av"
					dangerouslySetInnerHTML={{
						__html:
							channel.kind === "dm"
								? avatarSvg({
										slug: members[0]?.slug ?? "owner",
										name: members[0]?.label ?? "我",
										size: 44,
										state: "idle",
									})
								: groupAvatar({
										people: members.slice(0, 4).map((member) => ({ slug: member.slug, label: member.label })),
										size: 44,
									}),
					}}
				/>
				<div className="detail-ident">
					<span className="detail-name">{channel.title}</span>
					<span className="detail-tags">
						<span className="detail-tag">{kindLabel(channel.kind)}</span>
						{channel.team === undefined ? null : <span className="detail-tag">{channel.team}</span>}
					</span>
				</div>
			</div>

			{channel.doing === undefined || channel.doing === "" ? null : (
				<div className="detail-field">
					<span className="detail-k">现状</span>
					<span className="detail-v">{channel.doing}</span>
				</div>
			)}
			{channel.leadLabel === undefined ? null : (
				<div className="detail-field">
					<span className="detail-k">团队管理员</span>
					<span className="detail-v">{channel.leadLabel}</span>
				</div>
			)}
			<div className="detail-field">
				<span className="detail-k">消息</span>
				<span className="detail-v">{detail.messages.length} 条（本窗口）</span>
			</div>

			{recent === undefined ? null : (
				<div className="detail-field">
					<span className="detail-k">最近</span>
					<span className="detail-v detail-recent">
						{recent.fromLabel}：{recent.text.slice(0, 90)}
					</span>
				</div>
			)}

			<div className="detail-sec-head">
				成员 <span className="detail-count">{members.length + 1}</span>
			</div>
			<div className="detail-people">
				{people.length === 0 ? <p className="detail-empty">名册还没读出来。</p> : null}
				{detail.members.map((member) => {
					if (member.slug === "owner") {
						// 我没有档案页（`GET /api/people/owner` 是 404），所以不给点击态。
						return (
							<span key={member.slug} className="detail-person-btn is-static">
								<span className="detail-person-name">我</span>
							</span>
						);
					}
					return (
						<button
							type="button"
							key={member.slug}
							className="detail-person-btn"
							data-open-person={member.slug}
							onClick={() => void openPerson(member.slug)}
						>
							<span
								className="detail-av"
								dangerouslySetInnerHTML={{
									__html: avatarSvg({ slug: member.slug, name: member.label, size: 28, state: "idle" }),
								}}
							/>
							<span className="detail-person-name">{member.label}</span>
							<span className="detail-person-title">{member.role}</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

function PersonView(props: { person: PersonProfile }): JSX.Element {
	const { person } = props;
	// 后端给的是**条数**（`/api/people/:slug` 的 `memory.entries`），全文在抽屉里另取。
	const memoryCount = person.memory.entries;
	return (
		<div className="detail-sec">
			<div className="detail-head">
				<div
					className="detail-av"
					dangerouslySetInnerHTML={{
						__html: avatarSvg({ slug: person.slug, name: person.label, size: 44, state: "idle" }),
					}}
				/>
				<div className="detail-ident">
					<span className="detail-name">{person.label}</span>
					<span className="detail-tags">
						<span className="detail-tag">{person.title}</span>
						{person.team === undefined ? null : <span className="detail-tag">{person.team}</span>}
					</span>
				</div>
			</div>

			<div className="detail-field">
				<span className="detail-k">汇报给</span>
				<span className="detail-v">{person.managerLabel}</span>
			</div>

			{person.channels.length === 0 ? null : (
				<>
					<div className="detail-sec-head">在哪些频道</div>
					<div className="detail-chips">
						{person.channels.map((channel) => (
							<span key={channel.id} className="detail-chip">
								{channel.title}
							</span>
						))}
					</div>
				</>
			)}

			{person.body.trim() === "" ? null : (
				<>
					<div className="detail-sec-head">预置提示词</div>
					{/* identity.md 的第一个 `# 名字` 标题和上面的标题重复，剥掉。 */}
					<div
						className="detail-doc"
						dangerouslySetInnerHTML={{ __html: renderMarkdown(stripTitle(person.body, person.label)) }}
					/>
				</>
			)}

			<div className="detail-sec-head">技能</div>
			{person.skills.length === 0 ? (
				<p className="detail-empty">还没有技能。</p>
			) : (
				<div className="detail-skills">
					{person.skills.map((skill) => (
						<div key={skill.name} className="detail-skill">
							<span className="detail-skill-name">{skill.name}</span>
							<span className="detail-badge">{skill.scope === "personal" ? "自己的" : "公司"}</span>
							<span className="detail-skill-desc">{skill.description}</span>
						</div>
					))}
				</div>
			)}

			<div className="detail-sec-head">记忆</div>
			<div className="detail-memory">
				<span className="detail-state">{memoryCount === 0 ? "还没有记忆" : `${String(memoryCount)} 段`}</span>
				<span className="detail-v">{person.memory.digest?.split("\n")[0] ?? ""}</span>
			</div>
			<button
				type="button"
				className="detail-memory-open"
				onClick={() => openMemory(person.slug, person.label)}
			>
				看 / 改记忆
			</button>
		</div>
	);
}

/* ── 小工具 ──────────────────────────────────────────────────────────── */

function kindLabel(kind: string): string {
	return kind === "dm" ? "私聊" : "群聊";
}

/** `identity.md` 的第一个 `# 名字` 与上面的标题重复，剥掉它和紧随的空行。 */
function stripTitle(body: string, name: string): string {
	const lines = body.split("\n");
	if (lines.length === 0) return body;
	const first = (lines[0] ?? "").replace(/^#+\s*/, "").trim();
	if (first !== name) return body;
	let at = 1;
	while (at < lines.length && (lines[at] ?? "").trim() === "") at += 1;
	return lines.slice(at).join("\n");
}
