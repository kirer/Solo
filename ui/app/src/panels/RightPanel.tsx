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
import { editPersonMemory, getPerson, getPersonMemory, getTeam } from "../api/client.ts";
import type { MemoryEntry, PersonMemory, PersonProfile, TeamProfile } from "../api/types.ts";
import { avatarSvg, groupAvatar } from "../lib/avatar.ts";
import { cellsOf } from "../plugin/registry.ts";
import { Slot } from "../plugin/Slot.tsx";
import { clockTime, dayLabel } from "../lib/format.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { backRight, openChannel, openPerson, setRight } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";

/**
 * 页签。内置三个 + 插件带来的（`plugin:<插件>:<id>`）—— 所以这里是 `string` 不是联合类型。
 * 插件页签从插槽注册表里读，启动时装完就不再变。
 */
type Tab = string;

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

	// 插件页签：注册表在挂载前就填好了，所以这里不用订阅。
	const tabs = [
		...TABS,
		...cellsOf("rightPanel.tab").map((cell) => ({ value: cell.id, text: cell.label ?? cell.id })),
	];

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
				<BackButton />
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
				{/* 身份卡挂在三个 tab 上面：换 tab 换的是「关于这个人的哪一面」，
				   不是「这是谁」—— 那张卡不该跟着 tab 一起消失。 */}
				<IdentityCard />
				<div className="rail-tabs detail-tabs" role="tablist" aria-label="右侧栏视图">
					{tabs.map((item) => (
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
				{/* key 变了才会重放入场动画：换 tab 是「同一块地方换了一份内容」。 */}
				<div className="detail-body" id="detail-body" key={tab}>
					{tab === "detail" ? (
						<DetailTab />
					) : tab === "skills" ? (
						<SkillsTab />
					) : tab === "memory" ? (
						<MemoryTab />
					) : (
						<PluginTab id={tab} />
					)}
				</div>
				{/* 插槽：右栏内容底下（换 tab 也在）。 */}
				<Slot name="rightPanel.bottom" />
			</div>
		</aside>
	);
}

/**
 * 插件页签的内容。
 *
 * 只按 id 从注册表里取，不缓存组件引用：插件在启动时注册一次，之后这个 id 一直有效。
 * 取不到（理论上不会）就什么都不画 —— 空白页签比报错页好，至少不吓人。
 */
function PluginTab(props: { id: string }): JSX.Element | null {
	const cell = cellsOf("rightPanel.tab").find((item) => item.id === props.id);
	return cell === undefined ? null : <cell.component />;
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

/* ── 身份卡 ──────────────────────────────────────────────────────────── */

/**
 * 这一栏讲的是「谁」：头像、名字、身份，加一行后端真有的数字。
 *
 * 卡上只放有出处的字段 —— 状态来自在线表，成员数来自成员表。
 * 设计稿里还有一列「~1.2s 响应」，那是编的，不画。
 */
function IdentityCard(): JSX.Element | null {
	const person = useStore((state) => state.person);
	const detail = useStore((state) => state.detail);
	const presence = useStore((state) => state.presence);
	// 私聊卡上写的是对面那个人的**身份**（`identity.md` 的 `title`，助理是「助理」），
	// 不是「私聊」这两个字 ——
	// 「私聊」说的是这个频道，卡片说的是这个人。档案只在这时多拉一次。
	const peerSlug =
		detail === null || detail.channel.kind !== "dm"
			? null
			: (detail.members.find((member) => member.slug !== "owner")?.slug ?? null);
	const { profile: peerProfile } = useProfile(peerSlug);

	if (person !== null) {
		const state = presence.get(person.slug)?.state ?? "idle";
		return (
			<Card
				avatar={avatarSvg({ slug: person.slug, name: person.label, size: 96, state: avatarState(state) })}
				name={person.label}
				tags={[person.title, ...(person.team === undefined ? [] : [person.team])]}
				stats={[
					{ k: "状态", v: stateLabel(state) },
					{ k: "频道", v: String(person.channels.length) },
				]}
			/>
		);
	}

	if (detail === null) return null;

	const channel = detail.channel;
	const members = detail.members.filter((member) => member.slug !== "owner");
	// 私聊的对面是他；群聊画群头像。私聊才谈得上「状态」，一个频道不会「在想」。
	const peer = channel.kind === "dm" ? members[0] : undefined;
	const state = peer === undefined ? "idle" : (presence.get(peer.slug)?.state ?? "idle");

	return (
		<Card
			avatar={
				peer === undefined
					? groupAvatar({
							people: members.slice(0, 4).map((member) => ({ slug: member.slug, label: member.label })),
							size: 96,
						})
					: avatarSvg({ slug: peer.slug, name: peer.label, size: 96, state: avatarState(state) })
			}
			name={channel.title}
			tags={
				peer === undefined
					? // 不挂团队 slug（`xiaokonglong`）：那是目录名，标题已经写着团队名。
						[kindLabel(channel.kind)]
					: [peerProfile?.title ?? ""]
			}
			stats={
				peer === undefined
					? [
							{ k: "成员", v: String(members.length + 1) },
							...(channel.leadLabel === undefined ? [] : [{ k: "团队管理员", v: channel.leadLabel }]),
						]
					: peerProfile === null
						? [{ k: "状态", v: stateLabel(state) }]
						: [
								{ k: "状态", v: stateLabel(state) },
								{ k: "频道", v: String(peerProfile.channels.length) },
							]
			}
		/>
	);
}

function Card(props: {
	avatar: string;
	name: string;
	tags: readonly string[];
	stats: readonly { k: string; v: string }[];
}): JSX.Element {
	const tags = props.tags.filter((tag) => tag !== "");
	return (
		<div className="detail-card">
			<span className="detail-av" dangerouslySetInnerHTML={{ __html: props.avatar }} />
			<span className="detail-ident">
				<span className="detail-name">{props.name}</span>
				{tags.length === 0 ? null : (
					<span className="detail-tags">
						{tags.map((tag) => (
							<span key={tag} className="detail-tag">
								{tag}
							</span>
						))}
					</span>
				)}
			</span>
			{props.stats.length === 0 ? null : (
				<div className="detail-card-stats" data-count={props.stats.length}>
					{props.stats.map((stat) => (
						<span key={stat.k} className="detail-stat">
							<span className="detail-stat-k">{stat.k}</span>
							<span className="detail-stat-v">{stat.v}</span>
						</span>
					))}
				</div>
			)}
		</div>
	);
}

function avatarState(state: string): "idle" | "thinking" | "working" | "done" {
	if (state === "working" || state === "thinking") return state;
	return "idle";
}

function stateLabel(state: string): string {
	if (state === "working") return "在做";
	if (state === "thinking") return "在想";
	if (state === "asleep") return "睡了";
	return "待命";
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
	// 身份在名册里（`people[].title`），成员表只带机器角色。团队管理员那份身份由角色补。
	const titles = new Map(people.map((actor) => [actor.slug, actor.title]));

	// 私聊只有一个人可介绍：画他的档案，不画「成员 2 / 我 / 他」这种一对一的废话。
	if (channel.kind === "dm" && members[0] !== undefined) {
		return <DmPerson slug={members[0].slug} label={members[0].label} />;
	}

	return (
		<div className="detail-sec">
			{channel.doing === undefined || channel.doing === "" ? null : (
				<div className="detail-field">
					<span className="detail-k">现状</span>
					<span className="detail-v">{channel.doing}</span>
				</div>
			)}
			<div className="detail-sec-head">
				成员 <span className="detail-count">{members.length + 1}</span>
			</div>
			<div className="detail-people">
				{people.length === 0 ? <p className="detail-empty">名册还没读出来。</p> : null}
				{/* 我在列表里，但点不动：我没有档案页（channel 的成员表也不含我）。 */}
				<div className="detail-person-btn is-static">
					<span
						className="detail-av"
						dangerouslySetInnerHTML={{ __html: avatarSvg({ slug: "owner", name: "我", size: 32, state: "idle" }) }}
					/>
					<span className="detail-person-name">我</span>
				</div>
				{members.map((member) => {
					const role = titles.get(member.slug) || memberRole(member.role);
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
									__html: avatarSvg({ slug: member.slug, name: member.label, size: 32, state: "idle" }),
								}}
							/>
							<span className="detail-person-name">{member.label}</span>
							{role === "" ? null : <span className="detail-person-title">{role}</span>}
						</button>
					);
				})}
			</div>

			{channel.team === undefined ? null : <TeamSection slug={channel.team} />}
		</div>
	);
}

/** 团队频道的「这个团队是什么」：README 正文。 */
function TeamSection(props: { slug: string }): JSX.Element | null {
	const [team, setTeam] = useState<TeamProfile | null>(null);
	useEffect(() => {
		let alive = true;
		setTeam(null);
		getTeam(props.slug)
			.then((next) => {
				if (alive) setTeam(next);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [props.slug]);
	if (team === null || team.body.trim() === "") return null;
	return (
		<>
			<div className="detail-sec-head">团队介绍</div>
			<div
				className="detail-doc"
				dangerouslySetInnerHTML={{ __html: renderMarkdown(stripTitle(team.body, team.name)) }}
			/>
		</>
	);
}

function PersonView(props: { person: PersonProfile }): JSX.Element {
	const { person } = props;
	const people = useStore((state) => state.people);
	const labels = new Map(people.map((actor) => [actor.slug, actor.label]));
	// 私聊不进「活跃频道」：那是和他说话的地方，不是他在哪儿活跃；
	// 列出来还会出现「知言的活跃频道里有知言」这种自己说自己。
	const rooms = person.channels.filter((channel) => channel.kind !== "dm");
	return (
		<div className="detail-sec">
			{/* 插槽：档案最上面（「汇报给」之前）。插件放这一层的设置项，比如「他用的模型」。 */}
			<Slot name="rightPanel.detail" />
			<div className="detail-sec-head">汇报给</div>
			<div className="detail-report">
				<span
					className="detail-av"
					dangerouslySetInnerHTML={{
						__html: avatarSvg({ slug: person.manager ?? "owner", name: person.managerLabel, size: 28 }),
					}}
				/>
				<span className="detail-report-name">{person.managerLabel}</span>
			</div>

			{rooms.length === 0 ? null : (
				<>
					<div className="detail-sec-head">活跃频道</div>
					<div className="detail-channels">
						{rooms.map((channel) => (
							<button
								type="button"
								key={channel.id}
								className="detail-channel"
								onClick={() => void openChannel(channel.id)}
							>
								{/* 群频道画这个群里真有的人（成员表来），跟我侧栏上的那个头像是同一张。 */}
								<span
									className="detail-tile"
									aria-hidden="true"
									dangerouslySetInnerHTML={{
										__html: groupAvatar({
											people: (channel.members ?? []).map((slug) => ({
												slug,
												label: labels.get(slug) ?? slug,
											})),
											size: 24,
										}),
									}}
								/>
								<span className="detail-channel-name">{channel.title}</span>
							</button>
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
		</div>
	);
}

/** 私聊的详情：介绍对面这个人。读不到档案时先画头像和名字，别空着。 */
function DmPerson(props: { slug: string; label: string }): JSX.Element {
	const { profile } = useProfile(props.slug);
	if (profile !== null) return <PersonView person={profile} />;
	// 档案还没到：身份卡已经画着头像和名字了，这里不重复。
	return <div className="detail-sec" />;
}

/** 一个人的档案。`state.person` 里已经有就不用再请求一次。 */
function useProfile(who: string | null): { profile: PersonProfile | null; error: string } {
	const storePerson = useStore((state) => state.person);
	const [profile, setProfile] = useState<PersonProfile | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		setError("");
		if (who === null) {
			setProfile(null);
			return;
		}
		if (storePerson !== null && storePerson.slug === who) {
			setProfile(storePerson);
			return;
		}
		let alive = true;
		setProfile(null);
		getPerson(who)
			.then((next) => {
				if (alive) setProfile(next);
			})
			.catch((reason: unknown) => {
				if (alive) setError(reason instanceof Error ? reason.message : "读不到这个人的档案");
			});
		return () => {
			alive = false;
		};
	}, [who, storePerson]);

	return { profile, error };
}

/* ── 技能 ────────────────────────────────────────────────────────────── */

/**
 * 技能与记忆的顶部：换人。
 *
 * 只列**当前频道的成员**（不含我）—— 名册里的人在不在这个频道是后端的事，
 * 这里不自己筛两遍。频道没人时退回名册。
 */
/**
 * 这三栏讲的是「谁的东西」：私聊与个人页只讲这个人的，团队频道只讲团队的，
 * 全员频道只讲全员都会的。频道自己已经说明了这件事，不另存一份状态。
 */
type Scope = "personal" | "team" | "all";

function useScope(): Scope {
	const person = useStore((state) => state.person);
	const detail = useStore((state) => state.detail);
	if (person !== null) return "personal";
	const channel = detail?.channel;
	if (channel === undefined || channel.kind === "dm") return "personal";
	return channel.team === undefined ? "all" : "team";
}

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
	// 私聊里候选只有一个：名字和下拉都没有意义 —— 这一栏讲的就是对面那个人。
	if (props.options.length < 2) return null;
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
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
					<path d="M6 9l6 6 6-6" />
				</svg>
			</span>
		</label>
	);
}

function SkillsTab(): JSX.Element {
	const scope = useScope();
	const team = useStore((state) => state.detail?.channel.team);
	const { who, options, setWho } = useWho();
	// 团队这一栏看的是团队目录，不读某个人的档案。
	const { profile, error } = useProfile(scope === "team" ? null : who);

	if (scope === "team" && team !== undefined) return <TeamSkills slug={team} />;
	if (who === null) return <p className="detail-empty">左边选一个会话，再回来看技能。</p>;

	// 只留当前作用域那一层：私聊看他的，全员频道看全员都会的，不混在一起。
	const skills = (profile?.skills ?? []).filter((skill) => skill.scope === scope);
	// 不数「会几件事」：这是一个清单，不是仪表盘；几件扫一眼就知道。
	const head =
		scope === "all" ? <span>全员都会</span> : options.length > 1 ? <WhoPicker who={who} options={options} onPick={setWho} /> : null;

	return (
		<div className="detail-sec rail-view" key={`${scope}:${who}`}>
			{head === null ? null : <div className="rail-head">{head}</div>}
			{error === "" ? null : <p className="rail-error">{error}</p>}
			{profile === null ? (
				<p className="detail-empty">正在读…</p>
			) : skills.length === 0 ? (
				<>
					<p className="detail-empty">{scope === "personal" ? "他还没有自己的技能。" : "全员还没有共享技能。"}</p>
					<p className="rail-hint">
						{scope === "personal"
							? "技能就是 members/&lt;slug&gt;/skills/ 下的 SKILL.md"
							: "全员技能放在 ~/.solo/skills/ 下"}
					</p>
				</>
			) : (
				skills.map((skill) => (
					<SkillRow
						key={skill.name}
						name={skill.name}
						description={skill.description}
						overrides={scope === "personal" && skill.overrides}
					/>
				))
			)}
		</div>
	);
}

/**
 * 团队频道里的技能：`teams/<slug>/skills/` 这一层（`agent/skills.ts` 的 `SkillScope = "team"`）。
 * 它盖在全员层上、被个人层盖住 —— 这个团队的人打开提示词就能看见这份清单。
 */
function TeamSkills(props: { slug: string }): JSX.Element {
	const [team, setTeam] = useState<TeamProfile | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		let alive = true;
		setTeam(null);
		setError("");
		getTeam(props.slug)
			.then((next) => {
				if (alive) setTeam(next);
			})
			.catch((reason: unknown) => {
				if (alive) setError(reason instanceof Error ? reason.message : "读不到团队技能");
			});
		return () => {
			alive = false;
		};
	}, [props.slug]);

	const skills = team?.skills ?? [];

	return (
		<div className="detail-sec rail-view">
			<div className="rail-head">
				<span>团队技能</span>
			</div>
			{error === "" ? null : <p className="rail-error">{error}</p>}
			{team === null ? (
				<p className="detail-empty">正在读…</p>
			) : skills.length === 0 ? (
				<>
					<p className="detail-empty">这个团队还没有自己的技能。</p>
					<p className="rail-hint">团队技能放在 teams/{props.slug}/skills/ 下</p>
				</>
			) : (
				skills.map((skill) => (
					<SkillRow
						key={skill.name}
						name={skill.name}
						description={skill.description}
						overrides={skill.overrides}
					/>
				))
			)}
		</div>
	);
}

/**
 * 一行技能：名字 + 两行描述；点开看全文（和 `run` 步骤同一种交互）。
 *
 * 行里不写「个人 / 全员」：这一栏已经按作用域筛过了。
 */
function SkillRow(props: { name: string; description: string; overrides: boolean }): JSX.Element {
	const [open, setOpen] = useState(false);
	return (
		<div className="rail-skill" data-open={open ? "true" : "false"}>
			<button type="button" className="rail-skill-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
				<span className="rail-skill-name">{props.name}</span>
			</button>
			{props.description === "" ? null : <p className="rail-skill-desc">{props.description}</p>}
			{props.overrides ? <p className="rail-hint">覆盖同名的上层技能</p> : null}
		</div>
	);
}

/* ── 记忆 ────────────────────────────────────────────────────────────── */

/**
 * 记忆：团队频道看团队记忆，其余看人。
 *
 * 团队记忆没有任何写入口 —— 它是 `team/settle.ts` 自动沉淀的（DESIGN §5），
 * 界面上只能看。人手上有「加一条 / 删掉这一条」，那是他自己的记忆。
 */
function MemoryTab(): JSX.Element {
	const scope = useScope();
	const team = useStore((state) => state.detail?.channel.team);
	if (scope === "team" && team !== undefined) return <TeamMemory slug={team} />;
	if (scope === "all") return <AllMemory />;
	return <PersonMemoryTab />;
}

/**
 * 全员没有共享记忆这一份数据：记忆只有「这个人的」和「团队的」两份。
 * 这一栏只说清楚这件事，不摆一个空列表假装它记得什么。
 */
function AllMemory(): JSX.Element {
	return (
		<div className="detail-sec rail-view">
			<div className="rail-head">
				<span>全员记忆</span>
			</div>
			<p className="detail-empty">全员没有共享记忆。</p>
			<p className="rail-hint">每人记自己的，团队记团队的；全员规矩写在 ~/.solo/rules.md</p>
		</div>
	);
}

function TeamMemory(props: { slug: string }): JSX.Element {
	const [team, setTeam] = useState<TeamProfile | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		let alive = true;
		setTeam(null);
		setError("");
		getTeam(props.slug)
			.then((next) => {
				if (alive) setTeam(next);
			})
			.catch((reason: unknown) => {
				if (alive) setError(reason instanceof Error ? reason.message : "读不到团队记忆");
			});
		return () => {
			alive = false;
		};
	}, [props.slug]);

	const entries = team?.memory.entries ?? [];

	return (
		<div className="detail-sec rail-view">
			<div className="rail-head">
				<span>团队记忆</span>
			</div>
			{error === "" ? null : <p className="rail-error">{error}</p>}
			{team === null ? (
				<p className="detail-empty">正在读…</p>
			) : entries.length === 0 ? (
				<>
					<p className="detail-empty">这个团队还没有沉淀出记忆。</p>
					<p className="rail-hint">收工结算时按 seed/prompt/95-settle.md 的判据自动记</p>
				</>
			) : (
				entries.map((entry) => (
					<div className="rail-memo" key={entry.heading}>
						<div className="rail-memo-head">
							<span className="rail-memo-stamp">{entry.heading}</span>
						</div>
						<p className="rail-memo-body">{entry.body}</p>
					</div>
				))
			)}
		</div>
	);
}

function PersonMemoryTab(): JSX.Element {
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
		<div className="detail-sec rail-view" key={who}>
			{options.length < 2 ? null : (
				<div className="rail-head">
					<WhoPicker who={who} options={options} onPick={setWho} />
				</div>
			)}

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
					placeholder="加一条记忆，⌘↵ 提交"
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
