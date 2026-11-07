/**
 * 设置：桌面上是一张弹窗（v6 稿子 D05 / D07），窄窗口里铺满整屏。
 *
 * 外观、插件自己注册的分区（如「模型」）、插件、用量、代理、数据 —— 全在一条滚动线上，
 * 每件事一张卡；插件那一节收起时只占一行。
 */

import { useEffect, useState, type ReactNode } from "react";
import { getPreferences, savePreferences } from "../api/client.ts";
import { cellsOf } from "../plugin/registry.ts";
import { Slot } from "../plugin/Slot.tsx";
import { setPluginSheet, setResetOpen, setSettings, setTheme } from "../state/store.ts";
import type { Theme } from "../state/store.ts";

const THEMES: readonly { value: Theme; text: string }[] = [
	{ value: "system", text: "跟随系统" },
	{ value: "light", text: "浅色" },
	{ value: "dark", text: "深色" },
];

function CloseIcon(): JSX.Element {
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
			<path d="m6 6 12 12M18 6 6 18" />
		</svg>
	);
}

function Chevron(props: { up?: boolean }): JSX.Element {
	return (
		<span className={props.up === true ? "set-chev chev-up" : "set-chev"} aria-hidden="true">
			<svg width="8" height="13" viewBox="0 0 8 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
				<path d="m1.5 1.5 5 5-5 5" />
			</svg>
		</span>
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
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
		<path d="M12 4v10" />
		<path d="m8.5 10.5 3.5 3.5 3.5-3.5" />
		<path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
	</svg>
);

const IconTheme = (): JSX.Element => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
		<circle cx="12" cy="12" r="8" />
		<path d="M12 4v16a8 8 0 0 0 0-16Z" fill="currentColor" stroke="none" opacity=".55" />
	</svg>
);

const IconDatabase = (): JSX.Element => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
		<ellipse cx="12" cy="6" rx="7" ry="3" />
		<path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
		<path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
	</svg>
);

/** 一张卡：若干行，行间一条从图标右边起的细线。 */
function Group(props: { children: ReactNode }): JSX.Element {
	return (
		<section className="set-group">
			<div className="set-card">{props.children}</div>
		</section>
	);
}

export function SettingsPage(props: { theme: Theme; leaving?: boolean }): JSX.Element {
	// 插件分区在挂载前就注册完了（`main.tsx` 先 `bootPlugins()`），这里不订阅。
	const cells = cellsOf("settings.section").filter((cell) => cell.component !== undefined);

	return (
		<div className="overlay" data-leaving={props.leaving === true ? "true" : "false"} role="presentation" onMouseDown={(event) => {
			if (event.target === event.currentTarget) setSettings(false);
		}}>
			<div className="modal" role="dialog" aria-modal="true" aria-label="设置">
				<header className="modal-head">
					<span className="modal-title">设置</span>
					<button type="button" className="icon-btn modal-close" aria-label="关闭" onClick={() => setSettings(false)}>
						<CloseIcon />
					</button>
				</header>

				<div className="modal-body">
					<div className="set-body">
						<Group>
							<ThemeRow theme={props.theme} />
						</Group>

						{/* 插件自己注册的一节（`settings.section`）：收成一行，放在「插件」上面。 */}
						{cells.length === 0 ? null : (
							<Group>
								{cells.map((cell) => {
									const Component = cell.component;
									return Component === undefined ? null : (
										<div className="set-cell" key={cell.id}>
											<Component />
										</div>
									);
								})}
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
								<Chevron />
							</button>
							{/* 插件注册的应用级入口（`rail.item`）：落在设置里，与插件行同形。 */}
							<div className="set-tools">
								<Slot name="rail.item" />
							</div>
						</Group>

						<Group>
							<UpdateProxyRow />
						</Group>

						<Group>
							<DataRow />
						</Group>
					</div>
				</div>
			</div>
		</div>
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
 * 平时收成一行（只显示当前地址），点开才出输入框和「保存」（v6 稿子 05 / D07）。
 * 只影响「下载更新」这一条路 —— 模型调用不走这个代理（用户明确要求的边界）。
 * 存进 `settings.json` 的 `updateProxy`，桌面壳每次检查更新前读一遍，所以不用重启。
 */
function UpdateProxyRow(): JSX.Element {
	const [open, setOpen] = useState(false);
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

	const shown = saved === "" ? "未设置" : saved.replace(/^https?:\/\//, "");

	return (
		<div className="set-proxy">
			<button type="button" className="set-row" aria-expanded={open} onClick={() => setOpen(!open)}>
				<RowIcon>
					<IconUpdate />
				</RowIcon>
				<span className="set-main">
					<span className="set-label">更新代理</span>
					<span className="set-desc">只用于桌面版下载新版安装包</span>
				</span>
				<span className="set-proxy-value">{shown}</span>
				<Chevron up={open} />
			</button>
			{open ? (
				<div className="set-proxy-body">
					<div className="set-proxy-field">
						<input
							className="setup-input"
							type="text"
							inputMode="url"
							autoComplete="off"
							spellCheck={false}
							aria-label="更新代理"
							placeholder="http://127.0.0.1:7890"
							value={value}
							onChange={(event) => setValue(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void commit();
							}}
						/>
						<button
							type="button"
							className="set-save"
							disabled={busy || value.trim() === saved}
							onClick={() => void commit()}
						>
							保存
						</button>
					</div>
					<p className="set-note" data-error={error === null ? "false" : "true"}>
						{error ?? "模型调用不走这个代理。"}
					</p>
				</div>
			) : null}
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
				<span className="set-desc">成员、团队、聊天、记忆、技能、附件、日志和模型配置都会删掉</span>
			</span>
			<Chevron />
		</button>
	);
}
