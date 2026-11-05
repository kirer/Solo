/**
 * 后台任务：一屏三处 —— 左栏是导航（在 `sidebar/Rail.tsx`），这里给中间的人 / 轮次
 * 和一整块「这一轮」。不再是盖在聊天上的抽屉：一轮的过程要摊开写，380px 装不下。
 *
 * 数据全是服务端给的：列表是 `state.runs`（按人分桶，SSE 的 `trace` 帧实时并进去，
 * 打开时再拉一次最近 30 轮），右边是选中那一轮的 `ViewTurn` —— 步骤缺了就按
 * `channelId + seq` 补拉一次，不猜、不补（AGENTS §2 第 6 条）。
 */

import { useEffect, useState } from "react";
import type { Actor, Step, Turn } from "../api/types.ts";
import { continuePerson } from "../api/client.ts";
import { avatarSvg } from "../lib/avatar.ts";
import { clockTime, humanDuration, relTime } from "../lib/format.ts";
import { closeTasks, loadPersonRuns, loadTurn, refreshLists, setTasksWho } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";

const REFRESH_MS = 2000;

const GROUPS: { label: string; keep: (turn: Turn) => boolean }[] = [
	{ label: "正在跑", keep: (turn) => turn.status === "running" },
	{ label: "已完成", keep: (turn) => turn.status === "done" },
	{ label: "失败", keep: (turn) => turn.status === "failed" },
	{ label: "没回话", keep: (turn) => turn.status === "aborted" },
];

export function TasksPanel(): JSX.Element {
	const open = useStore((state) => state.tasks.open);
	const who = useStore((state) => state.tasks.who);
	const runs = useStore((state) => state.runs);
	const people = useStore((state) => state.people);
	const presence = useStore((state) => state.presence);
	const channels = useStore((state) => state.channels);
	const [pick, setPick] = useState<string | null>(null);
	const [openStep, setOpenStep] = useState<string | null>(null);
	/** 哪一组被收起来了（默认全展开：第一眼要看的是「都跑过什么」）。 */
	const [folded, setFolded] = useState<Record<string, boolean>>({});

	const live = who !== null && isRunning(presence.get(who)?.state);

	// 看的那个人还在跑：列表会变（新的一轮、步数、结算），每 2 秒补一次；停下来就不拉。
	useEffect(() => {
		if (!open || who === null || !live) return;
		const id = setInterval(() => void loadPersonRuns(who), REFRESH_MS);
		return () => clearInterval(id);
	}, [open, who, live]);

	const titles = new Map(channels.map((channel) => [channel.id, channel.title]));
	const names = new Map(people.map((actor) => [actor.slug, actor.label]));
	const failures = new Map(people.map((actor) => [actor.slug, actor.lastFailure]));
	const failure = who === null ? undefined : failures.get(who);
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

	// 0 步的一轮不占一块：只说了句话、没动过手，那是聊天不是任务；还在跑的先留着（步数随后才到）。
	const mine =
		who === null
			? []
			: [...(runs.get(who) ?? [])]
					.filter((turn) => turn.status === "running" || turn.stepCount > 0)
					.sort((left, right) => right.startedAt - left.startedAt);

	// 选中哪一轮：默认最近的一轮；列表变了（新的一轮进来）就跟着走到最新那轮。
	const current = mine.find((turn) => keyOf(turn) === pick) ?? mine[0] ?? null;

	useEffect(() => {
		if (current !== null && current.steps === undefined) void loadTurn(current);
	}, [current]);

	const runningCount = pool.filter((person) => isRunning(presence.get(person.slug)?.state)).length;

	if (!open) return <></>;

	return (
		<section className="tasks" aria-label="后台任务">
			<div className="tasks-list">
				<header className="tasks-list-head">
					<button type="button" className="tasks-back" id="tasks-back" aria-label="回到聊天" onClick={closeTasks}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
							<path d="M15 6l-6 6 6 6" />
						</svg>
					</button>
					<h2>后台任务</h2>
				</header>

				<div className="tasks-people">
					{pool.map((person) => (
						<button
							type="button"
							key={person.slug}
							className="tasks-person"
							aria-current={person.slug === who ? "true" : "false"}
							data-live={isRunning(presence.get(person.slug)?.state) ? "true" : "false"}
							title={person.label}
							onClick={() => {
								setPick(null);
								setTasksWho(person.slug);
							}}
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
							{failures.get(person.slug) !== undefined && !isRunning(presence.get(person.slug)?.state) ? (
								<span className="tasks-person-bad" aria-hidden="true" />
							) : null}
							<span>{person.label}</span>
						</button>
					))}
				</div>

				<div className="tasks-rows">
					{mine.length === 0 ? (
						<p className="tasks-empty">
							{who === null ? "挑一个人看他跑过什么。" : "这个人还没有跑过任何一轮。"}
						</p>
					) : (
						GROUPS.map((group) => {
							const list = mine.filter(group.keep);
							if (list.length === 0) return null;
							const shut = folded[group.label] === true;
							return (
								<div key={group.label}>
									{/* 组头可以点：十三轮全摊开，一屏只装得下四轮。 */}
									<button
										type="button"
										className="tasks-group"
										aria-expanded={shut ? "false" : "true"}
										onClick={() => setFolded((now) => ({ ...now, [group.label]: !shut }))}
									>
										<svg className="tasks-group-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
											<path d="M9 5l7 7-7 7" />
										</svg>
										{group.label}
										<span className="tasks-group-n">{list.length}</span>
									</button>
									{shut ? null : list.map((turn) => (
										<button
											type="button"
											key={keyOf(turn)}
											className="tasks-row"
											aria-selected={current !== null && keyOf(current) === keyOf(turn) ? "true" : "false"}
											onClick={() => {
												setPick(keyOf(turn));
												setOpenStep(null);
											}}
										>
											<span className="tasks-row-top">
												<span className="tasks-row-ch">{titles.get(turn.channelId) ?? turn.channelTitle ?? turn.channelId}</span>
												<span className="tasks-row-time">{clockTime(turn.startedAt)}</span>
												<span className="tasks-row-ms">{elapsedOf(turn)}</span>
											</span>
											<span className="tasks-row-text">{turn.trigger?.text ?? turn.summary}</span>
										</button>
									))}
								</div>
							);
						})
					)}
				</div>

				{runningCount === 0 ? null : <p className="tasks-foot">{runningCount} 个人在跑</p>}
			</div>

			{current === null ? (
				<div className="task-detail task-detail-blank">
					{failure === undefined || who === null ? (
						<p>左边挑一轮看他做了什么。</p>
					) : (
						<FailureCard slug={who} failure={failure} />
					)}
				</div>
			) : (
				<div className="task-detail">
					<header className="task-detail-head">
						<span
							className="task-av"
							aria-hidden="true"
							dangerouslySetInnerHTML={{
								__html: avatarSvg({ slug: current.slug, name: current.label, size: 52, state: "idle" }),
							}}
						/>
						<span className="task-name">{current.label}</span>
						<span className="task-role">{people.find((person) => person.slug === current.slug)?.title ?? ""}</span>
						<span className="task-sep" />
						<span className="task-ch">{titles.get(current.channelId) ?? current.channelTitle ?? current.channelId}</span>
						<span className="task-meta">
							<span>{current.stepCount} 步</span>
							<span data-tone={toneOf(current)}>{statusOf(current)}</span>
							<span>{elapsedOf(current)}</span>
						</span>
					</header>

					{failure === undefined || who === null ? null : <FailureCard slug={who} failure={failure} />}

					<div className="task-body">
						{current.trigger === undefined ? null : (
							<>
								<p className="task-label">触发的那句话</p>
								<blockquote className="task-quote">
									<span className="task-quote-from">
										{names.get(current.trigger.from) ?? current.trigger.from} · {relTime(current.startedAt)}
									</span>
									<span className="task-quote-text">{current.trigger.text}</span>
								</blockquote>
							</>
						)}

						<p className="task-label task-label-2">这一轮做了什么</p>
						{current.steps === undefined ? null : current.steps.length === 0 ? (
							<p className="task-empty">
								{current.status === "running" ? "还没动手，正在想。" : "这一轮没有留下过程（条目可能已被压缩）。"}
							</p>
						) : (
							<div className="task-steps">
								{current.steps.map((step) => (
									<StepRow
										key={step.id}
										step={step}
										open={openStep === step.id}
										onToggle={() => setOpenStep((now) => (now === step.id ? null : step.id))}
									/>
								))}
							</div>
						)}
						{current.truncated === true ? <p className="task-empty">步骤太多，只保留前 200 步。</p> : null}
					</div>
				</div>
			)}
		</section>
	);
}

/**
 * 最近一轮没答上来。系统留痕不进聊天流（ADR-047），失败要在这里被看见：
 * reason 由服务端按文案目录翻好人话，detail 是底座给的原文。
 *
 * 「继续」走 1.5.0 的 `continue`：不新增一条用户消息，直接在当前上下文上再跑一轮。
 * `no_model`（没配模型）与 `nothing_to_answer`（没东西可答）不给按钮 —— 按了也不会变。
 */
function FailureCard(props: { slug: string; failure: NonNullable<Actor["lastFailure"]> }): JSX.Element {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const retryable = props.failure.reason !== "no_model" && props.failure.reason !== "nothing_to_answer";

	async function resume(): Promise<void> {
		setPending(true);
		setError(null);
		try {
			await continuePerson(props.slug);
			await Promise.all([refreshLists(), loadPersonRuns(props.slug)]);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="task-failure" role="status">
			<span className="task-failure-k">最近一轮没答上来</span>
			<p className="task-failure-text">{props.failure.text}</p>
			{props.failure.detail === undefined ? null : <p className="task-failure-detail">{props.failure.detail}</p>}
			{retryable ? (
				<div className="task-failure-actions">
					<button type="button" className="task-failure-go" disabled={pending} onClick={() => void resume()}>
						{pending ? "正在继续…" : "继续这一轮"}
					</button>
					{error === null ? null : <span className="task-failure-error">{error}</span>}
				</div>
			) : null}
		</div>
	);
}

/** 一行步骤：时刻、类型、命令（单行截断）、耗时；点开是命令和它吐出来的东西。 */
function StepRow(props: { step: Step; open: boolean; onToggle: () => void }): JSX.Element {
	const { step } = props;
	const detail = detailOf(step);
	return (
		<div className="task-step" data-open={props.open ? "true" : "false"}>
			<span className="task-step-at">{step.startedAt === undefined ? "" : clockTime(step.startedAt)}</span>
			<span className="task-step-rail" aria-hidden="true">
				<span className="task-step-dot" />
			</span>
			<div className="task-step-body">
				<button
					type="button"
					className="task-step-line"
					aria-expanded={props.open}
					disabled={detail === null}
					onClick={props.onToggle}
				>
					{/* `title` 已经是服务端算好的一行人话（「运行 npm test」/「读了 a.ts」），
					    这里不再拼类型，否则会变成「运行 运行 npm test」。 */}
					<span className="task-step-title">{step.title}</span>
					<span className="task-step-ms">
						{step.ms === undefined ? "" : `${step.status === "failed" ? "✕" : "✓"} ${humanDuration(step.ms)}`}
					</span>
				</button>
				{props.open && detail !== null ? detail : null}
			</div>
		</div>
	);
}

/** 命令块：`$ 命令` + 输出 + 退出码。别的类型没有机器输出就不展开。 */
function detailOf(step: Step): JSX.Element | null {
	if (step.kind === "run") {
		return (
			<div className="task-cmd">
				<span className="task-cmd-in">
					<em>$</em>
					{step.command ?? step.title}
				</span>
				{step.output === undefined || step.output === "" ? null : (
					<span className="task-cmd-out">{step.output}</span>
				)}
				<span className="task-cmd-foot">
					退出码 {step.exitCode ?? "—"}
					{step.ms === undefined ? "" : ` · ${humanDuration(step.ms)}`}
				</span>
			</div>
		);
	}
	if (step.kind === "file-read" || step.kind === "file-write") {
		if (step.path === undefined) return null;
		// 读：工具返回的文件正文；写：写进去的内容（没有旧文件，不画 diff）。
		const body = step.kind === "file-read" ? step.output : step.text;
		return (
			<div className="task-cmd">
				<span className="task-cmd-in">
					<em>{step.kind === "file-write" ? "✎" : "❯"}</em>
					{step.path}
					{step.kind === "file-write" && step.added !== undefined ? ` · +${String(step.added)} 行` : ""}
				</span>
				{body === undefined || body === "" ? null : <span className="task-cmd-out">{body}</span>}
			</div>
		);
	}
	if (step.kind === "think") {
		if (step.text === undefined || step.text === "") return null;
		return <div className="task-cmd">{<span className="task-cmd-out">{step.text}</span>}</div>;
	}
	// 其余工具（记记忆 / 翻记录 / 读历史 / 招人 / 未知）：能展开就展开，优先给人看的正文，其次回执。
	const body = step.text ?? step.output;
	if (body === undefined || body === "") return null;
	return <div className="task-cmd">{<span className="task-cmd-out">{body}</span>}</div>;
}

function keyOf(turn: Turn): string {
	return `${turn.channelId}:${String(turn.seq)}`;
}

function elapsedOf(turn: Turn): string {
	if (turn.endedAt === undefined) return "";
	return humanDuration(turn.endedAt - turn.startedAt);
}

function statusOf(turn: Turn): string {
	if (turn.status === "running") return "正在执行";
	if (turn.status === "done") return "✓ 完成";
	if (turn.status === "failed") return "✕ 失败";
	return "没回话";
}

function toneOf(turn: Turn): "ok" | "bad" | "quiet" | "live" {
	if (turn.status === "running") return "live";
	if (turn.status === "done") return "ok";
	if (turn.status === "failed") return "bad";
	return "quiet";
}

function isRunning(state: string | undefined): boolean {
	return state === "working" || state === "thinking";
}
