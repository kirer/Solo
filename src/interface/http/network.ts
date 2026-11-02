/**
 * 监听地址：绑哪个 host，以及别人从哪个地址能访问到。
 */
import { networkInterfaces } from "node:os";

// ── 监听地址（原 `network.ts`）────────────────────────────────────────────
// 并进这里的原因：它只回答「绑哪个 host」，没有第二个调用点。

/**
 * 局域网访问地址推导。
 *
 * 服务的监听地址决定「别人能不能访问」：
 * - `127.0.0.1`（默认）：只有本机可用，`lanUrls` 为空——不输出连不上的地址；
 * - `0.0.0.0` / `::`：监听所有网卡，列出全部非回环 IPv4 地址；
 * - 具体某个网卡地址：只列这一个。
 *
 * IPv4 之外的地址（IPv6、虚拟网卡 fe80）刻意不列：扫码/输入到手机时
 * 带 scope 的 fe80 地址基本不可用，列出来只会误导。
 */

/** 通配监听地址。 */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", "*"]);

/** 回环地址。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** 是否是「监听所有网卡」的地址。 */
export function isWildcardHost(host: string): boolean {
	return WILDCARD_HOSTS.has(host.trim());
}

/** 是否是回环地址（只有本机能访问）。 */
export function isLoopbackHost(host: string): boolean {
	const value = host.trim().toLowerCase();
	return value === "" || LOOPBACK_HOSTS.has(value) || value.startsWith("127.");
}

/**
 * 浏览器实际应该打开的地址。
 *
 * 监听 `0.0.0.0` 时不能把 `http://0.0.0.0:port/` 丢给浏览器（多数系统
 * 打不开），退回 `127.0.0.1`，局域网地址由 {@link lanUrlsOf} 单独给出。
 */
export function browserUrlOf(host: string, port: number): string {
	if (isWildcardHost(host)) return `http://127.0.0.1:${port}/`;
	return `http://${host}:${port}/`;
}

/** 本机全部非回环 IPv4 地址（去重、保持网卡顺序）。 */
export function lanAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
	const found: string[] = [];
	for (const entries of Object.values(interfaces)) {
		for (const entry of entries ?? []) {
			// Node 18+ 的 family 可能是字符串 "IPv4"，旧版本是数字 4
			const ipv4 = entry.family === "IPv4" || (entry.family as unknown as number) === 4;
			if (!ipv4) continue;
			if (entry.internal) continue;
			if (entry.address.startsWith("127.")) continue;
			if (!found.includes(entry.address)) found.push(entry.address);
		}
	}
	return found;
}

/**
 * 当前监听配置下，局域网里可用的访问地址。
 *
 * 回环监听返回空数组：这些地址此刻**连不上**，列出来等于骗人。
 */
export function lanUrlsOf(
	host: string,
	port: number,
	interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
	if (isLoopbackHost(host)) return [];
	if (isWildcardHost(host)) return lanAddresses(interfaces).map((address) => `http://${address}:${port}/`);
	// 指定网卡地址：只列它自己（如果它确实是本机地址；否则仍按用户给的列）
	return [`http://${host}:${port}/`];
}

/**
 * 启动日志用的人话提示。
 *
 * 返回空串表示「局域网未开启」，由调用方决定怎么打印。
 */
