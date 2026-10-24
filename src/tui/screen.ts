/**
 * 整屏渲染组件。
 *
 * 不用 pi-tui 的 `Text`：它默认带左右各 1 列 padding 且会**按宽度自动换行**，
 * 会把已经排版好的三栏画面重新折行，导致分隔线错位。
 *
 * 这里直接输出预排版好的行：宽度已经由 `renderLayout` 精确算过，
 * 组件只需保证不越界、不折行。
 */
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

export class Screen implements Component {
	private lines: readonly string[] = [];
	private paddingX: number;

	/** @param paddingX 左右留白列数，0 表示贴边 */
	constructor(paddingX = 0) {
		this.paddingX = paddingX;
	}

	/** 替换整屏内容。 */
	setLines(lines: readonly string[]): void {
		this.lines = lines;
	}

	setPaddingX(paddingX: number): void {
		this.paddingX = paddingX;
	}

	invalidate(): void {
		// 无缓存
	}

	render(width: number): string[] {
		const available = Math.max(1, width - this.paddingX * 2);
		const pad = " ".repeat(this.paddingX);
		return this.lines.map((line) => `${pad}${truncateToWidth(line, available)}${pad}`);
	}
}

/** 供测试：一行的显示宽度。 */
export function lineWidth(line: string): number {
	return visibleWidth(line);
}
