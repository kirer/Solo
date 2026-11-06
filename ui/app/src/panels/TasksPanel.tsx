/**
 * 后台任务：一个人的轮次清单，点一条就地展开步骤（docs/DESIGN.md §2.3 / §13.3）。
 *
 * 桌面上它是右栏的一态（资料表最后一行点进来）；手机上右栏铺满整屏，所以这里是
 * **同一列**：列表在上、展开在行里，不是并排两栏。两端逐项相同。
 *
 * 数据全是服务端给的：列表是 `state.runs`（按人分桶，SSE 的 `trace` 帧实时并进去，
 * 打开时再拉一次最近 30 轮），展开那一轮的 `ViewTurn` 步骤缺了就按
 * `channelId + seq` 补拉一次，不猜、不补（AGENTS §2 第 6 条）。
 */

import { useEffect, useState } from "react";
import type { Actor, Step, Turn } from "../api/types.ts";
import { continuePerson } from "../api/client.ts";
import { avatarSvg } from "../lib/avatar.ts";
import { clockTime, humanDuration, relTime } from "../lib/format.ts";
import { loadPersonRuns, loadTurn, refreshLists } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";

const REFRESH_MS = 2000;

export function TasksView(): JSX.Element {
	const who = useStore((state) => state.tasks.who);
	const runs = useStore((state) => state.runs);
	const people = useStore((state) => state.people);
	const presence = useStore((state) => state.presence);
	const channels = useStore((state) => state.channels);
	const [pick, setPick] = useState<string | null>(null);
	const [openStep, setOpenStep] = useState<string | null>(null);

	const live = who !== null && isRunning(presence.get(who)?.state);

	// 看的那个人还在跑：列表会变（新的一轮、步数、结算），每 2 秒补一次；停下来就不拉。
	useEffect(() => {
		if (who === null || !live) return;
		const id = setInterval(() => void loadPersonRuns(who), REFRESH_MS);
		return () => clearInterval(id);
	}, [who, live]);

	const titles = new Map(channels.map((channel) => [channel.id, channel.title]));
	const actor = who === null ? undefined : people.find((person) => person.slug === who);
	const failure = actor?.lastFailure;

	// 0 步的一轮不占一行：只说了句话、没动过手（包括没回话的），那是聊天不是任务；
	// 还在跑的先留着（步数随后才到）。
	const mine =
		who === null
			? []
			: [...(runs.get(who) ?? [])]
					.filter((turn) => turn.status === "running" || turn.stepCount > 0)
					.sort((left, right) => right.startedAt - left.startedAt);

	const open = mine.find((turn) => keyOf(turn) === pick) ?? null;

	useEffect(() => {
		if (open !== null && open.steps === undefined) void loadTurn(open);
	}, [open]);

	const groups = groupByDay(mine);

	return (
		<div className="tasks">
			{who === null ? null : (
				<div className="tasks-who">
					<span
						className="tasks-av"
						aria-hidden="true"
						dangerouslySetInnerHTML={{
							__html: avatarSvg({
								slug: who,
								name: actor?.label ?? who,
								size: 28,
								state: live ? "working" : "idle",
								assistant: actor?.assistant === true,
							}),
						}}
					/>
					<span className="tasks-who-main">
						<span className="tasks-who-name">{actor?.label ?? who}</span>
						<span className="tasks-who-meta">{runsLine(mine, live)}</span>
					</span>
					<span className="tasks-who-n">{mine.length} 轮</span>
				</div>
			)}

			{failure === undefined || who === null || live ? null : (
				<FailureCard slug={who} failure={failure} />
			)}

			<div className="tasks-rows">
				{mine.length === 0 ? (
					<p className="tasks-empty">{who === null ? "挑一个人看他跑过什么。" : "这个人还没有跑过任何一轮。"}</p>
				) : (
					groups.map((group) => (
						<div key={group.label}>
							<div className="tasks-day">
								{group.label}
								<span className="n">{group.list.length} 轮</span>
							</div>
							{group.list.map((turn) => {
								const isOpen = open !== null && keyOf(open) === keyOf(turn);
								return (
									<div className="tasks-item" key={keyOf(turn)} data-open={isOpen ? "true" : "false"}>
										<button
											type="button"
											className="tasks-row"
											data-live={turn.status === "running" ? "true" : "false"}
											data-fail={turn.status === "failed" ? "true" : "false"}
											data-on={isOpen ? "true" : "false"}
											aria-expanded={isOpen}
											onClick={() => {
												setPick(isOpen ? null : keyOf(turn));
												setOpenStep(null);
											}}
										>
											<span className="tasks-main">
												<span className="tasks-top">
													<span className="tasks-ch">
														{titles.get(turn.channelId) ?? turn.channelTitle ?? turn.channelId}
													</span>
													<span className="tasks-time">{clockTime(turn.startedAt)}</span>
													{turn.status === "running" ? (
														<span className="tasks-live">
															<span className="pulse" aria-hidden="true" />
															正在跑
														</span>
													) : null}
													<span className="tasks-ms">
														{turn.status === "running" ? `${String(turn.stepCount)} 步` : statusOf(turn)}
													</span>
												</span>
												<span className="tasks-text">{turn.trigger?.text ?? turn.summary}</span>
											</span>
											<svg className="tasks-chev" width="8" height="13" viewBox="0 0 8 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
												<path d="m1.5 1.5 5 5-5 5" />
											</svg>
										</button>
										{isOpen ? (
											<div className="tasks-open">
												{turn.trigger === undefined ? null : (
													<span className="tasks-quote">
														<span
															className="tasks-quote-av"
															aria-hidden="true"
															dangerouslySetInnerHTML={{
																__html: avatarSvg({
																	slug: turn.trigger.from,
																	name: turn.trigger.from === "owner" ? "我" : (people.find((person) => person.slug === turn.trigger?.from)?.label ?? turn.trigger.from),
																	size: 20,
																}),
															}}
														/>
														<span className="tasks-quote-body">
															<span className="tasks-quote-who">
																叫醒他的那句话 · {turn.trigger.from === "owner" ? "我" : (people.find((person) => person.slug === turn.trigger?.from)?.label ?? turn.trigger.from)}{" "}
																{clockTime(turn.startedAt)}
															</span>
															<span className="tasks-quote-text">{turn.trigger.text}</span>
														</span>
													</span>
												)}
												<p className="tasks-label">
													过程 · {turn.stepCount} 步{elapsedOf(turn) === "" ? "" : ` · ${elapsedOf(turn)}`}
												</p>
												{turn.steps === undefined ? null : turn.steps.length === 0 ? (
													<p className="tasks-empty">{turn.status === "running" ? "还没动手，正在想。" : "这一轮没有留下过程（条目可能已被压缩）。"}</p>
												) : (
													<div className="tasks-steps">
														{turn.steps.map((step) => (
															<StepRow
																key={step.id}
																step={step}
																open={openStep === step.id}
																onToggle={() => setOpenStep((now) => (now === step.id ? null : step.id))}
															/>
														))}
													</div>
												)}
												{turn.truncated === true ? <p className="tasks-empty">步骤太多，只保留前 200 步。</p> : null}
												<p className="tasks-foot" data-fail={turn.status === "failed" ? "true" : "false"}>
													<span className="ok" aria-hidden="true">
														●
													</span>
													{footOf(turn)}
												</p>
											</div>
										) : null}
									</div>
								);
							})}
						</div>
					))
				)}
			</div>
		</div>
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
		<div
			className="task-step"
			data-open={props.open ? "true" : "false"}
			data-fail={step.status === "failed" ? "true" : "false"}
		>
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
					<span className="task-step-at">{step.startedAt === undefined ? "" : clockTime(step.startedAt)}</span>
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
		return (
			<div className="task-cmd">
				<span className="task-cmd-out">{step.text}</span>
			</div>
		);
	}
	// 其余工具（记记忆 / 翻记录 / 读历史 / 招人 / 未知）：能展开就展开，优先给人看的正文，其次回执。
	const body = step.text ?? step.output;
	if (body === undefined || body === "") return null;
	return (
		<div className="task-cmd">
			<span className="task-cmd-out">{body}</span>
		</div>
	);
}

/** 按天分组：今天 / 昨天 / 更早。一轮都不画日期（「今天」是这一栏的默认分组）。 */
function groupByDay(turns: readonly Turn[]): { label: string; list: Turn[] }[] {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const start = today.getTime();
	const yesterday = start - 86_400_000;
	const buckets: { label: string; keep: (turn: Turn) => boolean }[] = [
		{ label: "今天", keep: (turn) => turn.startedAt >= start },
		{ label: "昨天", keep: (turn) => turn.startedAt >= yesterday && turn.startedAt < start },
		{ label: "更早", keep: (turn) => turn.startedAt < yesterday },
	];
	return buckets
		.map((bucket) => ({ label: bucket.label, list: turns.filter(bucket.keep) }))
		.filter((group) => group.list.length > 0);
}

function runsLine(turns: readonly Turn[], live: boolean): string {
	// 一轮都没有时别写「0 轮 · 共 0s」：那不是统计，是一句空话。
	if (turns.length === 0) return live ? "正在跑" : "还没跑过";
	const total = turns.reduce((sum, turn) => sum + (turn.endedAt === undefined ? 0 : turn.endedAt - turn.startedAt), 0);
	const last = turns[0]?.startedAt;
	const parts = [
		live ? "正在跑" : `${String(turns.length)} 轮`,
		`共 ${humanDuration(total)}`,
		last === undefined ? undefined : `最近 ${relTime(last)}`,
	];
	return parts.filter((part) => part !== undefined).join(" · ");
}

function keyOf(turn: Turn): string {
	return `${turn.channelId}:${String(turn.seq)}`;
}

function elapsedOf(turn: Turn): string {
	if (turn.endedAt === undefined) return "";
	return humanDuration(turn.endedAt - turn.startedAt);
}

function statusOf(turn: Turn): string {
	if (turn.status === "running") return "跑着";
	if (turn.status === "done") return elapsedOf(turn);
	if (turn.status === "failed") return "失败";
	// `aborted` 是合并唤醒（ADR-048）：后来的消息接管了这一轮，不是他赖着不回。
	return "被新消息合并";
}

/** 展开的最后一行：这一轮怎么收的（稿子 07 的 tfoot）。 */
function footOf(turn: Turn): string {
	if (turn.status === "running") return "还在跑";
	if (turn.status === "aborted") return "被新消息合并，这一轮没跑完";
	const at = turn.endedAt === undefined ? "" : ` · ${clockTime(turn.endedAt)}`;
	return turn.status === "failed" ? `没答上来${at}` : `已交付${at}`;
}

function isRunning(state: string | undefined): boolean {
	return state === "working" || state === "thinking";
}
