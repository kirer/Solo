/**
 * 活动条：**只在私聊里出现**，贴着输入卡上方，显示这个人此刻在跑的那一轮。
 *
 * 群聊没有它：群聊只留结论，过程在私聊的工作记录里看（DESIGN §2.3）。在群里显示「谁在跑什么」
 * 等于把过程搬回群聊，而那条路径点进去也只能离开当前频道。
 *
 * 数据只有一处出处：`/api/org` 的 `people[].activity`（会话 live 状态派生）；
 * 动作文字取**最近一步的摘要**（`正在跑 npm test`），不写「正在工作」这种空话 ——
 * 那句话没有信息量，而我此刻最想知道的就是它在跑什么（DESIGN §4）。
 *
 * 点整条 = 滚到工作记录里那一轮并展开它。不就地展开：就地展开会把输入卡顶下去，
 * 我正在打字时页面跳一下是最烦的。
 */

import { useEffect, useState } from "react";
import type { Turn } from "../api/types.ts";
import { humanDuration } from "../lib/format.ts";
import { useStore } from "../state/useStore.ts";

/** 每秒一跳的「现在」。只在有活动时才挂定时器，没人跑就一点都不动。 */
function useTick(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [active]);
	return now;
}

type Line = {
	slug: string;
	label: string;
	text: string;
	since: number;
	seq: number | null;
	/** 这一轮发生在哪个频道（私聊页跳转用）。 */
	channelId: string | null;
	steps: number;
};

/** 最近一步说人话。没有步骤（刚开始跑）就写「在想」。 */
function doing(turn: Turn | undefined): { text: string; steps: number } {
	if (turn === undefined) return { text: "在做活", steps: 0 };
	const steps = turn.steps ?? [];
	const last = steps[steps.length - 1];
	const count = steps.length > 0 ? steps.length : turn.stepCount;
	if (last === undefined) return { text: "在想", steps: count };
	if (last.status === "running") {
		if (last.kind === "run" && last.command !== undefined) return { text: `正在跑 ${last.command}`, steps: count };
		if (last.kind === "file-read") return { text: `正在读 ${last.path ?? "文件"}`, steps: count };
		if (last.kind === "file-write") return { text: `正在写 ${last.path ?? "文件"}`, steps: count };
		if (last.kind === "think") return { text: "在想", steps: count };
		return { text: last.title, steps: count };
	}
	if (last.kind === "run") return { text: "跑完一条命令", steps: count };
	return { text: last.title, steps: count };
}

export function ActivityBar(): JSX.Element | null {
	const activity = useStore((state) => state.activity);
	const people = useStore((state) => state.people);
	const work = useStore((state) => state.work);
	const detail = useStore((state) => state.detail);

	// 群聊里没有活动条：群聊不画过程。判断放在 hooks 之后（React 不许条件调用 hook）。
	const partner =
		detail?.channel.kind === "dm" ? detail.members.find((member) => member.slug !== "owner")?.slug : undefined;

	const labels = new Map(people.map((actor) => [actor.slug, actor.label]));
	const found = partner === undefined ? undefined : activity.get(partner);

	const lines: Line[] = [];
	if (partner !== undefined && found !== undefined) {
		// 私聊里看的是**这个人**：他在哪个频道干活都算，不必是当前这个房间。
		const turn = work
			.filter((item) => item.slug === partner && item.status === "running")
			.sort((left, right) => right.startedAt - left.startedAt)[0];
		const text = doing(turn);
		lines.push({
			slug: partner,
			label: labels.get(partner) ?? partner,
			text: text.text,
			since: found.since,
			seq: turn?.seq ?? null,
			channelId: turn?.channelId ?? null,
			steps: text.steps,
		});
	}

	const now = useTick(lines.length > 0);
	if (partner === undefined) return null;

	const shown = lines.slice(0, 2);

	return (
		<div className="activity" data-on={lines.length > 0 ? "true" : "false"} aria-live="polite">
			<div className="activity-inner">
				{shown.map((line) => (
					<button
						type="button"
						className="activity-row"
						key={line.slug}
						onClick={() => {
							if (line.seq === null || line.channelId === null) return;
							const key = `w-${line.channelId}-${String(line.seq)}-${line.slug}`;
							const node = document.querySelector<HTMLElement>(`.row-work[data-key="${key}"] .run-head`);
							node?.scrollIntoView({ block: "center", behavior: "smooth" });
							node?.focus({ preventScroll: true });
						}}
					>
						<span className="activity-dot" aria-hidden="true" />
						<span className="activity-name">{line.label}</span>
						<span className="activity-what">{line.text}</span>
						<span className="activity-meta">
							{humanDuration(Math.max(0, now - line.since))}
							{line.steps === 0 ? "" : ` · ${String(line.steps)} 步`}
						</span>
						<span className="activity-go" aria-hidden="true">
							›
						</span>
					</button>
				))}
				{lines.length > 2 ? <div className="activity-more">还有 {lines.length - 2} 人在跑</div> : null}
			</div>
		</div>
	);
}
