/**
 * 「检查更新」失败时给用户看的那一句话，和日志里那句根因。
 *
 * 为什么要单独一份：`updates.ts` 顶层 import 了 electron，vitest 里跑不了；而「限流 / 连不上 /
 * 签名不对」这三种必须分得开 —— 前两种等一会儿再点就行，第三种再点多少次都一样
 * （2.9.18，程砚-2 之前报的就是 403 限流被静默吞掉，界面上一个字都没有）。
 */
export type UpdateCheck = {
	/** 上一次检查的时间（毫秒）。 */
	readonly at: number;
	readonly ok: boolean;
	/** 失败时给人看的那一句；成功时没有。 */
	readonly message?: string;
};

export function updateFailureMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	// 限流和「不通」分开：一个是等一会儿就好，一个是网络到不了。
	if (/403|429|rate limit/i.test(raw)) return "检查更新没连上（GitHub 限流），稍后重试";
	if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timed out|aborted|fetch failed|更新接口没通/i.test(raw)) {
		return "检查更新没连上，稍后重试";
	}
	if (raw.includes("签名")) return "更新清单签名不对，已拒绝这个版本";
	if (/sha512|校验/.test(raw)) return "下载回来的包校验没过，已拒绝安装";
	if (/JSON|解析|格式/.test(raw)) return "更新清单看不懂（格式不对），稍后重试";
	return `检查更新失败：${raw}`;
}

/** 日志里那句「到底哪一步炸的」：错误原文 + 整条 `cause` 链（`TypeError: fetch failed` 分不出拒绝还是超时）。 */
export function errorDetail(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
		if (current instanceof Error) {
			const code = (current as { code?: unknown }).code;
			parts.push(`${current.name}: ${current.message}${typeof code === "string" ? ` [${code}]` : ""}`);
			current = (current as { cause?: unknown }).cause;
			continue;
		}
		if (typeof current === "object") {
			const code = (current as { code?: unknown }).code;
			parts.push(typeof code === "string" ? `{ code: ${code} }` : JSON.stringify(current));
			current = (current as { cause?: unknown }).cause;
			continue;
		}
		parts.push(String(current));
		break;
	}
	return parts.join(" ← ");
}
