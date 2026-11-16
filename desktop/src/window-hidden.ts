/**
 * 无人值守验证的窗口开关（Solo 2026-11-16）。
 *
 * `SOLO_WINDOW_HIDDEN=1` 时窗口**照常建、照常渲染**（CDP 的 `Page.captureScreenshot` 一样能截），
 * 只是从头到尾不显示 —— 老板这台机器上跑隔离副本，一次都不许弹窗。
 *
 * 这不是测试专用的 hack：以后所有无人值守的跑法（发版前排包验证、升级验收、冒烟）都靠它。
 *
 * 只认 `"1"` 这一个写法，跟 `SOLO_VERIFY_NO_DIALOG` / `SOLO_VERIFY_INSTALL` 一个口径：
 * 写成 `true` / `yes` / `on` 一律当没设 —— 这类开关宁可不生效，也不要「以为设了其实没设」。
 */
export function mayShowWindow(env: NodeJS.ProcessEnv = process.env): boolean {
	return env["SOLO_WINDOW_HIDDEN"] !== "1";
}
