/**
 * 最左一列：应用级导航。
 *
 * 只有两件事可去 —— 聊天、后台任务。它是外壳的第一列，聊天与任务共用它；
 * 选中哪一格，右边就换成哪一屏（docs/DESIGN.md §1.1）。
 *
 * **不写字，只有图标**（微信桌面版就是这样）：一格一件事，名字放在悬停提示里。
 * 64px 里塞不下四个汉字，挤成两行反而更难认。
 */

import { closeTasks, openTasks } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";

export function Rail(): JSX.Element {
	const tasksOpen = useStore((state) => state.tasks.open);
	const running = useStore(
		(state) =>
			[...state.presence.values()].filter((value) => value.state === "working" || value.state === "thinking")
				.length,
	);

	return (
		<nav className="rail" aria-label="主导航">
			<button
				type="button"
				className="rail-item"
				id="rail-chat"
				aria-current={tasksOpen ? "false" : "true"}
				title="聊天"
				aria-label="聊天"
				onClick={closeTasks}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
					<path d="M20 12a7.5 7.5 0 0 1-7.5 7.5H8L4 22v-4.6A7.5 7.5 0 0 1 4.6 7 7.5 7.5 0 0 1 12.5 4.5 7.5 7.5 0 0 1 20 12z" />
				</svg>
			</button>

			<button
				type="button"
				className="rail-item"
				id="rail-tasks"
				aria-current={tasksOpen ? "true" : "false"}
				title="后台任务"
				aria-label="后台任务"
				onClick={() => openTasks()}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
					<path d="M5 7l3.5 3.5L5 14" />
					<path d="M11.5 14.5H19" />
					<rect x="3" y="3.5" width="18" height="17" rx="3" />
				</svg>
				{running === 0 ? null : <span className="rail-badge">{running}</span>}
			</button>
		</nav>
	);
}
