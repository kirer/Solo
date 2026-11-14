/**
 * 麦克风权限分两层，两层都得管：
 *
 *   1. macOS 的 TCC（系统设置 → 隐私与安全性 → 麦克风）。这一层由 `Info.plist` 里的
 *      `NSMicrophoneUsageDescription` 决定，**弹框交给系统**：我们不主动
 *      `askForMediaAccess`，渲染侧第一次真调 `getUserMedia` 时系统自己弹。
 *   2. Electron 自己的 permission handler。渲染进程调 `getUserMedia` 时，Chromium 先问
 *      Electron 放不放，Electron 再问系统。**不设 handler 时这一层什么都不记**，
 *      于是「点了麦克风没反应」变成一件只能猜的事（2026-11-12 老板就是这么报的）。
 *
 * 这里只有纯函数：`decideMedia` 决定放不放、`describeMicrophone` 决定启动时写什么日志。
 * 接线在 `main.ts` 的 `setupMicrophone`。
 */

export type MediaDecision = { readonly allow: boolean; readonly reason: string };

/**
 * 放不放这次权限请求。只放「媒体里的音频」——摄像头、屏幕共享一律拒，
 * 悬浮球只要录音，多放一项就是多开一扇门。
 */
export function decideMedia(permission: string, mediaTypes: readonly string[] | undefined): MediaDecision {
	if (permission !== "media") return { allow: false, reason: `不是媒体权限（${permission}）` };
	const kinds = mediaTypes ?? [];
	if (kinds.length === 0) return { allow: true, reason: "媒体权限，没标类型（按音频放）" };
	if (kinds.every((kind) => kind === "audio")) return { allow: true, reason: `音频：${kinds.join(" + ")}` };
	return { allow: false, reason: `只要音频，这次请求里有别的：${kinds.join(" + ")}` };
}

/**
 * 启动时往日志里写的那句话。`denied` 必须写出去哪儿改 —— 否则用户看到「没权限」四个字
 * 也不知道该点什么，这正是这次要修的毛病。
 */
export function describeMicrophone(status: string): string {
	switch (status) {
		case "granted":
			return "麦克风：系统已允许";
		case "not-determined":
			return "麦克风：系统还没问过，第一次录音时会弹框";
		case "denied":
			return "麦克风：系统里被拒了 —— 系统设置 → 隐私与安全性 → 麦克风，把 Solo 勾上";
		case "restricted":
			return "麦克风：被系统策略限制（家长控制或 MDM），改不了，得找管理员";
		default:
			return `麦克风：状态未知（${status}）`;
	}
}
