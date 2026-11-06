/** `run`：执行一条 shell 命令。 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT, Type, defineTool } from "../../runtime/index.ts";
import { RUN_LIMIT_MS, startRunJob, type RunOutcome } from "../jobs.ts";
import { OWNER } from "../types.ts";
import { defaultChannel } from "./channel-choice.ts";
import { mentionRoster, readState, selfOrError, text, type CoreToolDeps } from "./context.ts";
import { clip, MODEL_LIMIT } from "./guards.ts";
import { readIdentity } from "../../documents/member/identity.ts";
import { ensureDir } from "../../runtime/io.ts";
import { workspaceOf } from "../../layout.ts";
import { fill, type TextCatalog } from "../../documents/base/catalog.ts";

/**
 * 洗掉终端控制序列（颜色、光标）。命令输出里的 `\u001b[90m` 进了提示词和界面就是
 * 一坨 `[90m` —— 模型读不懂，我看不懂。
 */
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;
function plain(text: string): string {
	return text.replace(ANSI, "");
}

/** 后台命令跑完的那条留痕：命令、输出尾巴、怎么结束的。 */
function renderRunResult(command: string, outcome: RunOutcome, catalog?: TextCatalog): string {
	const body = plain(outcome.log).trim();
	const ending = outcome.timedOut
		? fill(catalog, "run.result.timeout", {
				minutes: Math.round(RUN_LIMIT_MS / 60_000),
				path: outcome.logPath,
			})
		: fill(catalog, "run.result.exit", {
				code: outcome.code ?? fill(catalog, "run.result.signal"),
				path: outcome.logPath,
			});
	return fill(catalog, "run.result.done", {
		command,
		body: body === "" ? fill(catalog, "run.result.empty") : body,
		ending,
	});
}

export function createRunTool(deps: CoreToolDeps) {
	const t = (key: string, slots: Record<string, string | number | undefined> = {}): string =>
		fill(deps.text, key, slots);
	const tool = defineTool({
		name: "run",
		description: t("run.description"),
		parameters: Type.Object({
			command: Type.String({ description: t("run.param.command") }),
			cwd: Type.Optional(Type.String({ description: t("run.param.cwd") })),
			timeout: Type.Optional(Type.Number({ description: t("run.param.timeout") })),
			background: Type.Optional(Type.Boolean({ description: t("run.param.background") })),
		}),
		execute: async (args, api, context) => {
			const ctx = context ?? BACKGROUND_CONTEXT;
			const slug = await selfOrError(deps, Number(api.conversationId), ctx);
			if (typeof slug !== "string") return text(slug);
			// 默认在**自己的**工作目录里干活：一个人一个目录，互不踩。目录不在就先建。
			const ownDir = (await readIdentity(deps.layout.agentRoots, slug))?.dir ?? join(deps.layout.membersRoot, slug);
			const ownWorkspace = workspaceOf(ownDir);
			await ensureDir(ownWorkspace);
			const cwd = args.cwd ?? ownWorkspace;
			const seconds = Math.min(Math.max(args.timeout ?? 60, 1), 300);
			const command = args.command;

			// 异步：起跑就返回，跑完结果回到**起跑的这个频道**并叫醒起跑的人。
			// 频道必须在起跑时就定下来：等跑完再算「该回哪儿」，唤醒记录早换了。
			if (args.background === true) {
				const state = await readState(deps);
				const target = await defaultChannel(deps, state, slug, Number(api.conversationId), undefined, ctx);
				if ("error" in target) return text(target);
				const job = await startRunJob({
					dir: join(deps.layout.logsRoot, "run"),
					slug,
					channelId: target.channelId,
					command,
					cwd,
					onDone: async (outcome) => {
						const fresh = await readState(deps);
						await deps.wiring.flow.publish(
							fresh,
							{
								channelId: target.channelId,
								from: OWNER,
								text: renderRunResult(command, outcome, deps.text),
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
				return text(t("run.background.started", { command, pid: job.pid, title }));
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
				return text(t("run.background.detached", { command, pid }));
			}

			// 前台命令：等它跑完。
			const { exec } = await import("node:child_process");
			const result = await new Promise<{
				stdout: string;
				stderr: string;
				code: number | null;
				tooMuch: boolean;
				timedOut: boolean;
				signal: string | null;
			}>((resolve) => {
				exec(command, { cwd, timeout: seconds * 1000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
					const failure = error as { code?: string | number | null; killed?: boolean; signal?: string | null } | null;
					resolve({
						stdout: stdout.toString(),
						stderr: stderr.toString(),
						code: error === null ? 0 : typeof failure?.code === "number" ? failure.code : -1,
						tooMuch: failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
						// `exec` 超时会自己杀掉子进程：`killed` 只在这一条路上为真。
						timedOut: failure?.killed === true,
						signal: failure?.signal ?? null,
					});
				});
			});

			const out = plain(result.stdout).trim();
			const err = plain(result.stderr).trim();
			const buffer = [
				`$ ${command}`,
				...(out === "" ? [] : [out]),
				...(err === "" ? [] : [t("run.foreground.stderr", { text: err })]),
				...(result.tooMuch ? [t("run.foreground.too-much")] : []),
				// 被超时杀掉时要明说是超时、以及下一次怎么放宽 —— 只说「退出码 ?」，
				// 模型会当成命令坏了去换写法（实测有人改成后台再跑一遍）。
				result.timedOut
					? t("run.foreground.timeout", { seconds })
					: result.signal !== null
						? t("run.foreground.signal", { signal: result.signal })
						: t("run.foreground.exit", { code: result.code ?? "?" }),
			].join("\n");
			// 剪的尺度：回给模型的是它继续干活要用的，给得宽一些，但**绝不能全量** ——
			// 一次跑整个测试套件就能把 512 KB 塞进上下文，后面几轮全在付费读它。
			return text(clip(buffer, MODEL_LIMIT, deps.text));
		},
	});
	return tool;
}
