/**
 * 任务看板（2.9.20）：顶上一条计数，点开是抽屉，一条一行；点一行跳回起源消息。
 *
 * 形状是老板 2026-11-14 定的那三处，一条不多：
 *   顶上一行「在做 N 条 · 卡住 M 条」—— 收起来的时候它就是全部信息；
 *   抽屉里一条一行：谁、做什么、多久没动，卡住的标红并把原因写在下面；
 *   点一行回起源那条消息（`channelId + originSeq`，界面不复制正文）。
 * 做完的折成「今天完成 K 条」一行，**板上只剩活的**。
 *
 * 数据由外面传进来（`task-board-source.ts` 从频道详情里翻），这个文件只管画：
 * 换数据源不碰它。2.9.20 之前喂它的是 `task-board-demo.ts` 那份假的，已经拆了。
 */

import { useEffect, useState } from "react";
import { avatarSvg } from "../lib/avatar.ts";
import {
	blockedReason,
	boardOf,
	doneLine,
	doneProof,
	idleLabel,
	topLine,
	type BoardTask,
} from "./task-board-model.ts";

/** 「多久没动」自己会走：不按时重算，开着十分钟它还写「刚动过」。 */
const TICK_MS = 30_000;

export function TaskBoard(props: {
	tasks: readonly BoardTask[];
	onJump: (task: BoardTask) => void;
	/**
	 * 上一次跳转**没找着**的那条起源 seq（那条比本机存到的历史还早）。
	 *
	 * 命中时把那行的「点开回到原话」换成一句灰字 —— 点了没反应是最糟的，
	 * 宁可说一句「没存到」（Solo 2026-11-15）。
	 */
	missSeq?: number | null;
}): JSX.Element {
	const [now, setNow] = useState(() => Date.now());
	// 默认展开：收着的那一行只有数，老板要的是「现在谁在做什么」，进来就该看见。
	const [open, setOpen] = useState(true);
	const [doneOpen, setDoneOpen] = useState(false);

	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => clearInterval(id);
	}, []);

	const board = boardOf(props.tasks, now);
	const done = doneLine(board);

	return (
		<div className="board">
			<button
				type="button"
				className="board-top"
				aria-expanded={open}
				aria-label={open ? "收起任务板" : "展开任务板"}
				onClick={() => setOpen((wasOpen) => !wasOpen)}
			>
				<span className="board-count" data-blocked={board.blocked > 0 ? "true" : "false"}>
					{topLine(board)}
				</span>
				<svg className="board-chev" width="9" height="14" viewBox="0 0 8 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
					<path d="m1.5 1.5 5 5-5 5" />
				</svg>
			</button>

			{open ? (
				<div className="board-drawer">
					{board.live.length === 0 ? (
						<p className="board-blank">{board.doneTodayCount === 0 ? "板上没有活。" : "活都干完了。"}</p>
					) : (
						board.live.map((task) => (
							<TaskRow
								key={task.id}
								task={task}
								now={now}
								onJump={props.onJump}
								miss={props.missSeq === task.originSeq}
							/>
						))
					)}

					{done === "" ? null : (
						<>
							<button
								type="button"
								className="board-done"
								aria-expanded={doneOpen}
								onClick={() => setDoneOpen((wasOpen) => !wasOpen)}
							>
								<span>{done}</span>
								<svg className="board-chev" width="9" height="14" viewBox="0 0 8 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
									<path d="m1.5 1.5 5 5-5 5" />
								</svg>
							</button>
							{doneOpen
								? board.doneToday.map((task) => (
										<DoneRow
											key={task.id}
											task={task}
											now={now}
											onJump={props.onJump}
											miss={props.missSeq === task.originSeq}
										/>
									))
								: null}
						</>
					)}
				</div>
			) : null}
		</div>
	);
}

/** 板上的一行：头像 + 名字 + 多久没动 / 做什么 / （卡住的原因）/ 哪来的。 */
function TaskRow(props: {
	task: BoardTask;
	now: number;
	onJump: (task: BoardTask) => void;
	miss?: boolean;
}): JSX.Element {
	const { task } = props;
	const blocked = task.status === "blocked";
	const idle = idleLabel(task, props.now);
	return (
		<button
			type="button"
			className="board-row"
			data-status={task.status}
			aria-label={`${task.ownerLabel}，${task.title}，${idle}${blocked ? `，卡住：${blockedReason(task)}` : ""}，点开回到原话`}
			onClick={() => props.onJump(task)}
		>
			<span
				className="board-av"
				aria-hidden="true"
				dangerouslySetInnerHTML={{
					__html: avatarSvg({
						slug: task.owner,
						name: task.ownerLabel,
						size: 26,
						state: task.status === "doing" ? "working" : "idle",
					}),
				}}
			/>
			<span className="board-main">
				<span className="board-line">
					<b className="board-who">{task.ownerLabel}</b>
					<span className="board-idle">{idle}</span>
				</span>
				<span className="board-title">{task.title}</span>
				{blocked ? <span className="board-why">{blockedReason(task)}</span> : null}
				<span className="board-origin" data-miss={props.miss === true ? "true" : "false"} role={props.miss === true ? "status" : undefined}>
					{props.miss === true ? "这条在更早的记录里，本机没存到" : `${task.channelTitle} · 点开回到原话`}
				</span>
			</span>
		</button>
	);
}

/** 完成项：折在「今天完成 K 条」后面，带凭据 —— 凭什么算完了，一眼看得到。 */
function DoneRow(props: {
	task: BoardTask;
	now: number;
	onJump: (task: BoardTask) => void;
	miss?: boolean;
}): JSX.Element {
	const { task } = props;
	return (
		<button
			type="button"
			className="board-row"
			data-status="done"
			aria-label={`${task.ownerLabel} 做完：${task.title}，${doneProof(task)}`}
			onClick={() => props.onJump(task)}
		>
			<span className="board-tick" aria-hidden="true">
				✓
			</span>
			<span className="board-main">
				<span className="board-line">
					<b className="board-who">{task.ownerLabel}</b>
					<span className="board-idle">{idleLabel(task, props.now)}做完</span>
				</span>
				<span className="board-title">{task.title}</span>
				<span className="board-why" data-done="true">
					{doneProof(task)}
				</span>
			</span>
		</button>
	);
}
