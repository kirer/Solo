/**
 * 一轮的轨迹：折叠一行，展开一棵步骤树。
 *
 * 这个组件**只画服务端给的 `ViewTurn`**：标题、耗时、退出码、摘要全是后端算好的，
 * 这里不猜、不补（AGENTS §2 第 6 条）。没有的字段就不出现 —— 没有 `ms` 就不写耗时，
 * 没有 `steps` 就先拉一次（折叠版本来就不带）。
 *
 * 默认规则：**还在跑的轮次展开，历史轮次收起**。手动改过就记在 localStorage 里，
 * 下次打开还是你上次的样子；键是 `<channelId>:<seq>:<slug>`。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Step, Turn } from "../api/types.ts";
import { loadTurn } from "../state/store.ts";
import { clockTime, copyText, humanDuration } from "../lib/format.ts";

const OPEN_KEY = "solo.trace.open";

function remembered(turn: Turn): boolean | undefined {
	try {
		const raw = localStorage.getItem(OPEN_KEY);
		if (raw === null) return undefined;
		const map = JSON.parse(raw) as Record<string, unknown>;
		const value = map[`${turn.channelId}:${String(turn.seq)}:${turn.slug}`];
		return typeof value === "boolean" ? value : undefined;
	} catch {
		return undefined;
	}
}

function remember(turn: Turn, open: boolean): void {
	try {
		const raw = localStorage.getItem(OPEN_KEY);
		const map = raw === null ? {} : (JSON.parse(raw) as Record<string, boolean>);
		map[`${turn.channelId}:${String(turn.seq)}:${turn.slug}`] = open;
		localStorage.setItem(OPEN_KEY, JSON.stringify(map));
	} catch {
		// 存不下就算了：展开状态不是数据，丢了不影响读。
	}
}

/**
 * 一轮的折叠行 + 展开后的步骤树。
 *
 * 折叠行是**两行**：第一行是这个人（名字 + 身份 + 时间），第二行才是这一轮干了什么
 * （步数 / 状态 / 摘要）。一行塞不下两件事 —— 挤在一行时头像只有 24、名字和「13 步」
 * 同高，整块读起来像一条日志，不像「林越做了一轮」。
 */
export function RunBlock(props: { turn: Turn; role: string; grouped?: boolean }): JSX.Element {
	const { turn, role } = props;
	const [open, setOpen] = useState(() => remembered(turn) ?? turn.status === "running");
	const [stepId, setStepId] = useState<string | null>(null);

	// 默认就展开（还在跑的那一轮）时没人点过折叠行，步骤要在这里补拉一次。
	// 拉的时候 turn 还是折叠版，store 一 patch 就会换一个新对象 —— 用 ref 记住拉过谁。
	const asked = useRef<string | null>(null);
	useEffect(() => {
		if (!open || turn.steps !== undefined) return;
		const key = `${turn.channelId}:${String(turn.seq)}:${turn.slug}`;
		if (asked.current === key) return;
		asked.current = key;
		void loadTurn(turn);
	}, [open, turn]);

	const toggle = useCallback(() => {
		setOpen((current) => {
			const next = !current;
			remember(turn, next);
			if (next) void loadTurn(turn);
			return next;
		});
	}, [turn]);

	const elapsed = turn.status === "running" ? undefined : turn.endedAt === undefined ? undefined : turn.endedAt - turn.startedAt;
	const status = useMemo(() => statusOf(turn), [turn]);

	return (
		<div className="run" data-status={turn.status} data-open={open ? "true" : "false"}>
			{/* 头一行是这个人，不是按钮：名字和头像不该顺手把轨迹折叠掉。 */}
			{props.grouped === true ? null : (
				<div className="run-top">
					<span className="run-name">{turn.label}</span>
					{role === "" ? null : <span className="run-role">{role}</span>}
					<span className="run-time">{clockTime(turn.startedAt)}</span>
				</div>
			)}

			{/* 气泡里才是「这一轮」。点它展开 —— 热区只有这一行，不含上面的头像和名字。 */}
			<div className="run-bubble">
				<button
					type="button"
					className="run-head"
					aria-expanded={open}
					onClick={toggle}
					onDoubleClick={() => void copyText(`${turn.label} · ${turn.summary}`)}
				>
					<span className="run-bar">
						<span className="run-caret" aria-hidden="true">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M9 5l7 7-7 7" />
						</svg>
					</span>
						<span className="run-meta">{turn.stepCount} 步</span>
						{elapsed === undefined || elapsed <= 0 ? null : <span className="run-meta">{humanDuration(elapsed)}</span>}
						<span className="run-status" data-tone={status.tone}>
							{status.text}
						</span>
						<span className="run-grow" />
						<span className="run-summary">{turn.summary}</span>
					</span>
				</button>

				{open ? (
					<div className="run-body">
						{turn.steps === undefined ? (
							<div className="run-empty">正在读这一轮的过程…</div>
						) : turn.steps.length === 0 ? (
							<div className="run-empty">这一轮没有留下过程（条目可能已被压缩）。</div>
						) : (
							<div className="run-steps">
								{turn.steps.map((step) => (
									<StepRow
										key={step.id}
										step={step}
										open={stepId === step.id}
										onToggle={() => setStepId((current) => (current === step.id ? null : step.id))}
									/>
								))}
							</div>
						)}
						{turn.truncated === true ? <div className="run-empty">步骤太多，只保留前 200 步。</div> : null}
					</div>
				) : null}
			</div>
		</div>
	);
}

function statusOf(turn: Turn): { text: string; tone: "ok" | "bad" | "quiet" | "live" } {
	if (turn.status === "running") return { text: "正在执行", tone: "live" };
	if (turn.status === "done") return { text: "✓ 完成", tone: "ok" };
	if (turn.status === "failed") return { text: "✕ 失败", tone: "bad" };
	return { text: "没回话", tone: "quiet" };
}

/** 一行步骤。点开在下面展开详情，同一时间只展开一个（由父组件管）。 */
function StepRow(props: { step: Step; open: boolean; onToggle: () => void }): JSX.Element {
	const { step } = props;
	return (
		<div className="step" data-kind={step.kind} data-status={step.status} data-open={props.open ? "true" : "false"}>
			<button type="button" className="step-head" aria-expanded={props.open} onClick={props.onToggle}>
				<span className="step-ico" aria-hidden="true">
					{iconOf(step.kind)}
				</span>
				<span className="step-title">{step.title}</span>
				<span className="step-grow" />
				{step.kind === "file-write" && step.added !== undefined ? (
					<span className="step-added">+{step.added}</span>
				) : null}
				{step.status === "running" ? (
					<span className="step-live" aria-hidden="true">
						…
					</span>
				) : step.ms === undefined ? null : (
					<span className="step-ms">{step.status === "failed" ? "✕" : "✓"} {humanDuration(step.ms)}</span>
				)}
			</button>
			{props.open ? <StepDetail step={step} /> : null}
		</div>
	);
}

function StepDetail(props: { step: Step }): JSX.Element | null {
	const { step } = props;
	if (step.kind === "run") {
		return (
			<div className="step-detail">
				<div className="step-cmd">
					<span className="step-prompt">$</span>
					{step.command ?? ""}
				</div>
				<div className="step-sub">
					{step.ms === undefined ? null : <span>{humanDuration(step.ms)}</span>}
					{step.exitCode === undefined ? null : (
						<span data-tone={step.exitCode === 0 ? "ok" : "bad"}>退出码 {step.exitCode}</span>
					)}
				</div>
				{step.output === undefined || step.output === "" ? null : <pre className="step-out">{step.output}</pre>}
			</div>
		);
	}
	if (step.kind === "file-read" || step.kind === "file-write") {
		return (
			<div className="step-detail">
				<div className="step-sub">
					<span className="step-path">{step.path ?? ""}</span>
					{step.kind === "file-write" && step.added !== undefined ? <span>{step.added} 行</span> : null}
				</div>
				{step.output === undefined || step.output === "" ? null : <pre className="step-out">{step.output}</pre>}
			</div>
		);
	}
	if (step.kind === "think") {
		if (step.text === undefined || step.text === "") return null;
		return (
			<div className="step-detail">
				<div className="step-text">{step.text}</div>
			</div>
		);
	}
	if (step.output !== undefined && step.output !== "") {
		return (
			<div className="step-detail">
				<pre className="step-out">{step.output}</pre>
			</div>
		);
	}
	return null;
}

/** 图标只有三种：思考一个点、终端 `>_`、文件一页；其余工具画一个问号。全部 `--ink-2` 描边。 */
function iconOf(kind: Step["kind"]): JSX.Element {
	if (kind === "think") return <span className="ico-dot" />;
	if (kind === "run") {
		return (
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
				<path d="M5 7l4 4-4 4" />
				<path d="M12 17h6" />
			</svg>
		);
	}
	if (kind === "file-read" || kind === "file-write") {
		return (
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
				<path d="M6 3h8l4 4v14H6z" />
				<path d="M14 3v4h4" />
			</svg>
		);
	}
	return (
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
			<rect x="4" y="4" width="16" height="16" rx="3" />
			<path d="M9.5 9.5a2.5 2.5 0 1 1 3 2.4v1.6" />
			<path d="M12 17h.01" />
		</svg>
	);
}
