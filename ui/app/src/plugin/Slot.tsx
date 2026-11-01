/**
 * 一个插槽。**没有插件时它什么都不画** —— 不占位、不留空框。
 *
 * 直接读注册表而不是订阅：插件在挂载前就装完了（`main.tsx` 先 `bootPlugins()`），
 * 之后数组不再变，所以这里不需要状态。
 */
import { cellsOf, type SlotName } from "./registry.ts";

export function Slot(props: { readonly name: SlotName }): JSX.Element | null {
	const cells = cellsOf(props.name);
	if (cells.length === 0) return null;
	return (
		<>
			{cells.map((cell) => (
				<cell.component key={cell.id} />
			))}
		</>
	);
}
