/**
 * 悬浮窗的桥：拖动、点击穿透、归位、隐藏。**只有这几件事**，别的一概不暴露。
 *
 * 必须是 CommonJS（`.cts`）：根 `package.json` 是 `type: module`，而沙箱里的 preload
 * 不加载 ESM，也不允许本地 import。主进程在 `main.ts` 里按 `event.sender` 校验来源。
 */
// 沙箱 preload 里不能写 ESM import：用 `require` 拿 electron，类型借 `typeof import("electron")`。
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("soloOrb", {
	/** 鼠标在球 / 面板上时打开命中，移开就穿透（透明的地方不挡别的应用）。 */
	setInteractive: (on: boolean) => ipcRenderer.send("orb:interactive", on),
	/** 这一下拖了多少（屏幕像素）；窗口自己在主进程里挪，界面不改坐标。 */
	dragBy: (dx: number, dy: number) => ipcRenderer.send("orb:drag", dx, dy),
	dragEnd: () => ipcRenderer.send("orb:drag-end"),
	recenter: () => ipcRenderer.send("orb:recenter"),
	hide: () => ipcRenderer.send("orb:hide"),
});
