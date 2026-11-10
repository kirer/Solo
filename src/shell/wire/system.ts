/**
 * 后端这一侧的「系统动作执行器」：把请求写上 stdout、等主进程从 stdin 回一行。
 *
 * 为什么是这个方向：Electron 的 `shell` / `clipboard` 只在主进程里有，后端是
 * `ELECTRON_RUN_AS_NODE` 起的子进程。父子之间**已经**有管道了（后端本来就把日志写
 * stdout），再用它传一次，比在 `127.0.0.1` 上开一个新端口安全得多 —— 管道只有这两头
 * 能说话，不用守来源、不用守 host。
 *
 * **只有桌面壳起的后端才有这根管子**：主进程会带 `SOLO_SYSTEM_BRIDGE=1`。`npm start`
 * （网页版）没有，这时返回 `undefined` —— 插件的 `api.system.act` 会抛「这个宿主不支持」，
 * 而不是假装做完了。
 */
import { createInterface } from "node:readline";
import type { SystemActor } from "../../core/plugin/index.ts";

/** 一次动作的超时。主进程那边这几个调用都是秒回的，慢成这样就是出事了。 */
const TIMEOUT_MS = 10_000;

export function createDesktopActor(): SystemActor | undefined {
	if (process.env.SOLO_SYSTEM_BRIDGE !== "1") return undefined;
	if (process.stdout.destroyed || !process.stdout.writable) return undefined;

	/** 等回话的那几条：`id` → 兑现 / 拒绝（含清定时器）。 */
	const waiting = new Map<number, { resolve(): void; reject(error: Error): void }>();
	let nextId = 1;

	const reader = createInterface({ input: process.stdin });
	reader.on("line", (line) => {
		const trimmed = line.trim();
		if (trimmed === "") return;
		let reply: { id?: unknown; ok?: unknown; error?: unknown };
		try {
			reply = JSON.parse(trimmed) as typeof reply;
		} catch {
			return;
		}
		const id = typeof reply.id === "number" ? reply.id : undefined;
		if (id === undefined) return;
		const pending = waiting.get(id);
		if (pending === undefined) return;
		waiting.delete(id);
		if (reply.ok === true) pending.resolve();
		else pending.reject(new Error(typeof reply.error === "string" ? reply.error : "没做成"));
	});
	// 主进程把管子关了（退出 / 重启）：在等的动作全部失败，别让插件那边挂住。
	reader.on("close", () => {
		for (const pending of [...waiting.values()]) pending.reject(new Error("桌面壳断开了"));
		waiting.clear();
	});

	const send = (payload: Record<string, unknown>): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			const id = nextId++;
			const timer = setTimeout(() => {
				if (!waiting.delete(id)) return;
				reject(new Error("桌面壳没有回应"));
			}, TIMEOUT_MS);
			waiting.set(id, {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				process.stdout.write(`${JSON.stringify({ ...payload, id })}\n`);
			} catch {
				waiting.delete(id);
				clearTimeout(timer);
				reject(new Error("写不进桌面壳"));
			}
		});

	return {
		act: (action, absolutePath) => send({ action, path: absolutePath }),
		copyText: (text) => send({ action: "clipboard", text }),
	};
}
