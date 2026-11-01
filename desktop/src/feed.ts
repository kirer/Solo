/**
 * 更新源地址。
 *
 * 打包时由 `SOLO_UPDATE_URL`（electron-builder 的 `${env.SOLO_UPDATE_URL}`）写进
 * `Resources/app-update.yml`；运行时这个环境变量也能覆盖它，好处是**不用重新打包**就能
 * 指到本地假 feed 上验证升级。
 *
 * 只信 https，或者 http 但主机是本机（本地测试用）。其他一律不认 —— 更新包是可以执行的东西，
 * 不该被一个随手设的环境变量指去明文端口。
 */
export function resolveFeedUrl(raw: string | undefined): string | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return undefined;
	}
	if (url.protocol === "https:") return url.href;
	const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
	return url.protocol === "http:" && local ? url.href : undefined;
}
