/**
 * 一个插槽。**没有插件时它什么都不画** —— 不占位、不留空框。
 *
 * 直接读注册表而不是订阅：插件在挂载前就装完了（`main.tsx` 先 `bootPlugins()`），
 * 之后数组不再变，所以这里不需要状态。
 */
import { useStore } from "../state/useStore.ts";
import { cellsOf, type SlotName } from "./registry.ts";

/** `?slots=1`：把每个插槽的位置画出来（宿主自己核对摆法用，产品里没人带这个参数）。 */
export const SLOT_MARK = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("slots");

export function Slot(props: { readonly name: SlotName; readonly page?: string | null }): JSX.Element | null {
	/**
	 * `app.page` / `dock` 是「一次只画一页」：只画当前被打开的那一个插件的格子，
	 * 别的插件注册的页不占位。其它插槽与这个状态无关，读它们只是为了拿到同一个订阅。
	 */
	const page = useStore((state) => state.pluginView);
	const dock = useStore((state) => state.dock);
	// `page` 是宿主的另一次「打开」：右栏里推入的那一页（同一格，两个容器各画各的）。
	const opened = props.name === "app.page" ? (props.page ?? page) : props.name === "dock" ? dock : null;
	const cells = cellsOf(props.name).filter(
		(cell) => cell.component !== undefined && (opened === null || cell.plugin === opened),
	);
	if (cells.length === 0) {
		// 没有插件时不留空框；只有调试参数在时装个占位，好看见「这里本来有个插槽」。
		return SLOT_MARK ? <div className="slot-mark" data-slot={props.name} /> : null;
	}
	return (
		<>
			{cells.map((cell) => {
				const Component = cell.component;
				if (Component === undefined) return null;
				return SLOT_MARK ? (
					<div key={cell.id} className="slot-mark" data-slot={props.name}>
						<Component />
					</div>
				) : (
					<Component key={cell.id} />
				);
			})}
		</>
	);
}
