/**
 * 桌面壳唯一的桥：菜单动作 + 标题栏取色，别的一概不暴露。
 *
 * 必须是 CommonJS（`.cts`）：根 `package.json` 是 `type: module`，而沙箱里的 preload
 * 不加载 ESM，也不允许本地 import。主进程在 `main.ts` 里按 `event.sender` 校验来源。
 */
// 沙箱 preload 里不能写 ESM import（根包是 `type: module`，只认 CommonJS）：
// 用 `require` 拿 electron，类型借 `typeof import("electron")`（这一句会被擦掉）。
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("soloDesktop", {
	menu: (action: string) => ipcRenderer.send("solo:menu", action),
	setTheme: (theme: "light" | "dark") => ipcRenderer.send("solo:theme", theme),
	/** 设置页要显示「当前版本」（`app.getVersion()` 在主进程那边）。 */
	version: () => ipcRenderer.invoke("solo:version"),
	/**
	 * 上一次检查更新的结果（2.9.18）：`{ at, ok, message }`，没查过是 `null`。
	 * 失败那句（「检查更新没连上（GitHub 限流），稍后重试」）就是它的 `message` —— 设置页那行字读这里。
	 */
	updateStatus: () => ipcRenderer.invoke("solo:update-status"),
});
