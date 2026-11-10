/**
 * 系统动作的跨进程管道：**主进程做，后端只说「做什么」**。
 *
 * 为什么绕这一圈：Electron 的 `shell` / `clipboard` 只在主进程里有，而后端是一个
 * `ELECTRON_RUN_AS_NODE` 起的子进程。给子进程开一条 TCP / HTTP 口子，就等于在
 * `127.0.0.1` 上多一个「谁都能调」的入口；走已经存在的父子管道（stdin / stdout）
 * 则天然只有这两头能说话，不用再开端口、不用再守来源。
 *
 * 协议是一行一条 JSON，两个方向都有 `id`：
 *
 * - 后端 → 主进程：`{"id":1,"action":"reveal","path":"/abs/x.png"}`
 * - 主进程 → 后端：`{"id":1,"ok":true}` 或 `{"id":1,"ok":false,"error":"…"}`
 *
 * 三种动作在线上就三个名字（`reveal` / `open` / `clipboard`），**没有第四个**。
 * 路径已经过内核的 `resolveInside` 校验（见 `src/core/plugin/system.ts`），这一层只管执行。
 */
import { clipboard, shell } from "electron";
import type { ChildProcess } from "node:child_process";

/** 一行一条。太长的行不认 —— 协议里不该有长东西（最长的是一条绝对路径）。 */
const MAX_LINE = 8192;

export type BridgeAction = "reveal" | "open" | "clipboard";

type Request = { readonly id: unknown; readonly action: unknown; readonly path?: unknown; readonly text?: unknown };

/**
 * 把一根管道接上：读到请求就做，然后把结果写回另一根。
 *
 * 返回一个 `close()`，进程收尾时叫它 —— 否则子进程读着 stdin，退出会拖到超时。
 */
export function serveSystemBridge(child: ChildProcess): { close(): void } {
	const input = child.stdin;
	const output = child.stdout;
	if (input === null || output === null) return { close: () => undefined };

	const reply = (payload: unknown): void => {
		if (input.destroyed || !input.writable) return;
		try {
			input.write(`${JSON.stringify(payload)}\n`);
		} catch {
			// 管子断了（后端刚退出）：这条结果没人要了。
		}
	};

	let buffer = "";
	const onData = (chunk: string): void => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		// 半行攒着；但攒到超长说明对面的格式已经乱了，丢掉重来（不能让内存无界涨）。
		if (buffer.length > MAX_LINE) buffer = "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			void handle(trimmed);
		}
	};

	async function handle(line: string): Promise<void> {
		let request: Request;
		try {
			request = JSON.parse(line) as Request;
		} catch {
			return;
		}
		const id = request.id;
		if (id === undefined) return;

		const action = request.action;
		if (action === "clipboard") {
			if (typeof request.text !== "string") return reply({ id, ok: false, error: "要 text" });
			clipboard.writeText(request.text);
			return reply({ id, ok: true });
		}
		if (action !== "reveal" && action !== "open") {
			return reply({ id, ok: false, error: "不认识的动作" });
		}
		const path = request.path;
		if (typeof path !== "string" || !path.startsWith("/")) {
			// 绝对路径是这一层的硬要求：相对路径在这边没有「相对于哪」可言。
			return reply({ id, ok: false, error: "要一个绝对路径" });
		}

		if (action === "reveal") {
			// `showItemInFolder` 没有返回值：成功失败都是「没抛错」。
			shell.showItemInFolder(path);
			return reply({ id, ok: true });
		}
		// `openPath` 回一个空串表示成功，否则是被拒的原因。
		const problem = await shell.openPath(path);
		return reply(problem === "" ? { id, ok: true } : { id, ok: false, error: problem });
	}

	output.setEncoding("utf8");
	output.on("data", onData);

	return {
		close() {
			output.off("data", onData);
			// 关掉子进程的 stdin，让它那边的读循环结束。
			if (!input.destroyed) input.end();
		},
	};
}
