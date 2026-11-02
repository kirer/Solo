/**
 * 正在跑的那一轮：聊天流里唯一会出现的「过程」。
 *
 * 它不是消息 —— 不落库、刷新后不会出现，由这一轮的 `trace` 帧现算（ADR-046）。
 * 一行：谁、最新做到哪一步、几步、多久；点它进这个人的后台任务面板。
 *
 * 绝不编造他打算说什么（C-007 没有 token 流）：没有步骤时只写「在想…」。
 */
import { useEffect, useState } from "react";
import type { Turn } from "../api/types.ts";
import { avatarSvg } from "../lib/avatar.ts";
import { humanDuration } from "../lib/format.ts";
import { loadTurn } from "../state/store.ts";

export function LiveRow(props: {
	turn: Turn;
	role: string;
	onOpen: (slug: string) => void;
}): JSX.Element {
	const { turn, role, onOpen } = props;
	const [now, setNow] = useState(() => Date.now());

	// 耗时在走：服务端每秒补推一帧，但两帧之间也要动，否则像卡住了。
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	// 折叠帧不带步骤：先拉一次，才说得出「做到哪一步」。拉不到就只剩步数，不编。
	useEffect(() => {
		if (turn.steps === undefined) void loadTurn(turn);
	}, [turn.channelId, turn.seq, turn.slug]);

	const steps = turn.steps ?? [];
	const latest = [...steps].reverse().find((step) => step.status === "running") ?? steps[steps.length - 1];
	const what = latest?.title ?? "在想…";
	const elapsed = turn.startedAt > 0 ? humanDuration(now - turn.startedAt) : "";

	return (
		<div className="row row-live" data-slug={turn.slug}>
			<span
				className="live-av"
				aria-hidden="true"
				dangerouslySetInnerHTML={{
					__html: avatarSvg({ slug: turn.slug, name: turn.label, size: 40, state: "working" }),
				}}
			/>
			<div className="live-body">
				<div className="row-head live-head">
					<span className="row-name">{turn.label}</span>
					{role === "" ? null : <span className="row-role">{role}</span>}
					<span className="live-tag">
						<span className="live-dot" aria-hidden="true" />
						正在做
					</span>
				</div>
				<button
					type="button"
					className="live-bubble"
					onClick={() => onOpen(turn.slug)}
					title="看他这一轮做了什么"
				>
					<span className="live-spin" aria-hidden="true" />
					<span className="live-what">{what}</span>
					<span className="live-meta">
						{turn.stepCount > 0 ? `${String(turn.stepCount)} 步 · ` : ""}
						{elapsed}
					</span>
				</button>
			</div>
		</div>
	);
}
