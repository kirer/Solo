/**
 * 来源闸：谁有资格让这个服务「写」。
 *
 * 服务默认监听回环地址，于是所有浏览器页面都能把它当自己的后端用 —— 老板在某个网页上
 * 挂着的时候，那个页面里的脚本可以直接 `POST /api/channels/all/messages`，冒充老板说话。
 * 浏览器唯一不会替你伪造的是两样东西：**Host**（请求是冲哪个域名来的）和 **Origin**
 * （发起方页面的来源）。这两样就是这里要校验的东西。
 *
 * 纯函数、不碰网络：这样「什么算可信来源」这条判断能在 node 环境里直接验，不用起服务。
 */

/** 比较前先归一：大小写、末尾点（`localhost.` 是合法写法 —— 主机名末尾带点仍是同一个域）。 */
function normalizeHost(value: string): string {
	const lowered = value.trim().toLowerCase();
	const cut = lowered.lastIndexOf(":");
	if (cut < 0) return lowered.replace(/\.$/, "");
	return `${lowered.slice(0, cut).replace(/\.$/, "")}${lowered.slice(cut)}`;
}

/**
 * Host 头是否是本服务自己。
 *
 * 防的是 DNS rebinding：攻击者把 `evil.example` 解析到 `127.0.0.1`，页面里的脚本
 * 发同源请求，Origin 也变成 `http://evil.example` —— 只查 Origin 拦不住，Host 能。
 *
 * `allowed` 里放「主机:端口」的完整串（端口不同就是另一个服务，不能放行）。
 */
export function hostAllowed(host: string | undefined, allowed: readonly string[]): boolean {
	if (host === undefined) return false;
	const value = normalizeHost(host);
	if (value === "") return false;
	return allowed.some((item) => normalizeHost(item) === value);
}

/**
 * 写请求的来源是否可信。
 *
 * - `Origin` 存在：必须是自己这一份页面的来源（同源）。跨站、`null`（沙箱 iframe /
 *   `file://` 页面）一律拒。
 * - `Origin` 缺失：现代浏览器跨站请求**一定**带 `Sec-Fetch-Site: cross-site`，所以看它；
 *   两者都缺 = curl / 脚本 / 同源导航，放行（本机脚本本来就有全部权限，拦它没有意义）。
 */
export function originAllowed(
	origin: string | undefined,
	fetchSite: string | undefined,
	selfOrigins: readonly string[],
): boolean {
	const value = (origin ?? "").trim();
	if (value !== "") {
		const lowered = value.toLowerCase();
		return selfOrigins.some((self) => self.trim().toLowerCase() === lowered);
	}
	const site = (fetchSite ?? "").trim().toLowerCase();
	return site === "" || site === "same-origin" || site === "none";
}
