/**
 * Windows 的标题带：菜单从原生菜单栏搬进窗口顶上的那一条（ADR-069）。
 *
 * 只在桌面壳里画（`html[data-shell="desktop"][data-os="win32"]`），浏览器和 macOS 都没有。
 * 这一条同时是拖窗口的把手；按钮和菜单必须退出拖动（CSS 的 `-webkit-app-region`）。
 * 最小化 / 最大化 / 关闭仍是系统的，画在右边，所以右边留了 140px。
 */
import { useEffect, useState } from "react";
import { TITLEBAR_MENUS, type TitlebarAction } from "./menu.ts";

export function Titlebar(): JSX.Element {
	const [open, setOpen] = useState<string | null>(null);

	/* 点别处 / Esc / 窗口失焦都收起。按钮和菜单在 `.titlebar-menus` 里，
	   点它们不算「别处」—— 否则同一颗按钮的第二次点击会先被这里关掉，再被 onClick 打开。 */
	useEffect(() => {
		if (open === null) return;
		const dismiss = (): void => setOpen(null);
		const onPointer = (event: PointerEvent): void => {
			if (event.target instanceof Element && event.target.closest(".titlebar-menus") !== null) return;
			dismiss();
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") dismiss();
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		window.addEventListener("blur", dismiss);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("blur", dismiss);
		};
	}, [open]);

	const run = (action: TitlebarAction): void => {
		setOpen(null);
		window.soloDesktop?.menu(action);
	};

	return (
		<header className="titlebar">
			<nav className="titlebar-menus" aria-label="应用菜单">
				{TITLEBAR_MENUS.map((menu) => (
					<div className="menu-anchor titlebar-anchor" key={menu.id}>
						<button
							type="button"
							className="titlebar-menu"
							data-brand={menu.id === "solo" ? "true" : undefined}
							aria-haspopup="menu"
							aria-expanded={open === menu.id}
							onClick={() => setOpen(open === menu.id ? null : menu.id)}
						>
							{menu.label}
						</button>
						{open === menu.id ? (
							<div className="menu titlebar-pop" role="menu">
								{menu.items.map((item, index) =>
									"separator" in item ? (
										<div className="menu-sep" role="separator" key={`sep-${String(index)}`} />
									) : (
										<button
											type="button"
											className="menu-item"
											role="menuitem"
											key={item.action}
											onClick={() => run(item.action)}
										>
											{item.label}
										</button>
									),
								)}
							</div>
						) : null}
					</div>
				))}
			</nav>
		</header>
	);
}
