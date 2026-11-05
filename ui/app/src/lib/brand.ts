/**
 * 应用标识：一颗自己的星，和绕着它转的轨道（与 `desktop/icon.svg` 同一形状）。
 *
 * 只在这里写一次：最左上角那格、助理的头像、群头像里的助理座位，画的是同一个标。
 * 颜色走 CSS 变量，换主题跟着换。
 */
export function brandMarkSvg(size: number): string {
	return `<svg viewBox="0 0 64 64" width="${String(size)}" height="${String(size)}" aria-hidden="true"><rect width="64" height="64" rx="14.25" fill="var(--rail-mark-bg)"/><g transform="rotate(-28 32 32)"><ellipse cx="32" cy="32" rx="20.75" ry="8.25" fill="none" stroke="var(--rail-mark-ink)" stroke-width="2.8" opacity="0.62"/></g><circle cx="32" cy="32" r="8.75" fill="var(--rail-mark-ink)"/></svg>`;
}
