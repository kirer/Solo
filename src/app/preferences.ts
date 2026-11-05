/**
 * 界面能改的少数几项偏好，存进 `settings.json`。
 *
 * 现在只有一项：**更新代理**。GitHub 在这台机器上经常要过本机代理才能下载，但这条
 * 只给桌面版的「下载新版安装包」用（壳自己读这个键），**模型调用不走它** ——
 * 模型接口如果也要过代理，那是提供商自己的 `baseUrl` 或系统代理的事，不该在这里隐式生效。
 */
import { readSettingsFile, updateSettingsFile } from "../core/runtime/settings.ts";
import { AppError } from "./errors.ts";
import type { CoreServices } from "./types.ts";

export type Preferences = { readonly updateProxy: string };

/** 空串 = 直连。写死三种协议即可，Electron 的 proxyRules 也认这些。 */
const PROXY = /^(https?|socks5?):\/\/[^\s]+$/i;

export function createPreferences(services: CoreServices) {
	return {
		async read(): Promise<Preferences> {
			const settings = readSettingsFile(services.layout.settingsFile);
			return { updateProxy: settings?.updateProxy ?? "" };
		},
		async save(body: unknown): Promise<Preferences> {
			const raw = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["updateProxy"] : undefined;
			if (typeof raw !== "string") throw new AppError("bad-request", "updateProxy 必须是字符串");
			const proxy = raw.trim();
			if (proxy !== "" && !PROXY.test(proxy)) {
				throw new AppError("bad-request", "代理地址要以 http:// 或 socks5:// 开头，例如 http://127.0.0.1:7890");
			}
			// 只动这一个键：providers / agentModels 原样保留。
			updateSettingsFile(services.layout.settingsFile, (settings) => {
				if (proxy === "") delete settings["updateProxy"];
				else settings["updateProxy"] = proxy;
			});
			return { updateProxy: proxy };
		},
	};
}
