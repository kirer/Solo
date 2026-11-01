/** `run`：执行一条 shell 命令。 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT, Type, defineTool } from "../../runtime/index.ts";
import { RUN_LIMIT_MS, startRunJob, type RunOutcome } from "../jobs.ts";
import { postMessage } from "../post.ts";
import { OWNER } from "../types.ts";
import { defaultChannel } from "./channel-choice.ts";
import { mentionRoster, postDeps, readState, selfOrError, text, type CoreToolDeps } from "./context.ts";
import { clip, MODEL_LIMIT } from "./guards.ts";

/**
 * 洗掉终端控制序列（颜色、光标）。命令输出里的 `\u001b[90m` 进了提示词和界面就是
 * 一坨 `[90m` —— 模型读不懂，我看不懂。
 */
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;
function plain(text: string): string {
	return text.replace(ANSI, "");
}

/** 后台命令跑完的那条留痕：命令、输出尾巴、怎么结束的。 */
function renderRunResult(command: string, outcome: RunOutcome): string {
	const body = plain(outcome.log).trim();
	const ending = outcome.timedOut
		? `（超过 ${Math.round(RUN_LIMIT_MS / 60_000)} 分钟，已杀掉；全文在 ${outcome.logPath}）`
		: `(退出码 ${outcome.code ?? "被信号结束"}；全文在 ${outcome.logPath})`;
	return [`后台命令跑完了。`, `$ ${command}`, ...(body === "" ? ["（没有输出）"] : [body]), ending].join("\n");
}

export function createRunTool(deps: CoreToolDeps) {
	const tool = defineTool({
		name: "run",
		description: [
			"执行一条 shell 命令，返回 stdout / stderr / 退出码。",
			"`background: true` = 丢到后台跑（最多 30 分钟），立刻返回；跑完结果发回这个频道并叫醒你。",
			"以 `&` 结尾或以 `nohup` 开头 = 纯脱手，立即返回 PID，永远不会有回音。",
		].join(""),
		parameters: Type.Object({
			command: Type.String({ description: "要执行的命令" }),
			cwd: Type.Optional(Type.String({ description: "工作目录，默认工作区根" })),
			timeout: Type.Optional(Type.Number({ description: "超时秒数，默认 60" })),
			background: Type.Optional(
				Type.Boolean({ description: "丢到后台跑，跑完把结果发回频道并叫醒你（最多 30 分钟）" }),
			),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOrError(deps, Number(api.conversationId), ctx, "你还不在名册里。");
			if (typeof slug !== "string") return text(slug);
			const cwd = args.cwd ?? deps.workspaceRoot;
			const seconds = Math.min(Math.max(args.timeout ?? 60, 1), 300);
			const command = args.command;

			// 异步：起跑就返回，跑完结果回到**起跑的这个频道**并叫醒起跑的人。
			// 频道必须在起跑时就定下来：等跑完再算「该回哪儿」，唤醒记录早换了。
			if (args.background === true) {
				const state = await readState(deps);
				const target = await defaultChannel(deps, state, slug, Number(api.conversationId), undefined, ctx);
				if ("error" in target) return text(target);
				const job = await startRunJob({
					dir: join(deps.workspaceRoot, "logs", "run"),
					slug,
					channelId: target.channelId,
					command,
					cwd,
					onDone: async (outcome) => {
						const fresh = await readState(deps);
						await postMessage(
							postDeps(deps, fresh, BACKGROUND_CONTEXT),
							{
								channelId: target.channelId,
								from: OWNER,
								text: renderRunResult(command, outcome),
								at: Date.now(),
								kind: "note",
								noteOf: "run",
								// 名册要给：`mention` 里的 slug 也要过一遍解析，不给名册会被当成
								// 「解析不出来的 @」丢掉，消息上就看不出这条结果是给谁的。
								roster: await mentionRoster(deps),
								mention: [slug],
								wakeTo: [slug],
							},
							BACKGROUND_CONTEXT,
						);
					},
				});
				const title = state.channels[target.channelId]?.title ?? target.channelId;
				return text(
					[
						`$ ${command}`,
						`(后台运行，PID ${job.pid}）`,
						`跑完结果会发到「${title}」并叫你。这中间你可以干别的，别轮询。`,
					].join("\n"),
				);
			}

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

			const out = plain(result.stdout).trim();
			const err = plain(result.stderr).trim();
			const buffer = [
				`$ ${command}`,
				...(out === "" ? [] : [out]),
				...(err === "" ? [] : [`[stderr] ${err}`]),
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
