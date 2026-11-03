/**
 * 一个插槽。**没有插件时它什么都不画** —— 不占位、不留空框。
 *
 * 直接读注册表而不是订阅：插件在挂载前就装完了（`main.tsx` 先 `bootPlugins()`），
 * 之后数组不再变，所以这里不需要状态。
 */
import { useStore } from "../state/useStore.ts";
import { cellsOf, type SlotName } from "./registry.ts";

export function Slot(props: { readonly name: SlotName }): JSX.Element | null {
	/**
	 * `app.page` 是一整屏：只画「当前被打开的那一个插件」的格子，别的插件注册的页
	 * 不占位。其它插槽与这个状态无关，读它只是为了拿到同一个订阅。
	 */
	const active = useStore((state) => state.pluginView);
	const cells = cellsOf(props.name).filter((cell) => props.name !== "app.page" || cell.plugin === active);
	if (cells.length === 0) return null;
	return (
		<>
			{cells.map((cell) => (
				<cell.component key={cell.id} />
			))}
		</>
	);
}
