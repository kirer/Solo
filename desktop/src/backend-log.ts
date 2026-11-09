/**
 * 日志行的写法：`2026-11-09 13:47:02.318 [core] …`
 *
 * `core.log` 里原来是后端 stdout / stderr 的**原样**副本，一行时间都没有 —— 出事时
 * 只能看出「中间空了一段」，看不出是谁、在哪一秒把它弄没的。这里只做两件事：
 * 按行盖时间戳、把进程出事的结论记一行。
 */

/** 本地时间的 `YYYY-MM-DD HH:mm:ss.SSS`（不写时区：给人读的，机器时间看文件 mtime）。 */
export function stamp(at: Date): string {
	const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
	return (
		`${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
		`${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`
	);
}

/**
 * 逐行盖时间戳。
 *
 * 流是「一块一块」来的，一块常常停在半行中间：留下的半行要等下一块补齐再盖，
 * 否则一行会被写成两条、各带一个时间戳，读的时候像是两件事。
 */
export function createLineStamper(
	write: (text: string) => void,
	now: () => Date = () => new Date(),
): {
	push(chunk: string): void;
	flush(): void;
} {
	let rest = "";
	return {
		push(chunk: string): void {
			const lines = (rest + chunk).split("\n");
			rest = lines.pop() ?? "";
			if (lines.length === 0) return;
			const at = stamp(now());
			write(lines.map((line) => `${at} ${line}\n`).join(""));
		},
		flush(): void {
			if (rest === "") return;
			const line = rest;
			rest = "";
			write(`${stamp(now())} ${line}\n`);
		},
	};
}

/**
 * 后端退出时那一行。
 *
 * `code` 与 `signal` 必须**都**记：这两个合起来才是「是它自己挂的，还是被人弄死的」——
 * code 有值 = 自己退的（75 是重置 / 重启），signal 有值 = 被杀（SIGKILL / SIGSEGV…），
 * 两个都取不到 = 状态不明，不能当成正常结束。
 */
export function describeExit(
	code: number | null,
	signal: NodeJS.Signals | null,
	stoppedByShell: boolean,
): string {
	let why: string;
	if (stoppedByShell) why = "壳主动停的，不算异常";
	else if (signal !== null) why = `被信号 ${signal} 杀死`;
	else if (code === 75) why = "重置 / 重启，壳按「重开」处理";
	else if (code === 0) why = "正常退出";
	else if (code === null) why = "退出状态不明";
	else why = "异常退出";
	return `[backend] 后端退出：code=${code === null ? "无" : String(code)} signal=${signal === null ? "无" : signal}（${why}）`;
}

/** 一次启动 / 重启的第一行：谁发起的、什么版本、哪个进程。 */
export function describeLaunch(input: {
	readonly reason: string;
	readonly version: string;
	readonly userRoot: string;
	readonly pid: number;
}): string {
	return `[shell] 启动：发起者=${input.reason}；版本 ${input.version}；pid ${String(input.pid)}；用户目录 ${input.userRoot}`;
}
