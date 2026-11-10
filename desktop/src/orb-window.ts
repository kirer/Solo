/**
 * 独立悬浮窗的几何与落盘（纯函数，能在 node 里测）。
 *
 * 悬浮球在桌面壳里是一扇自己的窗口（ADR-116）：透明、无边框、置顶、不占 Dock。
 * 窗口位置由壳记住，界面只报「这一下拖了多少」，所以边界计算与状态解析放在这里，
 * 不碰 Electron 的 `BrowserWindow`（真窗口只有 Electron 里有，摆错了在浏览器里看不出来）。
 */
import { join } from "node:path";

/**
 * 窗口比球大一圈：面板展开时也在窗口里，透明的地方点击直接穿过去。
 *
 * 宽 420 是给面板让的：贴右边缘 MARGIN=12 + 间距 8 + 面板 320 + 右边留 8 = 348，
 * 再加窗口左边必须容下那颗 80 宽的球和它自己的边距，380 差一点，420 才够。
 *
 * 高 612 也是给面板让的：球 top20 + 球高 96 + 间距 16 + 面板 480 = 612。
 * 540 时下面只余 408，面板矮了 72px 才放得下。多出来的 72 全落在球下方，不压到球。
 * 屏高是够的：13 寸可用区 945、外接 1024，最小的一档也还剩 333 的余量。
 */
export const ORB_SIZE = { width: 420, height: 612 } as const;

/**
 * 加宽后右边要多让出来的那一截：现在不需要了，留个 0 说清原因。
 *
 * 担心的是「窗一宽，贴在右上角的球往左跳」。算一遍就知道不会：
 * 默认位置是 x = 可用区宽 − 窗宽 − MARGIN，右边缘 = 可用区宽 − MARGIN ——
 * 跟窗宽无关。窗从 380 加宽到 420，x 少 40、右边缘不动，球的屏幕位置一点没变。
 *
 * 真加补偿反而把它推坏：x 多 40，右边缘就跑到屏幕外 40px，球跟着往右跳。
 * 所以这里必须是 0；留着这个常量是为了让下一个人别再「补」一次。
 */
export const ORB_GROWTH = 0;

/** 屏幕可用区（`screen.getPrimaryDisplay().workArea`）：macOS 上已经扣掉菜单栏。 */
export type OrbArea = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export type OrbBounds = { readonly x: number; readonly y: number };
export type OrbState = OrbBounds & { readonly visible: boolean };

const MARGIN = 12;

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
}

/**
 * 默认贴右上角：窗口里的球也靠右上，所以球落在屏幕右上、菜单栏下面。
 *
 * 定位是「拿窗宽从右边减」，所以右边缘固定在 `可用区右 − MARGIN`，
 * 改窗宽只让窗口从左边长出去，球的屏幕位置不变。
 */
export function defaultOrbBounds(area: OrbArea): OrbBounds {
	return {
		x: area.x + Math.max(0, area.width - ORB_SIZE.width - MARGIN + ORB_GROWTH),
		y: area.y + MARGIN,
	};
}

/** 整个窗口留在可用区里。屏幕比窗口还小时贴住左上角，不产生负数。 */
export function clampOrbBounds(bounds: OrbBounds, area: OrbArea): OrbBounds {
	return {
		x: clamp(Math.round(bounds.x), area.x, area.x + Math.max(0, area.width - ORB_SIZE.width)),
		y: clamp(Math.round(bounds.y), area.y, area.y + Math.max(0, area.height - ORB_SIZE.height)),
	};
}

/**
 * 把窗口摆回可用区里。
 *
 * 先夹，不整份复位：只有「整个屏幕都装不下这个窗口」时才回默认位置。
 *
 * 以前是「只要有一点点在框外就整份丢回默认」—— 换成外接屏、改过缩放的机器上，
 * 存下来的位置永远差那么一点点，于是每次启动都被重置回右上角，人拖过的位置一次都留不住。
 * 现在 x、y 各自夹进可用区：留得下就留，只把出界的那一边收回来。
 */
export function fitOrbBounds(bounds: OrbBounds, area: OrbArea): OrbBounds {
	// 屏幕比窗口还小：夹也夹不出一个合法位置，回默认（`clampOrbBounds` 会给左上角，但那不是「用户选的位置」）。
	if (area.width < ORB_SIZE.width || area.height < ORB_SIZE.height) return defaultOrbBounds(area);
	return clampOrbBounds(bounds, area);
}

export function orbStatePath(appRoot: string): string {
	return join(appRoot, "orb-window.json");
}

/** 读不懂就当没有：位置坏了不该拦住启动，回到默认位置就行。 */
export function parseOrbState(text: string | undefined): OrbState | undefined {
	if (text === undefined || text.trim() === "") return undefined;
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null) return undefined;
		const record = value as Record<string, unknown>;
		if (!Number.isFinite(record["x"]) || !Number.isFinite(record["y"])) return undefined;
		return {
			x: Math.round(record["x"] as number),
			y: Math.round(record["y"] as number),
			visible: record["visible"] !== false,
		};
	} catch {
		return undefined;
	}
}

export function serializeOrbState(state: OrbState): string {
	return `${JSON.stringify({ x: Math.round(state.x), y: Math.round(state.y), visible: state.visible })}\n`;
}
