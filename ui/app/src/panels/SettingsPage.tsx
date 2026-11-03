/**
 * 设置：应用的第二屏，不是浮层。
 *
 * 左边是分区（外观 + 插件注册进来的 `settings.section`），右边是内容。
 * 分成「页」而不是弹窗的理由写在 docs/DESIGN.md §1.5：点左列那一格就换一整屏，
 * 关掉它靠 Esc 或再点一次「聊天」，不需要一个只为关闭存在的 ×。
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { cellsOf } from "../plugin/registry.ts";
import { setTheme } from "../state/store.ts";
import type { Theme } from "../state/store.ts";

const THEMES: readonly { value: Theme; text: string; icon: JSX.Element }[] = [
	{
		value: "system",
		text: "跟随系统",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
				<circle cx="12" cy="12" r="7" />
				<path d="M12 5a7 7 0 0 0 0 14z" fill="currentColor" stroke="none" />
			</svg>
		),
	},
	{
		value: "light",
		text: "浅色",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
				<circle cx="12" cy="12" r="4" />
				<path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
			</svg>
		),
	},
	{
		value: "dark",
		text: "深色",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
				<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
			</svg>
		),
	},
];

/** 左栏「外观」那一格的图标：半个圆 = 明暗。 */
function AppearanceIcon(): JSX.Element {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
			<circle cx="12" cy="12" r="7.5" />
			<path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" stroke="none" />
		</svg>
	);
}

/**
 * 设置：**左边一列分区，右边是选中那一区的详情**（DESIGN §1.5）。
 *
 * 和通讯录、插件、后台任务是同一套骨架：左栏 288px，右栏才是正文。
 * 分区名在左、内容在右，标题不跟着每个分区重复；右栏正文限宽，
 * 一行不留出一千像素的空白。
 *
 * 内置分区只有「外观」；插件往 `settings.section` 里注册的每一格都是一格分区，
 * 名字取 `label`、图标取 `icon`。分区多了也还找得到东西。
 */
export function SettingsPage(props: { theme: Theme }): JSX.Element {
	// 插件分区在挂载前就注册完了（`main.tsx` 先 `bootPlugins()`），这里不订阅。
	const cells = cellsOf("settings.section");
	const sections: readonly { id: string; label: string; icon?: ReactNode }[] = [
		{ id: "appearance", label: "外观", icon: <AppearanceIcon /> },
		...cells.map((cell) => ({ id: cell.id, label: cell.label ?? cell.id, icon: cell.icon })),
	];
	const [current, setCurrent] = useState("appearance");
	const active = sections.find((section) => section.id === current) ?? sections[0]!;
	const cell = cells.find((item) => item.id === active.id);

	return (
		<section className="page" id="page-settings" aria-label="设置">
			<div className="page-side">
				<header className="page-side-head">
					<h2 className="page-title">设置</h2>
				</header>
				<nav className="page-side-body" aria-label="设置分区">
					<div className="settings-nav-list" role="tablist" aria-orientation="vertical">
						{sections.map((section) => (
							<button
								type="button"
								key={section.id}
								role="tab"
								className="settings-nav-item"
								aria-selected={active.id === section.id}
								onClick={() => setCurrent(section.id)}
							>
								{/* 没有图标也留这一格：几行字得对在同一条竖线上。 */}
								<span className="settings-nav-ico">{section.icon ?? null}</span>
								{section.label}
							</button>
						))}
					</div>
				</nav>
			</div>

			<div className="page-main">
				<header className="page-main-head">
					<h2 className="page-title">{active.label}</h2>
				</header>
				{/* key 变了才重放入场：换分区是「同一块地方换了一份内容」。 */}
				<div className="page-main-body" key={active.id}>
					{cell === undefined || active.id === "appearance" ? <AppearanceSection theme={props.theme} /> : <cell.component />}
				</div>
			</div>
		</section>
	);
}

function AppearanceSection(props: { theme: Theme }): JSX.Element {
	return (
		<>
			<p className="settings-desc">深色在晚上不刺眼，浅色在白天更清楚。</p>
			<div className="settings-options is-three" id="theme-options">
				{THEMES.map((item) => (
					<button
						type="button"
						key={item.value}
						className="opt"
						data-theme-mode={item.value}
						aria-checked={props.theme === item.value}
						onClick={() => setTheme(item.value)}
					>
						<span className="opt-ico">{item.icon}</span>
						<span className="opt-text">{item.text}</span>
					</button>
				))}
			</div>
		</>
	);
}

/* ── 插件 ────────────────────────────────────────────────────────────── */

/** 「它带来了什么」压成一行。全是空的时候说「只有一份说明」。 */
