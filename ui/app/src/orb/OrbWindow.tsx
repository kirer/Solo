/**
 * 独立悬浮窗（`?orb=1`）：整页只有插件画的那一层。
 *
 * 桌面壳把它装进第二扇透明窗口（ADR-116）。数据与插件和主界面是同一份 ——
 * `bootstrap()` 照常拉组织与频道，`bootPlugins()` 照常装插件，这里只是不画 `<App>`。
 */
import { Slot } from "../plugin/Slot.tsx";

export function OrbWindow(): JSX.Element {
	return <Slot name="overlays" />;
}
