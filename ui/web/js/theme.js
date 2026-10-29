/**
 * 主题：浅色 / 深色 / 跟随系统。
 *
 * 分工要说清楚，不然后面改的人会在这里二次实现首帧逻辑：
 *   - `<head>` 里那段内联脚本负责**首帧**：它是同步的，在 CSS 之前把 data-theme 写上去，
 *     所以刷新时不会先画一帧浅色再跳深色。module 是 defer 的，等它跑到已经晚了。
 *   - 这个文件负责**运行期**：读 / 写 localStorage、跟着系统配色变、维护那个按钮。
 *
 * 颜色本身不在这里：`data-theme="dark"` 在 css/base.css 里换掉同一组 token，
 * 其余四个样式表一个字节都不用动。
 */

const KEY = "ai-company.theme";
/** 循环顺序 = 用户最可能想要的顺序：先问系统，再钉死。 */
const ORDER = ["system", "light", "dark"];
const LABEL = { system: "跟随系统", light: "浅色", dark: "深色" };

/** 三个状态的内联图标（不用 emoji，不用图标字体：两者都会在小字号下变糊或变彩）。 */
const ICON = {
	system:
		'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12.5" rx="2"/><path d="M9 20.5h6M12 17v3.5"/></svg>',
	light:
		'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.4 5.4l1.4 1.4M17.2 17.2l1.4 1.4M18.6 5.4l-1.4 1.4M6.8 17.2l-1.4 1.4"/></svg>',
	dark:
		'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.6A8.6 8.6 0 0 1 9.4 4 8.6 8.6 0 1 0 20 14.6Z"/></svg>',
};

const media = window.matchMedia("(prefers-color-scheme: dark)");
let mode = "system";
let installed = false;

function read() {
	try {
		const v = localStorage.getItem(KEY);
		return ORDER.includes(v) ? v : "system";
	} catch {
		// 隐私模式 / 禁用存储会抛。退化成「跟随系统」，不是把整个界面拖崩。
		return "system";
	}
}

function resolved(m) {
	return m === "system" ? (media.matches ? "dark" : "light") : m;
}

/**
 * 主题不再单独占用顶栏按钮：布局与主题已合并进右上角「设置」弹窗（见 index.html）。
 * 这里不再往顶栏插按钮，只把「当前模式 / 切换」暴露给设置面板调用，并由 sync() 同步。
 */
function ensureButton() {
	return null;
}

/** 唯一改状态的地方：写盘 → 换 data-theme → 同步按钮外观。 */
function set(next) {
	mode = ORDER.includes(next) ? next : "system";
	try {
		localStorage.setItem(KEY, mode);
	} catch {
		// 存不下就只在这次会话里生效，界面照常切。
	}
	sync();
}

function sync() {
	const root = document.documentElement;
	root.dataset.theme = resolved(mode);
	root.dataset.themeMode = mode;
	// 暴露给设置面板：读取当前模式、按需高亮对应单选。
	window.__themeMode = mode;
}

export function installTheme() {
	if (installed) {
		sync();
		return;
	}
	installed = true;
	mode = read();
	sync();

	// 设置面板调用：切到指定模式（system/light/dark），并同步面板高亮。
	window.__setThemeMode = (next) => set(next);

	// 系统配色变了只在 system 下跟。light / dark 是用户显式钉的，系统改主意不许覆盖他。
	media.addEventListener("change", () => {
		if (mode === "system") sync();
	});
	// 另一个标签页切了主题，这里也跟上，否则两个页面对不上。
	window.addEventListener("storage", (event) => {
		if (event.key !== KEY) return;
		mode = read();
		sync();
	});
}
