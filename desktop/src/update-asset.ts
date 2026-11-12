/**
 * 自动升级那条路的资产地址：**清单里没这个包也照旧回落** `base + 名字`。
 *
 * 为什么单独一个文件：`updates.ts` 顶层 import 了 electron，vitest 里跑不了；
 * 而这一层的语义（「升级路径行为不变，硬失败只在插件下载那边」）必须有用例钉住 ——
 * 于是把这段纯逻辑拆出来，测试直接引这里（`test/desktop/update-asset.test.ts`）。
 *
 * 和插件下载的区别就在这一句：插件那边缺包是硬失败（`assetUrlOf` 抛，界面上说「清单里没有这个包」），
 * 升级这边不抛 —— 老版本的用户装不上更新比看到一个坏地址更糟，这里只记一句日志、退回 `base + 名字`。
 */
import { assetUrlOf } from "./release-assets.ts";

export function upgradeAssetUrl(release: unknown, feed: string, name: string): string {
	const base = feed.endsWith("/") ? feed : `${feed}/`;
	try {
		return assetUrlOf(release, base, name);
	} catch (error) {
		console.warn(`[update] ${(error as Error).message}，退回 ${base}${encodeURIComponent(name)}`);
		return `${base}${encodeURIComponent(name)}`;
	}
}
