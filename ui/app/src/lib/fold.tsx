/**
 * 展开 / 收起：**两个方向**都有动画。
 *
 * 关上时内容先留 180ms（和 CSS `.fold` 的折叠时长一致）再卸，否则收起就是「啪」地消失；
 * 高度走 grid 的 `0fr → 1fr`，不碰 `height`（motion.css 第三条纪律）。
 */
import { useEffect, useState, type ReactNode } from "react";

export function Fold(props: { open: boolean; children: ReactNode }): JSX.Element {
	const [alive, setAlive] = useState(props.open);
	useEffect(() => {
		if (props.open) {
			setAlive(true);
			return;
		}
		const timer = window.setTimeout(() => setAlive(false), 180);
		return () => window.clearTimeout(timer);
	}, [props.open]);
	return (
		<div className="fold" data-open={props.open ? "true" : "false"}>
			<div className="fold-in">{alive ? props.children : null}</div>
		</div>
	);
}
