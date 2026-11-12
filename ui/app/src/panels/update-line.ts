/**
 * 设置页「检查更新」那行说明怎么算（2.9.18，Solo #2409 ②）。
 *
 * 单独拎出来是为了能测：验收要的是「界面上真显示『检查更新没连上，稍后重试』」，
 * 不是「代码里有个 message 字段」。桌面壳那边只在查失败且不是手动点的时候不弹窗，
 * 所以自动检查的失败只有这一行字能让用户看见（老板默认不开窗口，日志他也不会去看）。
 */

/** 桌面壳报上来的上一次检查结果（`solo:update-status`）。 */
export type UpdateStatus = { at: number; ok: boolean; message?: string };

export function updateLine(input: { desktop: boolean; version: string; status: UpdateStatus | null }): string {
	if (!input.desktop) return "网页版没有自动更新，桌面版才有";
	const { status } = input;
	if (status !== null && !status.ok) return status.message ?? "检查更新失败，稍后重试";
	return input.version === "" ? "有新版本会提示下载" : `当前版本 ${input.version}`;
}
