/**
 * 设置：一列往下读的一页（稿子 05）。
 *
 * 外观、插件自己注册的分区（如「模型」）、插件、用量、数据 —— 全在一条滚动线上，
 * 每件事一张卡；插件那一节收起时只占一行。不切左栏、不开弹窗。手机上这一页本来就是整屏，
 * 桌面上照同一份摆（§13.1）—— 一屏只讲一件事，多的往下滚。
 */

import { useEffect, useState, type ReactNode } from "react";
import { getPreferences, savePreferences } from "../api/client.ts";
import { cellsOf } from "../plugin/registry.ts";
import { Slot } from "../plugin/Slot.tsx";
import { setPluginSheet, setResetOpen, setSettings, setTheme } from "../state/store.ts";
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

function BackIcon(): JSX.Element {
	return (
		<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
			<path d="M14.5 5.5 8 12l6.5 6.5" />
		</svg>
	);
}

/** 行首的图标：27 的方块里一枚 16 的线稿（稿子 05 的 `.sico`）。 */
function RowIcon(props: { children: ReactNode }): JSX.Element {
	return (
		<span className="set-ico" aria-hidden="true">
			{props.children}
		</span>
	);
}

const IconPlugin = (): JSX.Element => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
		<path d="M10 4h4v2.2a2 2 0 1 0 4 0V4h2v6h-2.2a2 2 0 1 0 0 4H20v6h-6v-2.2a2 2 0 1 0-4 0V20H4v-6h2.2a2 2 0 1 0 0-4H4V4h6z" />
	</svg>
);

const IconUpdate = (): JSX.Element => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
		<path d="M12 4v10" />
		<path d="m8 10 4 4 4-4" />
		<path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
	</svg>
);

const IconTheme = (): JSX.Element => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
		<circle cx="12" cy="12" r="7" />
		<path d="M12 5a7 7 0 0 0 0 14z" fill="currentColor" stroke="none" />
	</svg>
);

const IconDatabase = (): JSX.Element => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
		<ellipse cx="12" cy="6" rx="7" ry="3" />
		<path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
		<path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
	</svg>
);

/** 一张卡：一行标题 + 内容。卡与卡之间是同一条间距。 */
function Group(props: { title?: string; children: ReactNode }): JSX.Element {
	return (
		<section className="set-group">
			{props.title === undefined ? null : <h2 className="set-title">{props.title}</h2>}
			<div className="set-card">{props.children}</div>
		</section>
	);
}

export function SettingsPage(props: { theme: Theme }): JSX.Element {
	// 插件分区在挂载前就注册完了（`main.tsx` 先 `bootPlugins()`），这里不订阅。
	const cells = cellsOf("settings.section");

	return (
		<section className="page" id="page-settings" aria-label="设置">
			<header className="nav">
				<button type="button" className="icon-btn" id="settings-back" aria-label="返回" onClick={() => setSettings(false)}>
					<BackIcon />
				</button>
				<h1 className="nav-title">设置</h1>
			</header>

			<div className="set-scroll">
				<Group>
					<ThemeRow theme={props.theme} />
				</Group>

				{/* 插件自己注册的一节（`settings.section`）：收成一行，放在「插件」上面。 */}
				{cells.length === 0 ? null : (
					<Group>
						{cells.map((cell) => (
							<div className="set-cell" key={cell.id}>
								<cell.component />
							</div>
						))}
					</Group>
				)}

				<Group>
					<button type="button" className="set-row" onClick={() => setPluginSheet(true)}>
						<RowIcon>
							<IconPlugin />
						</RowIcon>
						<span className="set-main">
							<span className="set-label">插件</span>
							<span className="set-desc">装一个插件就是放一个文件夹，装完当场生效</span>
						</span>
						<span className="set-chev" aria-hidden="true">
							<svg width="8" height="13" viewBox="0 0 8 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
								<path d="m1.5 1.5 5 5-5 5" />
							</svg>
						</span>
					</button>
					{/* 插件注册的应用级入口（`rail.item`）：没有最左那一列了，这些格子落在设置里。 */}
					<div className="set-tools">
						<Slot name="rail.item" />
					</div>
				</Group>

				<Group title="更新">
					<UpdateProxyRow />
				</Group>

				<Group>
					<DataRow />
				</Group>

			</div>
		</section>
	);
}

function ThemeRow(props: { theme: Theme }): JSX.Element {
	return (
		<div className="set-row is-static">
			<RowIcon>
				<IconTheme />
			</RowIcon>
			<span className="set-main">
				<span className="set-label">主题</span>
			</span>
			<div className="seg" id="theme-options">
				{THEMES.map((item) => (
					<button
						type="button"
						key={item.value}
						className="seg-item"
						data-theme-mode={item.value}
						aria-checked={props.theme === item.value}
						onClick={() => setTheme(item.value)}
					>
						{item.text}
					</button>
				))}
			</div>
		</div>
	);
}

/**
 * 更新代理：桌面版下载新版安装包时走它（GitHub 直连经常不通）。
 *
 * 只影响「下载更新」这一条路 —— 模型调用不走这个代理（用户明确要求的边界）。
 * 存进 `settings.json` 的 `updateProxy`，桌面壳每次检查更新前读一遍，所以不用重启。
 */
function UpdateProxyRow(): JSX.Element {
	const [value, setValue] = useState("");
	const [saved, setSaved] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		getPreferences()
			.then((prefs) => {
				if (!alive) return;
				setValue(prefs.updateProxy);
				setSaved(prefs.updateProxy);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, []);

	const commit = async (): Promise<void> => {
		if (busy || value.trim() === saved) return;
		setBusy(true);
		setError(null);
		try {
			const prefs = await savePreferences(value.trim());
			setValue(prefs.updateProxy);
			setSaved(prefs.updateProxy);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="set-proxy">
			<div className="setup-field">
				<RowIcon>
					<IconUpdate />
				</RowIcon>
				<span className="setup-label">更新代理</span>
				<input
					className="setup-input"
					type="text"
					inputMode="url"
					autoComplete="off"
					spellCheck={false}
					aria-label="更新代理"
					placeholder="不用代理就留空"
					value={value}
					onChange={(event) => setValue(event.target.value)}
					onBlur={() => void commit()}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
					}}
				/>
				<button type="button" className="set-save" disabled={busy || value.trim() === saved} onClick={() => void commit()}>
					保存
				</button>
			</div>
			<p className="set-note" data-error={error === null ? "false" : "true"}>
				{error ?? "只用于桌面版下载新版安装包；模型调用不走这个代理。"}
			</p>
		</div>
	);
}

/** 数据：只有一件事 —— 清空一切、回到刚装好的样子。确认浮层在 `Overlays.tsx`。 */
function DataRow(): JSX.Element {
	return (
		<button type="button" className="set-row is-danger" onClick={() => setResetOpen(true)}>
			<RowIcon>
				<IconDatabase />
			</RowIcon>
			<span className="set-main">
				<span className="set-label">重置所有数据</span>
				<span className="set-desc">成员、团队、聊天、记忆、技能、附件和日志都会删掉，找不回来</span>
			</span>
			<span className="set-chev" aria-hidden="true">
				<svg width="8" height="13" viewBox="0 0 8 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
					<path d="m1.5 1.5 5 5-5 5" />
				</svg>
			</span>
		</button>
	);
}
