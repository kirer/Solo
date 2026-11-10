/**
 * 右栏：一张平铺的资料表（docs/DESIGN.md §13.2），或它的另一态「后台任务」（§13.3）。
 *
 * 顺序固定：身份 → 统计 → 模型 / 预置词 → 记忆 / 技能 → 后台任务。不再有 tab：
 * 四个 tab 里装的是同一份东西的不同段落，一屏往下滚反而更快，也才谈得上
 * 「两端同一张表」。团队频道少两行（模型、工作空间跟着人走）。
 *
 * 它是聊天之上的一整屏（稿子 06 / 07 / 23）：退回聊天就是它的「返回」，
 * 后台任务也借用这一层（§13.3）。
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { editPersonMemory, getPerson, getPersonMemory, getPersonTurns, getTeam, updateChannel } from "../api/client.ts";
import type { ChannelDetail, ChannelResponder, MemoryEntry, PersonMemory, PersonProfile, TeamProfile, Turn } from "../api/types.ts";
import { avatarSvg, groupAvatar } from "../lib/avatar.ts";
import { SelectField, TextAreaField } from "../lib/field.tsx";
import { Fold } from "../lib/fold.tsx";
import { cellsOf, type SlotCell } from "../plugin/registry.ts";
import { SLOT_MARK, Slot } from "../plugin/Slot.tsx";
import { clockTime, dayLabel, humanDuration, relTime } from "../lib/format.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { backRight, clampDockWidth, closeDock, closeRightFile, closeRightPage, closeTasks, openPerson, openTasks, refreshDetail, setDockWidth, setRight, getState } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";
import { FilePreview } from "./FilePreview.tsx";
import { TasksView, workTurns } from "./TasksPanel.tsx";

export function RightPanel(): JSX.Element {
	const open = useStore((state) => state.right.open);
	const tasksOpen = useStore((state) => state.tasks.open);
	const trail = useStore((state) => state.trail);
	const dock = useStore((state) => state.dock);
	const rightPage = useStore((state) => state.rightPage);
	const rightFile = useStore((state) => state.rightFile);
	const dockWidth = useStore((state) => state.dockWidth);
	const [mounted, setMounted] = useState(open);

	useEffect(() => {
		if (open) {
			setMounted(true);
			return;
		}
		// 关：等过渡跑完再真正卸载，否则直接「啪」地消失。
		const timer = window.setTimeout(() => setMounted(false), 300);
		return () => window.clearTimeout(timer);
	}, [open]);

	// 窗口变窄（拔了外接屏、把窗口拖小）时把已存的宽度再夹一次：拖拽只在拖的那一刻夹，
	// 存的数是在别的窗口尺寸下算出来的。1920 上存的 1500 换到 1280 会把整列对话盖死。
	useEffect(() => {
		const onResize = (): void => {
			const now = getState().dockWidth;
			if (now === null) return;
			const fitted = clampDockWidth(now, window.innerWidth);
			// 只有真的越界才写回：每次 resize 都写盘会把偏好刷成噪声。
			if (fitted !== now) setDockWidth(fitted);
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	// 点/摸右栏以外的地方（中间的消息、左边的列表、输入框）就收起来 ——
	// 它是一张浮在纸上的临时页，不是常驻的一列。顶栏那两颗「资料」除外：
	// 它们自己负责开合，不然按下先被这里关掉、抬手又被它重新打开。
	useEffect(() => {
		if (!open) return;
		const onDown = (event: PointerEvent): void => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (target.closest("aside.detail") !== null) return;
			if (target.closest('[aria-label="资料与后台任务"], [aria-label="资料"]') !== null) return;
			setRight({ open: false });
		};
		document.addEventListener("pointerdown", onDown, true);
		return () => document.removeEventListener("pointerdown", onDown, true);
	}, [open]);

	if (!open && !mounted) return <aside className="detail" hidden />;

	// 这一栏是一叠纸：工作台 / 后台任务 / 资料页各有上一层，返回就退一张。
	const back = (): void => {
		if (dock !== null) closeDock();
		else if (rightPage !== null) closeRightPage();
		else if (rightFile !== null) closeRightFile();
		else if (tasksOpen) closeTasks();
		else if (trail.length > 1) backRight();
		else setRight({ open: false });
	};
	const pageCell = rightPage === null ? undefined : cellsOf("app.page").find((cell) => cell.plugin === rightPage);
	const fileName = rightFile === null ? "" : (rightFile.split("/").pop() ?? rightFile);
	const title =
		dock !== null
			? "工作台"
			: rightPage !== null
				? (pageCell?.label ?? rightPage)
				: rightFile !== null
					? fileName
					: tasksOpen
						? "后台任务"
						: "资料";
	// 这一栏永远有出口：标题条那颗返回 / 关闭在每一层都在（宽窗口里顶栏那颗「资料」
	// 常被这一栏自己盖住，不能只指望它）。

	return (
		<aside
			className="detail"
			id="detail"
			data-open={open ? "true" : "false"}
			data-tasks={tasksOpen ? "true" : "false"}
			data-dock={dock === null ? "false" : "true"}
			data-page={rightPage === null ? "false" : "true"}
			aria-label={title}
			// 渲染前再夹一次：`resize` 有延迟，窄窗口的首帧也得先放得下。
			style={
				dockWidth === null
					? undefined
					: ({ "--panel-w": `${String(clampDockWidth(dockWidth, typeof window === "undefined" ? dockWidth : window.innerWidth))}px` } as CSSProperties)
			}
			// 关的时候留在 DOM 里淡出（`data-open="false"` + transition），卸不卸由上面那个 300ms 计时决定。
			aria-hidden={open ? undefined : "true"}
		>
			{/* 这一栏一直可以拖宽（双击回默认）：资料和工作台用同一个宽度，换页不跳。 */}
			<PanelGrip width={dockWidth} />
			<div className="detail-bar">
				{/* 这一栏和聊天一样是「钻下去的一层」：出口是左上角的返回，不是一颗 ×。 */}
				<button type="button" className="icon-btn" id="detail-close" aria-label="返回" title="返回" onClick={back}>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
						<path d="M14.5 5.5 8 12l6.5 6.5" />
					</svg>
				</button>
				<h2 className="detail-title">{title}</h2>
				<span className="sheet-grow" />
			</div>
			{dock !== null ? (
				<div className="detail-dock" key="dock" aria-label="工作台">
					<Slot name="dock" />
				</div>
			) : rightPage !== null ? (
				<div className="detail-dock" key={`page:${rightPage}`} aria-label={title}>
					<Slot name="app.page" page={rightPage} />
				</div>
			) : rightFile !== null ? (
				<div className="detail-dock" key={`file:${rightFile}`} aria-label={title}>
					<FilePreview path={rightFile} />
				</div>
			) : (
				<div className="detail-panel" id="detail-panel" key={tasksOpen ? "tasks" : "profile"}>
					{tasksOpen ? <TasksView /> : <ProfileView />}
					<Slot name="rightPanel.bottom" />
				</div>
			)}
		</aside>
	);
}

/**
 * 右栏的左边线：拖它改宽度，双击回默认。
 *
 * 宽度是这一栏的，不是某一页的 —— 资料、后台任务、工作台共用同一个值，
 * 换页时宽度不跳。形状照 agent harness 的分隔条：线是 0.5px 的，抓手往外扩
 * 8px 才好点中；拖的时候整页都是 `col-resize`，指针跑快了也不闪。
 */
function PanelGrip({ width }: { width: number | null }): JSX.Element {
	const dragging = useRef(false);

	const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
		if (event.button !== 0) return;
		event.preventDefault();
		const grip = event.currentTarget;
		const startX = event.clientX;
		const panel = grip.parentElement;
		const start = width ?? panel?.getBoundingClientRect().width ?? 520;
		dragging.current = true;
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";

		const move = (ev: PointerEvent): void => {
			if (!dragging.current) return;
			// 左边至少给对话留 420：拖到底也不能把正文盖满。区间和读盘时同一份常量。
			setDockWidth(clampDockWidth(start - (ev.clientX - startX), window.innerWidth));
		};
		const up = (): void => {
			dragging.current = false;
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", up);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", up);
	};

	return (
		<div
			className="dock-grip"
			role="separator"
			aria-orientation="vertical"
			aria-label="调整右栏宽度"
			onPointerDown={onPointerDown}
			onDoubleClick={() => setDockWidth(null)}
		/>
	);
}

/* ── 资料表 ──────────────────────────────────────────────────────────── */

function ProfileView(): JSX.Element {
	const person = useStore((state) => state.person);
	const detail = useStore((state) => state.detail);

	// 打开的是某个人的档案页：整栏讲他。
	if (person !== null) return <PersonPanel slug={person.slug} fallback={person} />;
	// 没选频道时宿主不画这一栏（`App.tsx` 的门），这里只是兜底。
	if (detail === null) return <></>;

	const channel = detail.channel;
	// 私聊：整栏讲对面那个人，和档案页同一张表。
	if (channel.kind === "dm") {
		const peer = detail.members.find((member) => member.slug !== "owner");
		if (peer !== undefined) return <PersonPanel slug={peer.slug} />;
	}
	if (channel.team !== undefined) {
		return <TeamPanel slug={channel.team} channel={channel} members={detail.members} title={channel.title} />;
	}
	return <AllPanel id={channel.id} channel={channel} members={detail.members} title={channel.title} />;
}

/** 一个人的资料表。`fallback` 是 store 里已经有的档案，省一次请求。 */
function PersonPanel(props: { slug: string; fallback?: PersonProfile }): JSX.Element {
	const { profile } = useProfile(props.slug, props.fallback);
	const people = useStore((state) => state.people);
	const presence = useStore((state) => state.presence);
	const [openRow, setOpenRow] = useState<string | null>(null);
	const actor = people.find((item) => item.slug === props.slug);
	const label = profile?.label ?? actor?.label ?? props.slug;
	const title = profile?.title ?? actor?.title ?? "";
	const rawState = presence.get(props.slug)?.state ?? actor?.activity ?? "idle";
	const state = String(rawState);
	const turns = useTurns(props.slug);
	// 后台任务那一屏只列动过手的轮次（`workTurns`），这里数同一份，免得进去少了几轮。
	const tasks = turns === undefined ? undefined : workTurns(turns);
	const memoryCount = useMemoryCount(props.slug);
	const skillCount = profile?.skills.length ?? 0;

	return (
		<div className="prof" key={props.slug}>
			<div className="prof-who">
				<span
					className="prof-av"
					aria-hidden="true"
					dangerouslySetInnerHTML={{
						__html: avatarSvg({
							slug: props.slug,
							name: label,
							size: 72,
							state: avatarState(state),
							assistant: actor?.assistant === true,
						}),
					}}
				/>
				<span className="prof-name">{label}</span>
				<span className="prof-role">{[title, stateLabel(state)].filter((part) => part !== "").join(" · ")}</span>
				<StatsLine turns={turns} />
			</div>

			<div className="prof-card">
				<Row
					icon={<IconCpu />}
					title="模型"
					value={profile?.model === undefined || profile.model === "" ? "还没配" : profile.model}
					mono
					onClick={profile === undefined ? undefined : () => setOpenRow(openRow === "model" ? null : "model")}
					open={openRow === "model"}
				/>
				<Fold open={openRow === "model"}>
					<div className="prof-panel">
						{/* 插槽：模型管理插件在这里放「给他换模型」的控件；没装就只剩下面那句说明。 */}
						<Slot name="rightPanel.detail" />
						<p className="prof-note">每轮按这里配的模型跑；插件页的「模型管理」里也能改。</p>
					</div>
				</Fold>
				<Row
					icon={<IconDoc />}
					title="预置词"
					sub="每轮从磁盘重读，改完下一句就生效"
					value="identity.md"
					mono
					onClick={() => setOpenRow(openRow === "prompt" ? null : "prompt")}
					open={openRow === "prompt"}
				/>
				<Fold open={openRow === "prompt"}>
					<div className="prof-panel">
						{profile === undefined ? (
							<p className="prof-note">正在读…</p>
						) : profile.body.trim() === "" ? (
							<p className="prof-note">identity.md 还是空的。</p>
						) : (
							<div className="prof-doc" dangerouslySetInnerHTML={{ __html: renderMarkdown(stripTitle(profile.body, profile.label)) }} />
						)}
					</div>
				</Fold>
			</div>

			<div className="prof-card">
				<Row
					icon={<IconBook />}
					title="记忆"
					sub="他自己写，也自己删"
					value={memoryCount === undefined ? "" : `${String(memoryCount)} 条`}
					onClick={() => setOpenRow(openRow === "memory" ? null : "memory")}
					open={openRow === "memory"}
				/>
				<Fold open={openRow === "memory"}>
					<MemoryPanel slug={props.slug} />
				</Fold>
				<Row
					icon={<IconStar />}
					title="技能"
					sub="个人 / 团队 / 全员三层，同名的个人盖团队"
					value={profile === undefined ? "" : `${String(skillCount)} 个`}
					onClick={() => setOpenRow(openRow === "skills" ? null : "skills")}
					open={openRow === "skills"}
				/>
				<Fold open={openRow === "skills"}>
					<div className="prof-panel">
						{profile === undefined ? (
							<p className="prof-note">正在读…</p>
						) : profile.skills.length === 0 ? (
							<p className="prof-note">他还没有自己的技能。技能就是 members/&lt;slug&gt;/skills/ 下的 SKILL.md。</p>
						) : (
							profile.skills.map((skill) => (
								<div className="prof-item" key={skill.name}>
									<span className="prof-item-name">{skill.name}</span>
									{skill.description === "" ? null : <span className="prof-item-sub">{skill.description}</span>}
									{skill.overrides ? <span className="prof-item-sub">覆盖同名的上层技能</span> : null}
								</div>
							))
						)}
					</div>
				</Fold>
				<PluginRows openRow={openRow} setOpenRow={setOpenRow} />
			</div>

			<div className="prof-card">
				<Row
					icon={<IconPulse />}
					title="后台任务"
					sub={tasks === undefined ? "" : turnsLine(tasks)}
					value={tasks === undefined ? "" : `${String(tasks.length)} 轮`}
					onClick={() => openTasks(props.slug)}
				/>
			</div>
		</div>
	);
}

function PluginSlot(props: { id: string; cells: readonly SlotCell[] }): JSX.Element | null {
	const cell = props.cells.find((item) => item.id === props.id);
	const Component = cell?.component;
	return Component === undefined ? null : <Component />;
}

/**
 * 插件往资料表里加的行（`rightPanel.row`）。
 *
 * 两种格子：给 `onOpen` 的点一行交给插件（「工作空间」开一整页），没给的按老规矩
 * 在本栏里展开组件。人、团队两种资料表共用这一份，免得插件只出现在一边。
 */
function PluginRows(props: {
	openRow: string | null;
	setOpenRow: (id: string | null) => void;
}): JSX.Element | null {
	const cells = cellsOf("rightPanel.row");
	if (cells.length === 0) return null;
	const inline = props.openRow === null ? undefined : cells.find((cell) => cell.id === props.openRow && cell.component !== undefined);
	return (
		<>
			{SLOT_MARK ? <div className="slot-mark" data-slot="rightPanel.row" /> : null}
			{cells.map((cell) => (
				<Row
					key={cell.id}
					icon={<IconPlug />}
					title={cell.label ?? cell.id}
					onClick={() =>
						cell.onOpen === undefined ? props.setOpenRow(props.openRow === cell.id ? null : cell.id) : cell.onOpen()
					}
					open={cell.onOpen === undefined && props.openRow === cell.id}
				/>
			))}
			{inline === undefined ? null : (
				<div className="prof-panel">
					<PluginSlot id={inline.id} cells={cells} />
				</div>
			)}
		</>
	);
}

/** 一行统计：今天 N 轮 · 共 Xm · 最近 …（现算，不新增接口）。 */
function StatsLine(props: { turns: readonly Turn[] | undefined }): JSX.Element | null {
	if (props.turns === undefined) return null;
	const today = startOfToday();
	const todayTurns = props.turns.filter((turn) => turn.startedAt >= today);
	const total = todayTurns.reduce((sum, turn) => sum + (turn.endedAt === undefined ? 0 : turn.endedAt - turn.startedAt), 0);
	const last = props.turns.reduce<number | undefined>((at, turn) => (at === undefined || turn.startedAt > at ? turn.startedAt : at), undefined);
	return (
		<div className="prof-stats">
			<span>
				今天 <b>{todayTurns.length} 轮</b>
			</span>
			{todayTurns.length === 0 ? null : (
				<>
					<i />
					<span>
						共 <b>{humanDuration(total)}</b>
					</span>
				</>
			)}
			{last === undefined ? null : (
				<>
					<i />
					<span>
						最近 <b>{relTime(last)}</b>
					</span>
				</>
			)}
		</div>
	);
}

function turnsLine(turns: readonly Turn[]): string {
	const running = turns.filter((turn) => turn.status === "running").length;
	const last = turns.reduce<number | undefined>((at, turn) => (at === undefined || turn.startedAt > at ? turn.startedAt : at), undefined);
	const parts = [running === 0 ? undefined : `${String(running)} 个正在跑`, last === undefined ? "还没跑过" : `最近一轮在 ${relTime(last)}`];
	return parts.filter((part) => part !== undefined).join(" · ");
}

/** 团队频道：身份 → 统计 → 成员 → 团队介绍 / 记忆 / 技能。 */
function TeamPanel(props: {
	slug: string;
	channel: ChannelDetail["channel"];
	members: readonly { slug: string; label: string; role: string }[];
	title: string;
}): JSX.Element {
	const { team, error } = useTeam(props.slug);
	const [openRow, setOpenRow] = useState<string | null>(null);
	const members = props.members;

	return (
		<div className="prof" key={props.slug}>
			<div className="prof-who">
				<span
					className="prof-av prof-av-group"
					aria-hidden="true"
					dangerouslySetInnerHTML={{
						__html: groupAvatar({
							people: members.slice(0, 4).map((member) => ({
								slug: member.slug,
								label: member.label,
								assistant: member.role === "assistant",
							})),
							size: 72,
						}),
					}}
				/>
				<span className="prof-name">{team?.name ?? props.title}</span>
				<span className="prof-role">团队 · {members.length} 人</span>
				<div className="prof-stats">
					<span>
						记忆 <b>{team === undefined ? "—" : `${String(team.memory.entries.length)} 条`}</b>
					</span>
					<i />
					<span>
						成员 <b>{members.length} 人</b>
					</span>
				</div>
			</div>

			{error === "" ? null : <p className="prof-note">{error}</p>}

			<MemberGrid members={members} />

			<div className="prof-card">
				<Row
					icon={<IconDoc />}
					title="团队介绍"
					value="README.md"
					mono
					onClick={() => setOpenRow(openRow === "about" ? null : "about")}
					open={openRow === "about"}
				/>
				{openRow === "about" ? (
					<div className="prof-panel">
						{team === undefined ? (
							<p className="prof-note">正在读…</p>
						) : team.body.trim() === "" ? (
							<p className="prof-note">README.md 还是空的。</p>
						) : (
							<div className="prof-doc" dangerouslySetInnerHTML={{ __html: renderMarkdown(stripTitle(team.body, team.name)) }} />
						)}
					</div>
				) : null}
				<Row
					icon={<IconBook />}
					title="团队记忆"
					sub="他们会自己写，这儿只读"
					value={team === undefined ? "" : `${String(team.memory.entries.length)} 条`}
					onClick={() => setOpenRow(openRow === "memory" ? null : "memory")}
					open={openRow === "memory"}
				/>
				{openRow === "memory" ? (
					<div className="prof-panel">
						{team === undefined ? (
							<p className="prof-note">正在读…</p>
						) : team.memory.entries.length === 0 ? (
							<p className="prof-note">这个团队还没有记忆。成员或助理用 remember(scope=team) 记。</p>
						) : (
							team.memory.entries.map((entry) => (
								<div className="prof-item" key={entry.heading}>
									<span className="prof-item-k">{entry.heading}</span>
									<span className="prof-item-body">{entry.body}</span>
								</div>
							))
						)}
					</div>
				) : null}
				<Row
					icon={<IconStar />}
					title="团队技能"
					sub="这个团队的人都带着"
					value={team === undefined ? "" : `${String(team.skills.length)} 个`}
					onClick={() => setOpenRow(openRow === "skills" ? null : "skills")}
					open={openRow === "skills"}
				/>
				{openRow === "skills" ? (
					<div className="prof-panel">
						{team === undefined ? (
							<p className="prof-note">正在读…</p>
						) : team.skills.length === 0 ? (
							<p className="prof-note">这个团队还没有自己的技能。团队技能放在 teams/{props.slug}/skills/ 下。</p>
						) : (
							team.skills.map((skill) => (
								<div className="prof-item" key={skill.name}>
									<span className="prof-item-name">{skill.name}</span>
									{skill.description === "" ? null : <span className="prof-item-sub">{skill.description}</span>}
								</div>
							))
						)}
					</div>
				) : null}
				<PluginRows openRow={openRow} setOpenRow={setOpenRow} />
			</div>

			<ChannelSettings key={props.channel.id} channel={props.channel} members={members} />
		</div>
	);
}

/** 群聊：没有团队文档。全员频道多一行共享技能，拉起来的群只有成员。 */
function AllPanel(props: {
	id: string;
	channel: ChannelDetail["channel"];
	members: readonly { slug: string; label: string; role: string }[];
	title: string;
}): JSX.Element {
	const first = props.members.find((member) => member.slug !== "owner");
	const { profile } = useProfile(first?.slug ?? null);
	const [openRow, setOpenRow] = useState<string | null>(null);
	const skills = (profile?.skills ?? []).filter((skill) => skill.scope === "all");
	/** 全员频道有固定 id（`shell.allChannel` 的默认值），拉起来的群没有共享技能。 */
	const isAll = props.id === "all";

	return (
		<div className="prof">
			<div className="prof-who">
				<span
					className="prof-av prof-av-group"
					aria-hidden="true"
					dangerouslySetInnerHTML={{
						__html: groupAvatar({
							people: props.members.slice(0, 4).map((member) => ({
								slug: member.slug,
								label: member.label,
								assistant: member.role === "assistant",
							})),
							size: 72,
						}),
					}}
				/>
				<span className="prof-name">{props.title}</span>
				<span className="prof-role">
					{isAll ? "全员" : "群聊"} · {props.members.length} 人
				</span>
			</div>

			<MemberGrid members={props.members} />

			{isAll ? (
				<div className="prof-card">
					<Row
						icon={<IconStar />}
						title="全员技能"
						sub="人人可读，同名的个人技能盖住它"
						value={profile === undefined ? "" : `${String(skills.length)} 个`}
						onClick={() => setOpenRow(openRow === "skills" ? null : "skills")}
						open={openRow === "skills"}
					/>
					{openRow === "skills" ? (
						<div className="prof-panel">
							{profile === undefined ? (
								<p className="prof-note">正在读…</p>
							) : skills.length === 0 ? (
								<p className="prof-note">全员还没有共享技能。全员技能放在 ~/.solo/skills/ 下。</p>
							) : (
								skills.map((skill) => (
									<div className="prof-item" key={skill.name}>
										<span className="prof-item-name">{skill.name}</span>
										{skill.description === "" ? null : <span className="prof-item-sub">{skill.description}</span>}
									</div>
								))
							)}
						</div>
					) : null}
				</div>
			) : null}

			<ChannelSettings key={props.channel.id} channel={props.channel} members={props.members} />
		</div>
	);
}

/**
 * 频道的两个设置：共享指令（每轮贴在投递正文里）与没人 `@` 时谁接话。
 *
 * 两者都跟着频道走、下一条消息生效，所以放在这个房间的资料页里，而不是全局设置。
 * `@` 永远优先于接话规则 —— 规则只回答「没人点名时谁接」。
 */
function ChannelSettings(props: {
	channel: ChannelDetail["channel"];
	members: readonly { slug: string; label: string; role: string }[];
}): JSX.Element {
	const { channel } = props;
	const [openRow, setOpenRow] = useState<string | null>(null);
	const [bulletin, setBulletin] = useState(channel.bulletin ?? "");
	const [responder, setResponder] = useState(responderKey(channel.responder));
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

	const savedBulletin = channel.bulletin ?? "";
	const savedResponder = responderKey(channel.responder);
	const dirty = bulletin.trim() !== savedBulletin || responder !== savedResponder;
	// 缺省行为跟着房间形态走（ADR-095）：团队叫助理、群里人人接、全员叫助理。
	// 写错一句「接上一位说话的」会让人以为群里只有一个人会答。
	const fallback = channel.id.startsWith("group:") ? "人人都接" : "叫助理";
	const candidates = props.members.filter((member) => member.slug !== "owner");

	async function save(): Promise<void> {
		setBusy(true);
		setNote(null);
		try {
			await updateChannel(channel.id, {
				bulletin: bulletin.trim() === "" ? null : bulletin.trim(),
				responder: responder === "default" ? null : responderOf(responder),
			});
			await refreshDetail();
			setNote({ text: "已保存，下一条消息生效。", error: false });
		} catch (error) {
			setNote({ text: error instanceof Error ? error.message : String(error), error: true });
		} finally {
			setBusy(false);
		}
	}

	const foot = (
		<div className="prof-add-foot">
			{note === null ? null : (
				<p className="prof-note" data-error={note.error ? "true" : "false"}>
					{note.text}
				</p>
			)}
			<span className="prof-item-grow" />
			<button type="button" className="prof-add-btn" disabled={busy || !dirty} onClick={() => void save()}>
				{busy ? "保存中…" : "保存"}
			</button>
		</div>
	);

	return (
		<div className="prof-card">
			<Row
				icon={<IconDoc />}
				title="共享指令"
				sub="每轮都贴给他们，像这个房间的长期约定"
				value={savedBulletin === "" ? "未写" : `${String(savedBulletin.length)} 字`}
				onClick={() => setOpenRow(openRow === "bulletin" ? null : "bulletin")}
				open={openRow === "bulletin"}
			/>
			{openRow === "bulletin" ? (
				<div className="prof-panel">
					<div className="prof-add">
						<TextAreaField
							rows={5}
							value={bulletin}
							maxLength={12000}
							placeholder="这个房间的长期约定：只讨论上线；回话先说进度；改代码前先看一眼 docs/…"
							onChange={(event) => setBulletin(event.target.value)}
						/>
						<p className="prof-note">
							{bulletin.trim() === "" ? "空着就是不贴。" : `${String(bulletin.trim().length)} / 12000 字`}
						</p>
						{foot}
					</div>
				</div>
			) : null}

			<Row
				icon={<IconPulse />}
				title="接话规则"
				sub={`没人 @ 时谁接：默认${fallback}`}
				value={responderLabel(responder, props.members)}
				onClick={() => setOpenRow(openRow === "responder" ? null : "responder")}
				open={openRow === "responder"}
			/>
			{openRow === "responder" ? (
				<div className="prof-panel">
					<div className="prof-add">
						<SelectField value={responder} onChange={(event) => setResponder(event.target.value)}>
							<option value="default">默认（{fallback}）</option>
							<option value="mentions">只有被 @ 的人才接</option>
							<option value="everyone">房间里的人人都接</option>
							{candidates.map((member) => (
								<option value={`lead:${member.slug}`} key={member.slug}>
									固定由 {member.label} 接
								</option>
							))}
						</SelectField>
						<p className="prof-note">不管选哪个，@ 了人都听 @ 的；这条只管没人点名的时候。</p>
						{foot}
					</div>
				</div>
			) : null}
		</div>
	);
}

/** 下拉框的键：`default` / `mentions` / `everyone` / `lead:<slug>`。 */
function responderKey(responder: ChannelResponder | undefined): string {
	if (responder === undefined) return "default";
	if (responder.kind === "lead") return `lead:${responder.slug}`;
	return responder.kind;
}

function responderOf(key: string): ChannelResponder {
	if (key.startsWith("lead:")) return { kind: "lead", slug: key.slice(5) };
	return key === "everyone" ? { kind: "everyone" } : { kind: "mentions" };
}

function responderLabel(key: string, members: readonly { slug: string; label: string }[]): string {
	if (key === "default") return "默认";
	if (key === "everyone") return "所有人";
	if (key === "mentions") return "只有 @ 的人";
	const slug = key.slice(5);
	return `${members.find((member) => member.slug === slug)?.label ?? slug} 接`;
}

/** 成员一行四格：头像 + 名字，点开是他的资料；我自己那一格不跳。 */
function MemberGrid(props: { members: readonly { slug: string; label: string; role: string }[] }): JSX.Element {
	const others = props.members.filter((member) => member.slug !== "owner");
	const ordered = [...others, ...props.members.filter((member) => member.slug === "owner")];
	return (
		<div className="prof-card">
			<div className="prof-grid">
				{ordered.map((member) => {
					const av = (
						<span
							className="prof-cell-av"
							aria-hidden="true"
							dangerouslySetInnerHTML={{
								__html: avatarSvg({
									slug: member.slug,
									name: member.label,
									size: 52,
									state: "idle",
									assistant: member.role === "assistant",
								}),
							}}
						/>
					);
					const name = <span className="prof-cell-name">{member.label}</span>;
					return member.slug === "owner" ? (
						<div className="prof-cell is-static" key={member.slug}>
							{av}
							{name}
						</div>
					) : (
						<button type="button" className="prof-cell" key={member.slug} onClick={() => void openPerson(member.slug)}>
							{av}
							{name}
						</button>
					);
				})}
			</div>
		</div>
	);
}

/* ── 记忆（可写：那是他自己的记忆） ────────────────────────────────── */

function MemoryPanel(props: { slug: string }): JSX.Element {
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
		void refresh(props.slug);
	}, [props.slug, refresh]);

	const add = async (): Promise<void> => {
		const text = draft.trim();
		if (text === "" || busy) return;
		setBusy(true);
		setError("");
		try {
			await editPersonMemory(props.slug, { op: "add", text });
			setDraft("");
			await refresh(props.slug);
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
			await editPersonMemory(props.slug, { op: "forget", heading: entry.heading });
			await refresh(props.slug);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "没删掉");
		} finally {
			setBusy(false);
		}
	};

	const entries = data?.entries ?? [];

	return (
		<div className="prof-panel">
			{error === "" ? null : <p className="prof-note">{error}</p>}
			{data === null ? (
				<p className="prof-note">正在读…</p>
			) : entries.length === 0 ? (
				<p className="prof-note">还没有记忆。</p>
			) : (
				entries.map((entry) => (
					<div className="prof-item" key={entry.heading}>
						<div className="prof-item-head">
							<span className="prof-item-k">{stampOf(entry) ?? entry.heading}</span>
							<span className="prof-item-grow" />
							<button
								type="button"
								className="prof-item-more"
								aria-label="这一条的操作"
								aria-expanded={menu === entry.heading}
								onClick={() => setMenu((current) => (current === entry.heading ? null : entry.heading))}
							>
								⋯
							</button>
							{menu !== entry.heading ? null : (
								<span className="prof-item-menu">
									<button type="button" className="prof-item-del" disabled={busy} onClick={() => void forget(entry)}>
										删掉这一条
									</button>
									<button type="button" onClick={() => setMenu(null)}>
										取消
									</button>
								</span>
							)}
						</div>
						<span className="prof-item-body">{entry.body}</span>
					</div>
				))
			)}
			<div className="prof-add">
				<TextAreaField
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
				<button type="button" className="prof-add-btn" disabled={busy || draft.trim() === ""} onClick={() => void add()}>
					添加
				</button>
			</div>
		</div>
	);
}

/* ── 一行 ────────────────────────────────────────────────────────────── */

function Row(props: {
	icon?: JSX.Element | undefined;
	title: string;
	sub?: string | undefined;
	value?: string | undefined;
	mono?: boolean | undefined;
	open?: boolean | undefined;
	onClick?: (() => void) | undefined;
}): JSX.Element {
	const content = (
		<>
			{props.icon === undefined ? null : <span className="prof-row-ico">{props.icon}</span>}
			<span className="prof-row-main">
				<span className="prof-row-title">{props.title}</span>
				{props.sub === undefined || props.sub === "" ? null : <span className="prof-row-sub">{props.sub}</span>}
			</span>
			{props.value === undefined || props.value === "" ? null : (
				<span className="prof-row-val" data-mono={props.mono === true ? "true" : "false"}>
					{props.value}
				</span>
			)}
			{props.onClick === undefined ? null : (
				<svg className="prof-chev" data-open={props.open === true ? "true" : "false"} width="7" height="11" viewBox="0 0 8 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
					<path d="m1.5 1.5 5 5-5 5" />
				</svg>
			)}
		</>
	);
	return props.onClick === undefined ? (
		<div className="prof-row">{content}</div>
	) : (
		<button type="button" className="prof-row" aria-expanded={props.open === true} onClick={props.onClick}>
			{content}
		</button>
	);
}

/* ── 取数 ────────────────────────────────────────────────────────────── */

function useProfile(who: string | null, fallback?: PersonProfile): { profile: PersonProfile | undefined; error: string } {
	const storePerson = useStore((state) => state.person);
	const [profile, setProfile] = useState<PersonProfile | undefined>(fallback);
	const [error, setError] = useState("");

	useEffect(() => {
		setError("");
		if (who === null) {
			setProfile(undefined);
			return;
		}
		const known = fallback ?? (storePerson !== null && storePerson.slug === who ? storePerson : undefined);
		if (known !== undefined) {
			setProfile(known);
			return;
		}
		let alive = true;
		setProfile(undefined);
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
	}, [who, storePerson, fallback]);

	return { profile, error };
}

function useTeam(slug: string): { team: TeamProfile | undefined; error: string } {
	const [team, setTeam] = useState<TeamProfile | undefined>(undefined);
	const [error, setError] = useState("");

	useEffect(() => {
		let alive = true;
		setTeam(undefined);
		setError("");
		getTeam(slug)
			.then((next) => {
				if (alive) setTeam(next);
			})
			.catch((reason: unknown) => {
				if (alive) setError(reason instanceof Error ? reason.message : "读不到这个团队");
			});
		return () => {
			alive = false;
		};
	}, [slug]);

	return { team, error };
}

/** 记忆条数：只为了那一行右边的数，展开时才拉全文（同一个接口，小）。 */
function useMemoryCount(slug: string): number | undefined {
	const open = useStore((state) => state.right.open);
	const [count, setCount] = useState<number | undefined>(undefined);
	useEffect(() => {
		if (!open) return;
		let alive = true;
		getPersonMemory(slug)
			.then((body) => {
				if (alive) setCount(body.entries.length);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [slug, open]);
	return count;
}

/** 「今天 N 轮」要的那份轮次：面板一开就拉，收着不拉。 */
function useTurns(slug: string): readonly Turn[] | undefined {
	const [turns, setTurns] = useState<readonly Turn[] | undefined>(undefined);
	const open = useStore((state) => state.right.open);
	useEffect(() => {
		if (!open) return;
		let alive = true;
		setTurns(undefined);
		getPersonTurns(slug, 30)
			.then((body) => {
				if (alive) setTurns(body.turns);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [slug, open]);
	return turns;
}

/* ── 小工具 ──────────────────────────────────────────────────────────── */

function startOfToday(): number {
	const date = new Date();
	date.setHours(0, 0, 0, 0);
	return date.getTime();
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

/** 一行「10-27 10:00 · 他自己记的」。没有日志时返回 undefined，界面就只写标题。 */
function stampOf(entry: MemoryEntry): string | undefined {
	if (entry.at === null) return undefined;
	const at = Date.parse(entry.at);
	if (Number.isNaN(at)) return undefined;
	const who = entry.by === "human" ? "我" : entry.by === "remember" ? "他自己记的" : "他记的";
	return `${dayLabel(at)} ${clockTime(at)} · ${who}`;
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

/* ── 图标 ────────────────────────────────────────────────────────────── */

const ICON = {
	width: 16,
	height: 16,
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.6,
	strokeLinecap: "round",
	strokeLinejoin: "round",
} as const;

function IconCpu(): JSX.Element {
	return (
		<svg {...ICON}>
			<rect x="7.5" y="7.5" width="9" height="9" rx="2" />
			<path d="M10 4.2v3.3M14 4.2v3.3M10 16.5v3.3M14 16.5v3.3M4.2 10h3.3M4.2 14h3.3M16.5 10h3.3M16.5 14h3.3" />
		</svg>
	);
}

function IconDoc(): JSX.Element {
	return (
		<svg {...ICON}>
			<path d="M6 4.5h7.5l4.5 4.5v10.5H6Z" />
			<path d="M13.5 4.5V9H18" />
			<path d="M9 12.5h6M9 15.5h4" />
		</svg>
	);
}

function IconBook(): JSX.Element {
	return (
		<svg {...ICON}>
			<path d="M7 4.5h10v15l-5-3.6-5 3.6Z" />
		</svg>
	);
}

function IconStar(): JSX.Element {
	return (
		<svg {...ICON}>
			<path d="M12 3.5 14.4 9l5.6.5-4.3 3.7 1.3 5.6L12 15.7 7 18.8l1.3-5.6L4 9.5 9.6 9Z" />
		</svg>
	);
}

function IconPulse(): JSX.Element {
	return (
		<svg {...ICON}>
			<path d="M3 12h3.4l2.4-6.2L12.6 18l2.3-6H21" />
		</svg>
	);
}

function IconPlug(): JSX.Element {
	return (
		<svg {...ICON}>
			<path d="M9 4.5v3M15 4.5v3M6 7.5h12v6a6 6 0 0 1-12 0Z" />
			<path d="M12 19.5v2" />
		</svg>
	);
}
