/**
 * 用例层的失败：**一个原因 + 一句人话**。
 *
 * 用例层不认识 HTTP，所以这里刻意**不带状态码**（ADR-082）：说「找不到」，不说 404。
 * 原因只有五种，够覆盖现在所有拒绝；翻成状态码是 `interface/http/server.ts` 的事。
 *
 * 为什么必须区分原因而不是一律抛 Error：如果「频道不存在」在用例层被吞成普通 Error，
 * 传输层就只能一律回 500 —— 而 404 / 400 / 403 / 413 是调用方最需要分开的东西。
 */
export type AppErrorReason = "bad-request" | "forbidden" | "not-found" | "too-large" | "internal";

export class AppError extends Error {
	readonly reason: AppErrorReason;

	constructor(reason: AppErrorReason, message: string) {
		super(message);
		this.name = "AppError";
		this.reason = reason;
	}
}
