/**
 * 更新代理从哪来：`settings.json` 的 `updateProxy`（设置 → 更新）。
 *
 * 单独一个文件是为了能直接测：`updates.ts` 顶层 import 了 electron，vitest 里跑不了。
 *
 * **只给更新用**。模型调用走后端自己的 `fetch`，一个字节都不经过这里 ——
 * 用户要的就是这条边界（GitHub 要过代理，模型接口不要）。
 */
import { readFileSync } from "node:fs";

export function readUpdateProxy(settingsFile: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsFile, "utf8"));
		const value =
			typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["updateProxy"] : undefined;
		return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
	} catch {
		// 没有 settings.json / 读不懂：直连，和加这个设置之前一样。
		return undefined;
	}
}
