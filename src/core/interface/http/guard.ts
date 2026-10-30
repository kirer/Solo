/**
 * 来源闸：谁有资格让这个服务「写」。
 *
 * 服务默认监听回环地址，于是所有浏览器页面都能把它当自己的后端用 —— 我在某个网页上
 * 挂着的时候，那个页面里的脚本可以直接 `POST /api/channels/all/messages`，冒充我说话。
 * 浏览器唯一不会替你伪造的是两样东西：**Host**（请求是冲哪个域名来的）和 **Origin**
 * （发起方页面的来源）。这两样就是这里要校验的东西。
 *
 * 纯函数、不碰网络：这样「什么算可信来源」这条判断能在 node 环境里直接验，不用起服务。
 */
import { sep } from "node:path";
import { isWildcardHost } from "./network.ts";

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

/**
 * 允许的 Host 头。
 *
 * 由**实际监听地址**推出，不是由「用户可能用什么地址打开」猜：监听回环就只认
 * 回环的三种写法；监听通配地址时把本机局域网地址也算上（否则手机上打开就 403）。
 *
 * 参数都是明文给进来的（端口、绑定地址、环境变量、网卡地址），函数本身不读
 * `process.env`、不看网卡 —— 这样「什么算可信来源」这条判断能在单测里直接跑。
 */
export type AllowedHostsOptions = {
	readonly port: number;
	/** 实际绑定的地址（`127.0.0.1` / `0.0.0.0` / `::` / 具体网卡地址）。 */
	readonly boundHost: string;
	/** 启动参数里显式给的地址（与 `boundHost` 多数时候相同）。 */
	readonly requestedHost?: string | undefined;
	/** `SOLO_ALLOWED_HOSTS` 的原值（逗号分隔，隧道/反代域名）。 */
	readonly allowList?: string | undefined;
	/** 本机局域网地址（懒取：`network.lanAddresses()` 会枚举网卡，只在通配监听时用得上）。 */
	readonly lan?: () => readonly string[];
};

export function allowedHostsOf(options: AllowedHostsOptions): string[] {
	const port = options.port;
	const hosts = new Set<string>([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `::1:${port}`]);
	const bound = options.boundHost.trim();
	if (isWildcardHost(bound)) {
		for (const address of options.lan?.() ?? []) hosts.add(`${address}:${port}`);
		const requested = options.requestedHost?.trim() ?? "";
		if (requested !== "") hosts.add(`${requested}:${port}`);
	} else if (bound !== "") {
		hosts.add(`${bound}:${port}`);
	}
	// 隧道/反代域名：监听地址推不出「外面用什么域名访问」，所以留一个显式口子
	// （逗号分隔，可带端口；不带端口时按当前端口补）。不加这个口子，以后挂个
	// cloudflared 之类就是全站 403 —— 而那时候没人会想到是这道闸。
	for (const raw of (options.allowList ?? "").split(",")) {
		const item = raw.trim().toLowerCase();
		if (item === "") continue;
		hosts.add(item.includes(":") ? item : `${item}:${port}`);
		// 不带端口的条目还要认「裸主机名」：隧道/反代转过来的 Host 常常不带端口
		// （https 走 443，浏览器与代理都会省掉默认端口）。
		if (!item.includes(":")) hosts.add(item);
	}
	return [...hosts];
}

/**
 * 自己这一份页面的 Origin：前端所有写请求都是同源发的。
 *
 * 每个 host 同时给出 http 与 https 两种：走隧道（cloudflared 之类）时页面是 https 的，
 * Origin 就是 `https://<登记域名>` —— 只认 http 的话，从隧道打开的前端一个写请求都过不去。
 * 默认端口会被浏览器省掉（https 的 443、http 的 80），所以这里把它们归一掉再比。
 */
export function selfOriginsOf(hosts: readonly string[]): string[] {
	const origins = new Set<string>();
	for (const host of hosts) {
		const https = host.endsWith(":443") ? host.slice(0, -":443".length) : host;
		const http = host.endsWith(":80") ? host.slice(0, -":80".length) : host;
		origins.add(`http://${http}`);
		origins.add(`https://${https}`);
	}
	return [...origins];
}

/**
 * 路径闸：`target` 是否在 `root` 里面（两者都要先 `resolve`/`normalize`）。
 *
 * 只看字符串前缀是**不够**的（父目录可能是符号链接），所以文件树那边还会 `realpath`
 * 再查一次；这里挡的是静态资源里的 `../..`。
 */
export function insideRoot(root: string, target: string): boolean {
	return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}
