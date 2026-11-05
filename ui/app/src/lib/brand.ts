/**
 * 应用标识：一个手写的 S，右下角一颗蓝点（与 `desktop/icon.svg` 同一形状）。
 *
 * 只在这里写一次：最左上角那格、助理的头像、群头像里的助理座位，画的是同一个标。
 * 颜色走 CSS 变量，换主题跟着换。
 */
export function brandMarkSvg(size: number): string {
	return `<svg viewBox="0 0 64 64" width="${String(size)}" height="${String(size)}" aria-hidden="true"><rect x="0.8" y="0.8" width="62.4" height="62.4" rx="18.4" fill="var(--rail-mark-bg)" stroke="var(--rail-mark-line)" stroke-width="1.6"/><path d="M40.4 17.4c-2-3.8-10.4-4.2-14.2.4-4.2 4.9-.7 9.6 5.1 12.1 6.7 2.9 8.5 9.8 2.4 14.2-5.8 4-13.4 1.3-14.9-3.8" fill="none" stroke="var(--rail-mark-ink)" stroke-width="6.8" stroke-linecap="round"/><circle cx="48.2" cy="44.8" r="5.8" fill="var(--rail-mark-dot)"/></svg>`;
}
