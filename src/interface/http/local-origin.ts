/**
 * 从哪来的请求能碰「系统动作」。
 *
 * 系统动作会在**这台机器上**弹出访达、用默认程序打开文件、改写剪贴板 —— 都是本机效果。
 * 页面本身是同一个界面，局域网里别人也能打开（`--host` 一开就是），所以「谁发的」这一条
 * 必须单独判，不能只靠来源闸（来源闸挡的是跨站，挡不住同一局域网里打开页面、再点按钮）。
 *
 * 判据只有一条：**这条请求是不是从本机连进来的**。
 * - `127.0.0.1` / `::1` 直连 → 算；
 * - 通过本机反代进来的，`x-forwarded-for` 的首段是本机才算；
 * - 局域网网卡地址（`192.168.x.x`）连进来 → 不算。
 *
 * 拿不准就不算：宁可拒绝。
 */
import type { IncomingMessage } from "node:http";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

function isLoopback(address: string): boolean {
	const trimmed = address.trim();
	return LOOPBACK.has(trimmed) || trimmed.startsWith("127.");
}

export function fromThisMachine(request: IncomingMessage): boolean {
	const forwarded = request.headers["x-forwarded-for"];
	const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
	if (typeof first === "string" && first.trim() !== "") {
		// 反代链的首段是真实来源。它必须是本机，否则不认。
		return isLoopback(first.split(",")[0] ?? "");
	}
	const remote = request.socket.remoteAddress;
	return typeof remote === "string" && isLoopback(remote);
}
