/**
 * 右栏：三个视图，同一份数据换一种看法 —— 详情 / 技能 / 记忆（DESIGN §5）。
 *
 * 它是布局的第三列，不是浮层：我要一边看对话一边看这个人会什么、记得什么。
 * 靠 `--rightbar` 从 0 变 360 让整列滑出来（见 `styles/shell.css`），
 * 所以「关」的时候必须等过渡跑完再 `hidden`，否则没有动画。
 *
 * 技能与记忆都**以人为单位**：顶部那个 `知言 ▾` 只换这两栏，不换频道。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { getPerson, getPersonMemory, editPersonMemory } from "../api/client.ts";
import type { MemoryEntry, PersonMemory, PersonProfile } from "../api/types.ts";
import { avatarSvg, groupAvatar } from "../lib/avatar.ts";
import { clockTime, dayLabel } from "../lib/format.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { backRight, openPerson, setRight } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";

type Tab = "detail" | "skills" | "memory";

const TABS: readonly { value: Tab; text: string }[] = [
	{ value: "detail", text: "详情" },
	{ value: "skills", text: "技能" },
	{ value: "memory", text: "记忆" },
];

export function RightPanel(): JSX.Element {
	const open = useStore((state) => state.right.open);
	const [mounted, setMounted] = useState(open);
	const [tab, setTab] = useState<Tab>("detail");

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
				<div className="rail-tabs" role="tablist" aria-label="右侧栏视图">
					{TABS.map((item) => (
						<button
							type="button"
							key={item.value}
							role="tab"
							className="rail-tab"
							aria-selected={tab === item.value}
							onClick={() => setTab(item.value)}
						>
							{item.text}
						</button>
					))}
				</div>
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
					{tab === "detail" ? (
						<DetailTab />
					) : tab === "skills" ? (
						<SkillsTab />
					) : (
						<MemoryTab />
					)}
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
			<div className="detail-sec-head">
				成员 <span className="detail-count">{members.length + 1}</span>
			</div>
			<div className="detail-people">
				{people.length === 0 ? <p className="detail-empty">名册还没读出来。</p> : null}
				{members.map((member) => (
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
						{memberRole(member.role) === "" ? null : (
							<span className="detail-person-title">{memberRole(member.role)}</span>
						)}
					</button>
				))}
			</div>
		</div>
	);
}

function PersonView(props: { person: PersonProfile }): JSX.Element {
	const { person } = props;
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
			<SkillList skills={person.skills} />

			<div className="detail-sec-head">记忆</div>
			<div className="detail-memory">
				<span className="detail-state">
					{person.memory.entries === 0 ? "还没有记忆" : `${String(person.memory.entries)} 段`}
				</span>
				<span className="detail-v">{person.memory.digest?.split("\n")[0] ?? ""}</span>
			</div>
		</div>
	);
}

/* ── 技能 ────────────────────────────────────────────────────────────── */

/**
 * 技能与记忆的顶部：换人。
 *
 * 只列**当前频道的成员**（不含我）—— 名册里的人在不在这个频道是后端的事，
 * 这里不自己筛两遍。频道没人时退回名册。
 */
function useWho(): { who: string | null; options: { slug: string; label: string }[]; setWho: (slug: string) => void } {
	const detail = useStore((state) => state.detail);
	const people = useStore((state) => state.people);
	const person = useStore((state) => state.person);
	const [picked, setPicked] = useState<string | null>(null);

	const options = useMemo(() => {
		const fromChannel = (detail?.members ?? [])
			.filter((member) => member.slug !== "owner")
			.map((member) => ({ slug: member.slug, label: member.label }));
		if (fromChannel.length > 0) return fromChannel;
		return people.map((actor) => ({ slug: actor.slug, label: actor.label }));
	}, [detail, people]);

	const who = picked ?? person?.slug ?? options[0]?.slug ?? null;
	return { who, options, setWho: setPicked };
}

function WhoPicker(props: { who: string | null; options: { slug: string; label: string }[]; onPick: (slug: string) => void }): JSX.Element | null {
	if (props.options.length === 0) return null;
	return (
		<label className="rail-who">
			<span className="sr-only">看谁</span>
			<select value={props.who ?? ""} onChange={(event) => props.onPick(event.target.value)}>
				{props.options.map((option) => (
					<option key={option.slug} value={option.slug}>
						{option.label}
					</option>
				))}
			</select>
			<span className="rail-who-caret" aria-hidden="true">
				▾
			</span>
		</label>
	);
}

function SkillsTab(): JSX.Element {
	const { who, options, setWho } = useWho();
	const [profile, setProfile] = useState<PersonProfile | null>(null);
	const [error, setError] = useState("");
	const storePerson = useStore((state) => state.person);

	useEffect(() => {
		if (who === null) return;
		if (storePerson !== null && storePerson.slug === who) {
			setProfile(storePerson);
			return;
		}
		let alive = true;
		setError("");
		getPerson(who)
			.then((next) => {
				if (alive) setProfile(next);
			})
			.catch((reason: unknown) => {
				if (alive) setError(reason instanceof Error ? reason.message : "读不到这个人的技能");
			});
		return () => {
			alive = false;
		};
	}, [who, storePerson]);

	if (who === null) return <p className="detail-empty">左边选一个会话，再回来看技能。</p>;

	const skills = profile?.skills ?? [];
	const personal = skills.filter((skill) => skill.scope === "personal");
	const shared = skills.filter((skill) => skill.scope === "all");

	return (
		<div className="detail-sec rail-view">
			<div className="rail-head">
				<WhoPicker who={who} options={options} onPick={setWho} />
				<span className="rail-count">会 {skills.length} 件事</span>
			</div>
			{error === "" ? null : <p className="rail-error">{error}</p>}
			{profile === null ? (
				<p className="detail-empty">正在读…</p>
			) : skills.length === 0 ? (
				<>
					<p className="detail-empty">他还没有自己的技能。</p>
					<p className="rail-hint">技能就是 agents/&lt;slug&gt;/skills/ 下的 SKILL.md</p>
				</>
			) : (
				<>
					{personal.length === 0 ? null : (
						<>
							<div className="rail-group">个人</div>
							{personal.map((skill) => (
								<SkillRow key={skill.name} name={skill.name} scope="个人" description={skill.description} overrides={skill.overrides} />
							))}
						</>
					)}
					{shared.length === 0 ? null : (
						<>
							<div className="rail-group">全员都会</div>
							{shared.map((skill) => (
								<SkillRow key={skill.name} name={skill.name} scope="全员" description={skill.description} overrides={false} />
							))}
						</>
					)}
				</>
			)}
		</div>
	);
}

/** 一行技能：名字 + scope；点开看 description 全文（和 `run` 步骤同一种交互）。 */
function SkillRow(props: { name: string; scope: string; description: string; overrides: boolean }): JSX.Element {
	const [open, setOpen] = useState(false);
	return (
		<div className="rail-skill" data-open={open ? "true" : "false"}>
			<button type="button" className="rail-skill-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
				<span className="rail-skill-name">{props.name}</span>
				<span className="rail-scope">{props.scope}</span>
			</button>
			{props.description === "" ? null : <p className="rail-skill-desc">{props.description}</p>}
			{props.overrides ? <p className="rail-hint">覆盖全员同名</p> : null}
		</div>
	);
}

function SkillList(props: { skills: PersonProfile["skills"] }): JSX.Element {
	if (props.skills.length === 0) return <p className="detail-empty">还没有技能。</p>;
	return (
		<div className="detail-skills">
			{props.skills.map((skill) => (
				<div key={skill.name} className="detail-skill">
					<span className="detail-skill-name">{skill.name}</span>
					<span className="detail-badge">{skill.scope === "personal" ? "自己的" : "全员"}</span>
					<span className="detail-skill-desc">{skill.description}</span>
				</div>
			))}
		</div>
	);
}

/* ── 记忆 ────────────────────────────────────────────────────────────── */

function MemoryTab(): JSX.Element {
	const { who, options, setWho } = useWho();
	const [data, setData] = useState<PersonMemory | null>(null);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [menu, setMenu] = useState<string | null>(null);

	const refresh = useCallback(async (slug: string) => {
		try {
			setData(await getPersonMemory(slug));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "读不到记忆");
		}
	}, []);

	useEffect(() => {
		setData(null);
		setDraft("");
		setError("");
		setMenu(null);
		if (who !== null) void refresh(who);
	}, [who, refresh]);

	if (who === null) return <p className="detail-empty">左边选一个会话，再回来看记忆。</p>;

	const entries = data?.entries ?? [];

	const add = async (): Promise<void> => {
		const text = draft.trim();
		if (text === "" || busy) return;
		setBusy(true);
		setError("");
		try {
			await editPersonMemory(who, { op: "add", text });
			setDraft("");
			await refresh(who);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "没记上");
		} finally {
			setBusy(false);
		}
	};

	const forget = async (entry: MemoryEntry): Promise<void> => {
		setMenu(null);
		if (busy) return;
		setBusy(true);
		try {
			await editPersonMemory(who, { op: "forget", heading: entry.heading });
			await refresh(who);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "没删掉");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="detail-sec rail-view">
			<div className="rail-head">
				<WhoPicker who={who} options={options} onPick={setWho} />
				<span className="rail-count">{entries.length} 条记忆</span>
			</div>

			{error === "" ? null : <p className="rail-error">{error}</p>}
			{data === null ? (
				<p className="detail-empty">正在读…</p>
			) : entries.length === 0 ? (
				<p className="detail-empty">还没有记忆。</p>
			) : (
				entries.map((entry) => (
					<div className="rail-memo" key={entry.heading}>
						<div className="rail-memo-head">
							<span className="rail-memo-stamp">{stampOf(entry) ?? entry.heading}</span>
							<span className="rail-memo-grow" />
							<button
								type="button"
								className="rail-memo-more"
								aria-label="这一条的操作"
								aria-expanded={menu === entry.heading}
								onClick={() => setMenu((current) => (current === entry.heading ? null : entry.heading))}
							>
								⋯
							</button>
							{menu !== entry.heading ? null : (
								<span className="rail-memo-menu">
									<button type="button" className="rail-memo-del" disabled={busy} onClick={() => void forget(entry)}>
										删掉这一条
									</button>
									<button type="button" onClick={() => setMenu(null)}>
										取消
									</button>
								</span>
							)}
						</div>
						<p className="rail-memo-body">{entry.body}</p>
					</div>
				))
			)}

			<div className="rail-add">
				<textarea
					rows={2}
					value={draft}
					placeholder="加一条记忆…"
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
							event.preventDefault();
							void add();
						}
					}}
				/>
				<button type="button" className="rail-add-btn" disabled={busy || draft.trim() === ""} onClick={() => void add()}>
					添加
				</button>
			</div>
		</div>
	);
}

/** 一行「10-27 · 他自己记的」。没有日志时返回 undefined，界面就只写标题。 */
function stampOf(entry: MemoryEntry): string | undefined {
	if (entry.at === null) return undefined;
	const at = Date.parse(entry.at);
	if (Number.isNaN(at)) return undefined;
	const who = entry.by === "human" ? "我" : entry.by === "remember" ? "他自己记的" : "他记的";
	return `${dayLabel(at)} ${clockTime(at)} · ${who}`;
}

/* ── 小工具 ──────────────────────────────────────────────────────────── */

function kindLabel(kind: string): string {
	return kind === "dm" ? "私聊" : "群聊";
}

/**
 * 成员角色：后端只给三个值（`owner` / `lead` / `member`），界面只画 `lead`。
 *
 * 把 `member` 原样印出来等于印了一个英文枚举 —— 它说的是「其余所有人」，
 * 而列表里本来就是其余所有人。我自己的那一行也不在列表里。
 */
function memberRole(role: string): string {
	return role === "lead" ? "团队管理员" : "";
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
