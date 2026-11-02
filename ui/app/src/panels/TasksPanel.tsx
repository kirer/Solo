/**
 * 后台任务：一个成员跑过的每一轮，从右侧盖在聊天上滑出（ADR-046）。
 *
 * 这里只画服务端给的 `ViewTurn`：块头是「哪句话触发的」（`trigger`），下一行是
 * 步数 / 耗时 / 状态 / 摘要，展开是步骤树 —— 复用 `RunBlock`，不造第二套展示。
 *
 * 数据来自 `state.runs`（按人分桶）：SSE 的 `trace` 帧实时并进去，打开时再拉一次最近
 * 30 轮。看的那个人还在跑时每 2 秒补一次（只在面板开着时发生）。
 */
import { useEffect } from "react";
import type { Turn } from "../api/types.ts";
import { avatarSvg } from "../lib/avatar.ts";
import { clockTime, relTime } from "../lib/format.ts";
import { RunBlock } from "../stream/RunBlock.tsx";
import { closeTasks, loadPersonRuns, setTasksWho } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";

const REFRESH_MS = 2000;

export function TasksPanel(): JSX.Element | null {
	const open = useStore((state) => state.tasks.open);
	const who = useStore((state) => state.tasks.who);
	const runs = useStore((state) => state.runs);
	const people = useStore((state) => state.people);
	const presence = useStore((state) => state.presence);
	const channels = useStore((state) => state.channels);

	const live = who !== null && isRunning(presence.get(who)?.state);

	// 看的那个人还在跑：列表会变（新的一轮、步数、结算），每 2 秒补一次；停下来就不拉。
	useEffect(() => {
		if (!open || who === null || !live) return;
		const id = setInterval(() => void loadPersonRuns(who), REFRESH_MS);
		return () => clearInterval(id);
	}, [open, who, live]);

	if (!open) return null;

	const titles = new Map(channels.map((channel) => [channel.id, channel.title]));
	const pool = people
		.filter((actor) => actor.slug !== "owner")
		.map((actor) => ({ slug: actor.slug, label: actor.label, title: actor.title }))
		.sort((left, right) => rank(left.slug) - rank(right.slug) || left.label.localeCompare(right.label));

	// 正在跑的排前面，其余按最近一轮倒序；一轮都没跑过的垫底。
	function rank(slug: string): number {
		const running = isRunning(presence.get(slug)?.state);
		const list = runs.get(slug);
		const last = list === undefined ? 0 : (list[list.length - 1]?.startedAt ?? 0);
		return (running ? 0 : 1) * 1e15 - last;
	}

	const mine = who === null ? [] : [...(runs.get(who) ?? [])].sort((left, right) => right.startedAt - left.startedAt);
	const runningCount = pool.filter((person) => isRunning(presence.get(person.slug)?.state)).length;

	return (
		<>
			<button type="button" className="tasks-scrim" aria-label="关闭后台任务" onClick={closeTasks} />
			<aside className="tasks-panel" aria-label="后台任务">
				<header className="tasks-head">
					<h2>后台任务</h2>
					{runningCount === 0 ? (
						<span className="tasks-count">没有人在跑</span>
					) : (
						<span className="tasks-count" data-live="true">
							{runningCount} 个在跑
						</span>
					)}
					<button type="button" className="icon-btn" aria-label="关闭" onClick={closeTasks}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
							<path d="M6 6l12 12M18 6L6 18" />
						</svg>
					</button>
				</header>

				<div className="tasks-people">
					{pool.map((person) => (
						<button
							type="button"
							key={person.slug}
							className="tasks-person"
							data-active={person.slug === who ? "true" : "false"}
							data-live={isRunning(presence.get(person.slug)?.state) ? "true" : "false"}
							title={person.label}
							onClick={() => setTasksWho(person.slug)}
						>
							<span
								aria-hidden="true"
								dangerouslySetInnerHTML={{
									__html: avatarSvg({
										slug: person.slug,
										name: person.label,
										size: 32,
										state: isRunning(presence.get(person.slug)?.state) ? "working" : "idle",
									}),
								}}
							/>
							<span className="tasks-name">{person.label}</span>
						</button>
					))}
				</div>

				<div className="tasks-list">
					{mine.length === 0 ? (
						<div className="tasks-empty">
							{who === null ? "挑一个人看他跑过什么。" : "这个人还没有跑过任何一轮。"}
						</div>
					) : (
						mine.map((turn) => <RunGroup key={`${turn.channelId}:${String(turn.seq)}`} turn={turn} title={titles.get(turn.channelId) ?? turn.channelId} />)
					)}
				</div>
			</aside>
		</>
	);
}

/** 一块 = 一轮：哪句话、在哪个频道、什么时候，然后是这一轮本身。 */
function RunGroup(props: { turn: Turn; title: string }): JSX.Element {
	const { turn, title } = props;
	return (
		<section className="tasks-run" data-status={turn.status}>
			<div className="tasks-where">
				<span className="tasks-channel">{title}</span>
				<span className="tasks-when">{relTime(turn.startedAt)}</span>
				<span className="tasks-when">{clockTime(turn.startedAt)}</span>
			</div>
			{turn.trigger === undefined ? null : <p className="tasks-trigger">{turn.trigger.text}</p>}
			<RunBlock turn={turn} role="" grouped />
		</section>
	);
}

function isRunning(state: string | undefined): boolean {
	return state === "working" || state === "thinking";
}
