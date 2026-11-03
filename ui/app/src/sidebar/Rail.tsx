/**
 * 最左一列：应用级导航。
 *
 * 从上到下：聊天、通讯录（团队）、任务、插件；**设置单独压在最底下**
 * （和微信桌面版一样：最不常用的那颗放最远的地方）。插件自己的入口
 * （`rail.item` 插槽等）排在插件的下一格。选中哪一格，右边就换成哪一屏 /
 * 打开哪个浮层（docs/DESIGN.md §1.1）。
 *
 * **不写字，只有图标**：一格一件事，名字放在悬停提示里（`data-tip`，见 shell.css
 * 的 `.rail-item::after`）。
 * 78px 里塞不下四个汉字，挤成两行反而更难认。
 */

import { Slot } from "../plugin/Slot.tsx";
import { closeTasks, openTasks, setPluginSheet, setSettings, setTeam } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";

export function Rail(): JSX.Element {
	// 一格亮不亮看的是「现在是不是那一屏」：五格互斥，谁开着谁亮。
	const tasks = useStore((state) => state.tasks.open);
	const team = useStore((state) => state.team);
	// 「插件」这一格只管插件清单那一屏；插件自己的页面（`pluginView`）由它自己的
	// 入口格点亮（`rail.item` 插槽），否则插件页开着时这里会同时亮两格。
	const plugins = useStore((state) => state.pluginSheet);
	const pluginPage = useStore((state) => state.pluginView !== null);
	const settings = useStore((state) => state.settings);
	const away = tasks || team || pluginPage || plugins || settings;
	const running = useStore(
		(state) =>
			[...state.presence.values()].filter((value) => value.state === "working" || value.state === "thinking")
				.length,
	);

	return (
		<nav className="rail" aria-label="主导航">
			<div className="rail-group">
				<button
					type="button"
					className="rail-item"
					id="rail-chat"
					aria-current={away ? "false" : "true"}
					data-tip="聊天"
					aria-label="聊天"
					onClick={closeTasks}
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
						<path d="M20 12a7.5 7.5 0 0 1-7.5 7.5H8L4 22v-4.6A7.5 7.5 0 0 1 4.6 7 7.5 7.5 0 0 1 12.5 4.5 7.5 7.5 0 0 1 20 12z" />
					</svg>
				</button>

				{/* 通讯录：这个组织里有谁、有哪些团队（浮层里读团队与成员）。 */}
				<button
					type="button"
					className="rail-item"
					id="team-btn"
					aria-current={team ? "true" : "false"}
					data-tip="通讯录"
					aria-label="通讯录"
					onClick={() => setTeam(true)}
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
						<circle cx="9" cy="8" r="3.2" />
						<path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
						<path d="M16 5.5a3.2 3.2 0 0 1 0 6" />
						<path d="M17.5 13.6A5 5 0 0 1 21 18.5" />
					</svg>
				</button>

				<button
					type="button"
					className="rail-item"
					id="rail-tasks"
					aria-current={tasks ? "true" : "false"}
					data-tip="任务"
					aria-label="任务"
					onClick={() => openTasks()}
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
						<path d="M5 7l3.5 3.5L5 14" />
						<path d="M11.5 14.5H19" />
						<rect x="3" y="3.5" width="18" height="17" rx="3" />
					</svg>
					{running === 0 ? null : <span className="rail-badge">{running}</span>}
				</button>

				<button
					type="button"
					className="rail-item"
					id="plugins-btn"
					aria-current={plugins ? "true" : "false"}
					data-tip="插件"
					aria-label="插件"
					onClick={() => setPluginSheet(true)}
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
						<path d="M9 3h6v3.2a2 2 0 0 0 2 2h3.2v5.6H17a2 2 0 0 0-2 2V21H9v-3.2a2 2 0 0 0-2-2H3.8V9.2H7a2 2 0 0 0 2-2z" />
					</svg>
				</button>

				{/* 插槽：插件自己的入口（如 Token 用量），排在「插件」的下一格。 */}
				<Slot name="rail.item" />
			</div>

			{/* 设置单独贴在列底：它不是「去哪儿看」，是偶尔才点一次的事。 */}
			<div className="rail-group rail-foot">
				<button
					type="button"
					className="rail-item"
					id="settings-btn"
					aria-current={settings ? "true" : "false"}
					data-tip="设置"
					aria-label="设置"
					onClick={() => setSettings(true)}
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
						<circle cx="12" cy="12" r="3" />
						<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-2.9-1.2l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.11a1.7 1.7 0 0 0 1.2-2.9l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 3.09V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 2.9 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.49.96z" />
					</svg>
				</button>
			</div>
		</nav>
	);
}
