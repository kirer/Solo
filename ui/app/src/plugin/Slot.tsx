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
	 * `app.page` / `dock` 是「一次只画一页」：只画当前被打开的那一个插件的格子，
	 * 别的插件注册的页不占位。其它插槽与这个状态无关，读它们只是为了拿到同一个订阅。
	 */
	const page = useStore((state) => state.pluginView);
	const dock = useStore((state) => state.dock);
	const opened = props.name === "app.page" ? page : props.name === "dock" ? dock : null;
	const cells = cellsOf(props.name).filter(
		(cell) => cell.component !== undefined && (opened === null || cell.plugin === opened),
	);
	if (cells.length === 0) return null;
	return (
		<>
			{cells.map((cell) => {
				const Component = cell.component;
				return Component === undefined ? null : <Component key={cell.id} />;
			})}
		</>
	);
}
