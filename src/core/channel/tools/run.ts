/** `run`：执行一条 shell 命令。 */
import { BACKGROUND_CONTEXT, Type, defineTool } from "../../runtime/index.ts";
import { clip, MODEL_LIMIT, selfOrError, text, type CoreToolDeps } from "./shared.ts";

export function createRunTool(deps: CoreToolDeps) {
	const tool = defineTool({
		name: "run",
		description: [
			"执行一条 shell 命令，返回 stdout / stderr / 退出码。",
			"以 `&` 结尾或以 `nohup` 开头 = 后台跑，立即返回 PID。",
		].join(""),
		parameters: Type.Object({
			command: Type.String({ description: "要执行的命令" }),
			cwd: Type.Optional(Type.String({ description: "工作目录，默认工作区根" })),
			timeout: Type.Optional(Type.Number({ description: "超时秒数，默认 60" })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOrError(deps, Number(api.conversationId), ctx, "你还不在名册里。");
			if (typeof slug !== "string") return text(slug);
			const cwd = args.cwd ?? deps.workspaceRoot;
			const seconds = Math.min(Math.max(args.timeout ?? 60, 1), 300);
			const command = args.command;

			// 后台命令：以 & 结尾或以 nohup 开头 → detached spawn，立即返回 PID。
			const isBackground = command.trim().endsWith("&") || /^\s*nohup\b/.test(command);

			if (isBackground) {
				const { spawn } = await import("node:child_process");
				const child = spawn(command.replace(/\s*&\s*$/, ""), {
					shell: true,
					cwd,
					detached: true,
					stdio: "ignore",
				});
				child.unref();
				const pid = child.pid ?? -1;
				return text([`$ ${command}`, `(后台运行，PID ${pid}）`].join("\n"));
			}

			// 前台命令：等它跑完。
			const { exec } = await import("node:child_process");
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null; tooMuch: boolean }>(
				(resolve) => {
					exec(command, { cwd, timeout: seconds * 1000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
						resolve({
							stdout: stdout.toString(),
							stderr: stderr.toString(),
							code: error === null ? 0 : error.code ?? -1,
							tooMuch: (error as { code?: string } | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
						});
					});
				},
			);

			const buffer = [
				`$ ${command}`,
				...(result.stdout.trim() === "" ? [] : [result.stdout.trim()]),
				...(result.stderr.trim() === "" ? [] : [`[stderr] ${result.stderr.trim()}`]),
				...(result.tooMuch ? ["（输出超过 512 KB，后面的被丢弃）"] : []),
				`(退出码 ${result.code})`,
			].join("\n");
			// 剪的尺度：回给模型的是它继续干活要用的，给得宽一些，但**绝不能全量** ——
			// 一次跑整个测试套件就能把 512 KB 塞进上下文，后面几轮全在付费读它。
			return text(clip(buffer, MODEL_LIMIT));
		},
	});
	return tool;
}
