/**
 * 网页服务：HTTP + SSE。
 *
 * 设计取舍：
 * - 用 SSE 而不是 WebSocket：单向推送足够（老板的操作走普通 POST），
 *   实现简单、无依赖、断线自动重连。
 * - 组织快照用一次全局订阅 + 防抖重建，所有客户端共享，不会因为
 *   开了几个标签页就把数据库读爆。
 * - 会话流按客户端各自 watch，切换会话即停止，避免泄漏。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { BACKGROUND_CONTEXT, InboxDoc, inspectLiveness, isConversationBusy } from "../runtime/index.ts";
import type { CompanyRuntime } from "../runtime/index.ts";
import { answerPending, listPending, PendingDoc } from "../company/escalation.ts";
import { captureInterruptedWork, createDispositionPending, settleDisposition } from "../company/disposition.ts";
import { readCompany, startCompanyWatchdog } from "../company/org.ts";
import { buildOrgView } from "./org-view.ts";
import { decorateFeed, readFeed } from "./feed.ts";
import { readProfile } from "./profile.ts";

/** 服务选项。 */
export type ServeOptions = {
	/**
	 * 运行时，或返回当前运行时的 getter。
	 *
	 * **长跑的服务请传 getter**：崩溃自愈（`watchForFailure`）会 `openCompany()`
	 * 打开一个**新对象**，把实例钉死在闭包里会让看门狗、SSE 推送、所有请求
	 * 在自愈之后继续对着已关闭的运行时干活（表现为「自愈后整个界面不动了」）。
	 */
	readonly runtime: CompanyRuntime | (() => CompanyRuntime);
	readonly port?: number;
	readonly host?: string;
	/** 静态资源目录（默认仓库根的 ui/）。 */
	readonly uiDir?: string;
	/**
	 * 是否启动看门狗（契约 §5.2）。默认启动。
	 *
	 * 放在这里而不是 `bootstrapCompany`：看门狗会主动 abort 任务、投递排队消息，
	 * 只应该由「真的在跑服务」的入口拥有。测试想完全掌控调度时传 `false`。
	 */
	readonly watchdog?: boolean;
};

/** 服务句柄。 */
export type Server = {
	readonly url: string;
	close(): Promise<void>;
};

/**
 * 中断最多等 abort 多久；超时也必须先把消息排进去，不能把 HTTP 挂死。
 * 依据：ADR-026 决策 5「时机 now 遇原子操作 → 最多等 30 秒 → 硬切」之外的普通路径。
 */
const INTERRUPT_TIMEOUT_MS = 5_000;

/**
 * 处于原子操作时，最多等多久再硬切（ADR-026 决策 3）。
 *
 * 原文：「档位是 now 但正处在不可中断的原子操作（写文件 / 提交 / 外部副作用）时，
 * 下属回一句『正在提交，最多 30 秒后切换』，然后自己切……30 秒内撕坏文件对公司
 * 没有任何好处，而延迟有硬上限。」
 *
 * 所以 30 秒是**上限**：到了照样切，只是先给一句告知、给当前操作一个收尾机会。
 */
const INTERRUPT_ATOMIC_MAX_MS = 30_000;

/**
 * 哪些工具算「不可中断的原子操作」。
 *
 * 取自底层 `CodingTools` 的真实工具名（read/write/edit/bash）：
 * - `write` / `edit`：直接落盘，撕断会留下半个文件；
 * - `bash`：可能正在跑任意副作用（提交、外部调用），无法预知。
 *
 * `read` 不算：读操作被中断没有副作用。
 * 刻意**不做**「解析 bash 命令行判断是不是写在文件」——那是个无底洞，
 * 而 ADR 的要求只是「有上限的告知」，不需要精确到命令级。
 */
const ATOMIC_TOOL_NAMES = new Set(["write", "edit", "bash"]);

/** MIME 表。 */
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
};

/** 启动服务。 */
export async function serve(options: ServeOptions): Promise<Server> {
	// 每次取最新的运行时：自愈会换对象，闭包里不能存实例
	const current = (): CompanyRuntime =>
		typeof options.runtime === "function" ? options.runtime() : options.runtime;
	const port = options.port ?? 7788;
	const host = options.host ?? "127.0.0.1";
	const uiDir = options.uiDir ?? join(process.cwd(), "ui");

	/** 组织快照的失效信号 + 防抖。 */
	let orgDirty = true;
	const orgClients = new Set<ServerResponse>();
	let orgTimer: NodeJS.Timeout | undefined;

	const scheduleOrgPush = (): void => {
		orgDirty = true;
		if (orgTimer !== undefined) return;
		orgTimer = setTimeout(() => {
			orgTimer = undefined;
			void pushOrg();
		}, 250);
	};

	const pushOrg = async (): Promise<void> => {
		if (!orgDirty || orgClients.size === 0) return;
		orgDirty = false;
		let payload: string;
		try {
			payload = JSON.stringify(await buildOrgView(current(), BACKGROUND_CONTEXT));
		} catch (error) {
			payload = JSON.stringify({ error: String(error) });
		}
		for (const client of orgClients) {
			try {
				client.write(`event: org\ndata: ${payload}\n\n`);
			} catch {
				orgClients.delete(client);
			}
		}
	};

	// 任何提交都可能改变组织状态：订阅一次，全客户端共享。
	// 崩溃自愈会换运行时对象，所以要跟着换订阅——否则自愈之后新运行时上的提交
	// 推不动界面，看起来像「服务卡住了」。
	let subscribed: CompanyRuntime | undefined;
	let unsubscribeCommits: (() => void) | undefined;
	const ensureSubscribed = (): void => {
		const next = current();
		if (next === subscribed) return;
		unsubscribeCommits?.();
		subscribed = next;
		try {
			unsubscribeCommits = next.harness.subscribeCommits(() => {
				scheduleOrgPush();
			});
		} catch {
			// 运行时可能正处在关闭/重开之间：下一帧再试
			subscribed = undefined;
			unsubscribeCommits = undefined;
		}
	};
	ensureSubscribed();

	// 看门狗：定期收尾僵住的任务、排空被压住的队列（契约 §5.2）。
	// **传 getter 而不是实例**：崩溃自愈会重开运行时，传实例会让看门狗
	// 每轮都对已关闭的对象巡检 → 抛错 → 被吞掉 → 看门狗静默失效。
	const stopWatchdog =
		options.watchdog === false
			? () => undefined
			: startCompanyWatchdog(current, {
					onAlert: (alert) => {
						process.stderr.write(`[看门狗] ${alert.message}\n`);
						// 告警要立刻出现在界面：留痕条目已经落库，这里顺手推一帧
						scheduleOrgPush();
					},
				});

	const server = createServer((request, response) => {
		void handle(request, response);
	});

	/** 路由。 */
	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
		const path = url.pathname;

		try {
			if (path === "/api/org") return json(response, await buildOrgView(current(), BACKGROUND_CONTEXT));
			if (path === "/api/pending") {
				const state = await readCompany(current(), BACKGROUND_CONTEXT);
				void state;
				return json(response, await listPending(current(), BACKGROUND_CONTEXT));
			}
			if (path.startsWith("/api/feed/")) {
				const conversationId = Number(path.slice("/api/feed/".length));
				if (!Number.isFinite(conversationId)) return fail(response, 400, "会话标识不合法");
				const feed = await readFeed(current(), conversationId, {}, BACKGROUND_CONTEXT);
				if (feed === undefined) return fail(response, 404, "会话不存在");
				return json(response, await decorateFeed(current(), feed, BACKGROUND_CONTEXT));
			}
			// 职工档案：顶部按钮展示这位职工的角色预制提示词 / 技能（用户 2.5）
			if (path.startsWith("/api/profile/")) {
				const conversationId = Number(path.slice("/api/profile/".length));
				if (!Number.isFinite(conversationId)) return fail(response, 400, "会话标识不合法");
				const result = await readProfile(current(), conversationId, BACKGROUND_CONTEXT);
				if ("error" in result) return fail(response, 404, result.error);
				return json(response, result.profile);
			}
			if (path.startsWith("/api/stream/org")) return streamOrg(response);
			if (path.startsWith("/api/stream/feed/")) {
				const conversationId = Number(path.slice("/api/stream/feed/".length));
				if (!Number.isFinite(conversationId)) return fail(response, 400, "会话标识不合法");
				return streamFeed(response, conversationId);
			}
			if (path === "/api/message" && request.method === "POST") return await postMessage(request, response);
			if (path === "/api/answer" && request.method === "POST") return await postAnswer(request, response);
			if (path === "/api/interrupt" && request.method === "POST") return await postInterrupt(request, response);

			// 静态资源
			return await serveStatic(response, uiDir, path);
		} catch (error) {
			return fail(response, 500, error instanceof Error ? error.message : String(error));
		}
	}

	/** 组织快照的 SSE。 */
	function streamOrg(response: ServerResponse): void {
		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		response.write("retry: 1500\n\n");
		orgClients.add(response);

		// 首帧：立刻给一份，避免白屏等待
		void buildOrgView(current(), BACKGROUND_CONTEXT).then((view) => {
			try {
				response.write(`event: org\ndata: ${JSON.stringify(view)}\n\n`);
			} catch {
				orgClients.delete(response);
			}
		});

		const keepAlive = setInterval(() => {
			try {
				response.write(": ping\n\n");
			} catch {
				clearInterval(keepAlive);
			}
		}, 15_000);

		response.on("close", () => {
			clearInterval(keepAlive);
			orgClients.delete(response);
		});
	}

	/** 单个会话流的 SSE。 */
	async function streamFeed(response: ServerResponse, conversationId: number): Promise<void> {
		const conversation = await current().harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
		if (conversation === undefined) return fail(response, 404, "会话不存在");

		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		response.write("retry: 1500\n\n");

		let closed = false;
		/** 合并高频提交，避免 100ms 一次的重绘把浏览器压垮。 */
		let pendingTimer: NodeJS.Timeout | undefined;

		const push = async (): Promise<void> => {
			if (closed) return;
			try {
				const feed = await readFeed(current(), conversationId, {}, BACKGROUND_CONTEXT);
				if (feed === undefined) return;
				const decorated = await decorateFeed(current(), feed, BACKGROUND_CONTEXT);
				response.write(`event: feed\ndata: ${JSON.stringify(decorated)}\n\n`);
			} catch {
				// 单次失败不关闭连接，等下一次
			}
		};

		await push();

		const watch = await conversation.watch(BACKGROUND_CONTEXT);
		watch.start(async () => {
			if (pendingTimer !== undefined) return;
			pendingTimer = setTimeout(() => {
				pendingTimer = undefined;
				void push();
			}, 150);
		});

		const keepAlive = setInterval(() => {
			try {
				response.write(": ping\n\n");
			} catch {
				/* 连接已断 */
			}
		}, 15_000);

		response.on("close", () => {
			closed = true;
			clearInterval(keepAlive);
			if (pendingTimer !== undefined) clearTimeout(pendingTimer);
			void watch.stop();
		});
	}

	/** 发消息。 */
	async function postMessage(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson<{ conversationId?: number; text?: string; mode?: "steer" | "followUp" }>(request);
		const conversationId = Number(body.conversationId);
		const text = (body.text ?? "").trim();
		if (!Number.isFinite(conversationId) || text === "") {
			return fail(response, 400, "需要 conversationId 与 text");
		}

		const runtime = current();
		const conversation = await runtime.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
		if (conversation === undefined) return fail(response, 404, "会话不存在");

		// ADR-026 决策 3：老板通道默认 now —— 指令到达即生效，立刻停、丢当前轮。
		// 旧默认 steer（排在本轮工具之后）会把「要不要现在听」推回给老板，与老板的硬要求冲突。
		// 仍保留 step/turn 作为显式档位（对应 steer/followUp），只是不再是默认值。
		const whenBusy = body.mode ?? "now";
		// 回执里的 timing 必须记**实际档位**（决策 8 的留痕要求），不能恒写 "now"：
		// 否则事后分不清「老板要的是立刻停」还是「他只要求本轮结束再处理」。
		const timing: "now" | "step" | "turn" =
			whenBusy === "steer" ? "step" : whenBusy === "followUp" ? "turn" : "now";

		// ADR-026 决策 7.1：回执不经过模型。受理成功即写一条 app.receipt，
		// 模型失败/超时也必须看得见「收到了」——这条是系统写的，与生成结果无关。
		await writeReceipt(runtime, conversationId, text, timing);

		// now 档：先打断当前轮，再把消息投进去（abort 会撤掉队列，所以中断后再 submit）。
		// step/turn 走原有的 whenBusy 语义。
		//
		// ADR-026 决策 7.3「老板通道永不排队」+ 决策 7.2「不允许静默结束」：
		// 投递结果必须被检查。老板这一条没投进去时**明确告诉他**（503），
		// 而不是让异常穿透成 500「消息没发出去」却又不说明是哪条、其余几条怎么样。
		let delivery: { delivered: string[]; failed: string[] } = { delivered: [], failed: [] };
		if (whenBusy === "now") {
			delivery = await interruptThenDeliver(runtime, conversation, conversationId, text);
		} else {
			try {
				await conversation.submit({ type: "input", content: text, whenBusy }, BACKGROUND_CONTEXT);
				delivery = { delivered: [text], failed: [] };
			} catch {
				delivery = { delivered: [], failed: [text] };
			}
		}

		if (delivery.failed.length > 0) {
			// 追认条目（审计 B-03）：回执已经落了，必须有一条「投递失败」与之成对，
			// 否则「有回执」与「消息没进去」在历史里无法区分（违反决策 7.2）。
			await writeUndelivered(runtime, conversationId, delivery.failed);
			// 界面要立刻看到那条追认：早退前先推一次组织视图（原先漏了，要等下一轮才刷新）。
			scheduleOrgPush();
			// 老板自己那条失败 → 明确回 503；他只是丢了这一条时也能立刻知道要重发。
			if (delivery.failed.includes(text)) {
				return fail(response, 503, "这条没投进去，请重发。");
			}
			// 只丢了其它排队消息：老板这条已受理，回执与追认条目都已在，正常返回。
		}
		// OPS-20261025-04（审计 R-02）：模型失败落在 tasks.outcome.status = "failed"，
		// 底层不会为它调 onReport。这里在图台上方**统一**扫一次——不依赖
		// interruptThenDeliver 内部哪条分支，两条档位都经过这里，结构上不会漏。
		// 读表 + 水位去重，幂等；扫不到（失败尚未落库）也没关系，看门狗每轮会再扫。
		await runtime.scanTaskFailures(BACKGROUND_CONTEXT).catch(() => 0);
		scheduleOrgPush();
		return json(response, { ok: true, receipt: true });
	}

	/**
	 * 写一条受理回执（ADR-026 决策 7.1）。
	 *
	 * 刻意不走模型：只要 HTTP 受理成功就必须有回执，模型挂了、超时了、
	 * 被更高层指令覆盖了，老板也应当看得见「这条话被收到了」。
	 * 留痕失败不影响受理本身（与 watchdog.writeAlert 同一取舍）。
	 */
	async function writeReceipt(
		runtime: CompanyRuntime,
		conversationId: number,
		text: string,
		timing: "now" | "step" | "turn",
	): Promise<void> {
		try {
			await runtime.harness.commit(async (tx) => {
				await tx.appendEntry(conversationId as never, {
					kind: "app.receipt",
					data: {
						text: text.slice(0, 280),
						from: "老板",
						timing,
						at: Date.now(),
					},
				});
			}, BACKGROUND_CONTEXT);
		} catch {
			// 回执失败不影响受理
		}
	}

	/**
	 * 这个会话此刻是否正卡在不可中断的原子操作里（ADR-026 决策 3）。
	 *
	 * 数据源是 `pi.live.tools`——底层已经维护了「正在跑哪些工具、状态是什么」，
	 * 不需要另建状态机（审计 B-01 的「最小实现」建议，也符合「不复杂化」的要求）。
	 *
	 * @returns 命中时返回工具名（用于告知文案），否则 undefined
	 */
	async function detectAtomicOperation(
		runtime: CompanyRuntime,
		conversationId: number,
	): Promise<string | undefined> {
		try {
			const conversation = await runtime.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
			if (conversation === undefined) return undefined;
			const view = await conversation.watch(BACKGROUND_CONTEXT);
			const live = view.value.docs["pi.live"] as
				| {
						readonly tools?: Record<
							string,
							{ readonly name?: string; readonly status?: string }
						>;
				  }
				| undefined;
			const tools = view.value.docs === undefined ? undefined : live?.tools;
			await view.stop();

			for (const tool of Object.values(tools ?? {})) {
				const name = tool.name;
				if (name === undefined || !ATOMIC_TOOL_NAMES.has(name)) continue;
				// status 缺省时按「在跑」处理：宁可多等 30 秒，也不要撕断一次写盘。
				if (tool.status === "done" || tool.status === "error" || tool.status === "cancelled") continue;
				return name;
			}
		} catch {
			// 探测失败一律按「不是原子操作」处理：不能因为探测不了就不受理老板的急事。
		}
		return undefined;
	}

	/**
	 * 写一条面向老板的告知条目（ADR-026 决策 3「只通知，不征求意见」）。
	 *
	 * 用 `app.alert` 而不是新造条目类型：`feed.ts` 已有 alert 的渲染，
	 * 复用它就是「界面上真的看得见」；新类型反而要改三处渲染才能显示。
	 * 失败不影响投递（告知是附加价值）。
	 */
	async function writeNotice(
		runtime: CompanyRuntime,
		conversationId: number,
		text: string,
	): Promise<void> {
		try {
			await runtime.harness.commit(async (tx) => {
				await tx.appendEntry(conversationId as never, {
					kind: "app.alert",
					data: { text, from: "系统", action: "notice", reason: "atomic-operation", at: Date.now() },
				});
			}, BACKGROUND_CONTEXT);
		} catch {
			// 告知失败不影响受理
		}
	}

	/**
	 * 写一条「投递失败」追认条目（审计 B-03）。
	 *
	 * 存在的理由：回执（app.receipt）在投递**之前**写，这是 ADR-026 决策 7.1 的要求
	 * （模型失败也必须有回执）。但若投递失败而只留回执，历史里就出现
	 * 「有回执、消息没进去」且无法区分——这正是决策 7.2「不允许静默结束」要堵的洞。
	 * 所以投递失败时补一条成对的追认，让两者在历史里可区分。
	 */
	async function writeUndelivered(
		runtime: CompanyRuntime,
		conversationId: number,
		failed: readonly string[],
	): Promise<void> {
		try {
			await runtime.harness.commit(async (tx) => {
				await tx.appendEntry(conversationId as never, {
					kind: "app.alert",
					data: {
						text: `有 ${failed.length} 条消息未投递成功（服务侧拒绝）：${failed
							.map((item) => `「${item.slice(0, 40)}」`)
							.join("、")}`,
						from: "系统",
						action: "report",
						reason: "undelivered",
						at: Date.now(),
					},
				});
			}, BACKGROUND_CONTEXT);
		} catch {
			// 追认失败也不能把失败变成功：调用方仍会按 failed 返回 503。
		}
	}

	/**
	 * now 档投递：先中断当前轮，再把消息投进去（ADR-026 落地第一步）。
	 *
	 * 复用 postInterrupt 的两个安全约束（都是真实事故）：
	 * 1. 不能无限等 abort，最多 {@link INTERRUPT_TIMEOUT_MS}；
	 * 2. abort 会撤掉整个队列，所以必须把「这条 + 其它排队消息」全部补回去，不能顺手吞掉。
	 */
	async function interruptThenDeliver(
		runtime: CompanyRuntime,
		conversation: NonNullable<Awaited<ReturnType<CompanyRuntime["harness"]["conversation"]>>>,
		conversationId: number,
		text: string,
	): Promise<{ delivered: string[]; failed: string[] }> {
		const inbox = (await runtime.harness.snapshot(InboxDoc, conversationId as never, BACKGROUND_CONTEXT)) as
			| { items?: readonly { mode: string; content: unknown }[] }
			| undefined;
		const queued = (inbox?.items ?? [])
			.filter((item) => item.mode !== "write")
			.map((item) => queueText(item.content))
			.filter((item) => item !== "");

		// 已经不在队列里 = 没有正在跑的活要打断，直接投
		if (!queued.includes(text)) {
			try {
				await conversation.submit({ type: "input", content: text, whenBusy: "steer" }, BACKGROUND_CONTEXT);
				return { delivered: [text], failed: [] };
			} catch {
				return { delivered: [], failed: [text] };
			}
		}

		const rest = queued.filter((item) => item !== text);

		// ADR-026 决策 4：打断前先把「正在跑什么、进度几/几」机械推导出来。
		// 必须在 abort **之前**采集——abort 之后任务就没了，什么都读不到。
		// 采集失败不影响打断（处置信息是附加价值，不能反过来卡住受理）。
		const interrupted = await captureInterruptedWork(runtime, conversationId, BACKGROUND_CONTEXT).catch(
			() => undefined,
		);

		// ── ADR-026 决策 3：原子操作例外（只通知，不征求）──
		//
		// 正卡在写文件/提交/外部副作用时，**先不 abort**：
		// 先把老板这句话按 steer 投进去（保证不丢），回一句「正在提交，最多 30 秒后切换」，
		// 然后在 30 秒上限内等会话自己空闲；到点仍未空闲就硬切。
		// 刻意不用「等 30s 再 abort」：那会让老板干等；先投递能让他立刻看到回执与告知。
		const atomicTool = await detectAtomicOperation(runtime, conversationId);
		if (atomicTool !== undefined) {
			await writeNotice(
				runtime,
				conversationId,
				`正在提交（${atomicTool}），最多 30 秒后切换——你这条已收到，排在当前操作之后立即执行。`,
			);
			// 这条必须先投进去：不能因为「等一下」而把它丢了。
			const atomicDelivery = await deliverAll(conversation, [text, ...rest]);
			// 在 30 秒上限内等它自己收尾（轮询比固定 sleep 更早切换）
			await waitForIdleUpTo(runtime, conversationId, INTERRUPT_ATOMIC_MAX_MS);
			// 到点还没空闲 → 硬切（ADR 原文的「延迟有硬上限」）
			if (await isStillBusy(runtime, conversationId)) {
				await conversation.abort(BACKGROUND_CONTEXT).catch(() => false);
			}
			// 处置待办照旧落下：老板的急事已经插队，旧工作仍有「被打断」的定性。
			if (interrupted !== undefined) {
				await createDispositionPending(runtime, interrupted).catch(() => undefined);
			}
			return atomicDelivery;
		}

		let timer: NodeJS.Timeout | undefined;
		await Promise.race([
			conversation.abort(BACKGROUND_CONTEXT).then(
				() => true,
				() => false,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), INTERRUPT_TIMEOUT_MS);
			}),
		]).finally(() => {
			if (timer !== undefined) clearTimeout(timer);
		});

		// 打断完成后再落处置待办（ADR-026 决策 4/5）：
		// 默认暂搁、5 分钟期限、恢复条件默认 30 分钟后提醒下达人。
		// 同样不能因为落待办失败而丢掉消息，所以先记结果、最后统一处理。
		if (interrupted !== undefined) {
			await createDispositionPending(runtime, interrupted).catch(() => undefined);
		}

		// 这条优先；被 abort 撤掉的其它排队消息也补回去
		return deliverAll(conversation, [text, ...rest]);
	}

	/**
	 * 逐条投递，**任一条失败不影响其余**（审计 B-02）。
	 *
	 * 原实现 `for (...) await submit(...)` 让第 k 条的异常直接中断循环：
	 * 第 k+1..n 条消息永久丢失，而它们已被 abort 从 inbox 撤掉、没有第二次机会。
	 * 现在逐条 try/catch，失败记下来并写补偿条目。
	 *
	 * 去重（B-02(b)）：`rest` 可能包含与 `text` 同名的项，原实现会把同一条投两遍。
	 * 这里按文本去重，并且「这条优先」由**一次** submit 完成。
	 */
	async function deliverAll(
		conversation: NonNullable<Awaited<ReturnType<CompanyRuntime["harness"]["conversation"]>>>,
		items: readonly string[],
	): Promise<{ delivered: string[]; failed: string[] }> {
		// 保序去重：老板这条在最前，同名的后续项合并掉（投两遍没有意义）
		const unique: string[] = [];
		for (const item of items) if (!unique.includes(item)) unique.push(item);

		const delivered: string[] = [];
		const failed: string[] = [];
		for (const item of unique) {
			try {
				await conversation.submit({ type: "input", content: item, whenBusy: "steer" }, BACKGROUND_CONTEXT);
				delivered.push(item);
			} catch {
				failed.push(item);
			}
		}
		return { delivered, failed };
	}

	/** 在 `maxMs` 上限内等会话空闲；提前空闲就立刻返回（每次轮询 250ms）。 */
	async function waitForIdleUpTo(
		runtime: CompanyRuntime,
		conversationId: number,
		maxMs: number,
	): Promise<void> {
		const deadline = Date.now() + maxMs;
		while (Date.now() < deadline) {
			if (!(await isStillBusy(runtime, conversationId))) return;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	/** 这个会话是否还有活任务/在跑的工具。 */
	async function isStillBusy(runtime: CompanyRuntime, conversationId: number): Promise<boolean> {
		try {
			const liveness = await inspectLiveness(runtime, {}, BACKGROUND_CONTEXT);
			return isConversationBusy(liveness, conversationId);
		} catch {
			return false;
		}
	}

	/**
	 * 打断当前工作，立刻处理这条消息。
	 *
	 * 场景：CEO 正在等一个很慢的下属回复，老板发了一句急话。
	 * 光排队要等很久，所以先中断当前运行，再把消息投进去。
	 *
	 * 两个必须守住的点（都是真实事故）：
	 * 1. **不能无限等 abort**：abort 要等会话 idle；如果某个工具永远不返回
	 *    （以前的跨会话死锁），HTTP 请求会永远挂住，界面只显示「处理中…」。
	 *    这里最多等 {@link INTERRUPT_TIMEOUT_MS}，等不到也先把消息排进去。
	 * 2. **消息不能丢**：abort 会撤掉队列里的全部输入。所以先记下队列，
	 *    abort 之后把「这条 + 其它排队消息」重新投递，而不是只投一条。
	 */
	async function postInterrupt(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson<{ conversationId?: number; text?: string }>(request);
		const conversationId = Number(body.conversationId);
		const text = (body.text ?? "").trim();
		if (!Number.isFinite(conversationId) || text === "") {
			return fail(response, 400, "需要 conversationId 与 text");
		}

		const conversation = await current().harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
		if (conversation === undefined) return fail(response, 404, "会话不存在");

		const inbox = (await current().harness.snapshot(InboxDoc, conversationId as never, BACKGROUND_CONTEXT)) as
			| { items?: readonly { mode: string; content: unknown }[] }
			| undefined;
		const queued = (inbox?.items ?? [])
			.filter((item) => item.mode !== "write")
			.map((item) => queueText(item.content))
			.filter((item) => item !== "");

		// 消息已经被放进了对话（不再排队）：不需要中断，也不再重复投递
		if (!queued.includes(text)) {
			scheduleOrgPush();
			return json(response, { ok: true, alreadyPlaced: true });
		}

		const rest = queued.filter((item) => item !== text);

		// ADR-026 决策 4：打断前机械采集「正在跑什么、进度几/几」（必须在 abort 之前）。
		const interrupted = await captureInterruptedWork(current(), conversationId, BACKGROUND_CONTEXT).catch(
			() => undefined,
		);

		// abort 的提交会先把队列撤掉；等它完成（或超时）再把消息补回去
		let timer: NodeJS.Timeout | undefined;
		const aborted = await Promise.race([
			conversation.abort(BACKGROUND_CONTEXT).then(
				() => true,
				() => false,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), INTERRUPT_TIMEOUT_MS);
			}),
		]).finally(() => {
			if (timer !== undefined) clearTimeout(timer);
		});

		// 打断完成后落处置待办（ADR-026 决策 4/5）
		if (interrupted !== undefined) {
			await createDispositionPending(current(), interrupted).catch(() => undefined);
		}

		// 这条消息优先；其它被 abort 撤掉的排队消息也补回去，不能顺手吞掉。
		// 逐条保护（审计 B-02④：这里原先是与 interruptThenDeliver 同款的无保护循环）。
		const delivery = await deliverAll(conversation, [text, ...rest]);
		if (delivery.failed.length > 0) {
			await writeUndelivered(current(), conversationId, delivery.failed);
		}

		scheduleOrgPush();
		if (delivery.failed.includes(text)) {
			return fail(response, 503, "这条没投进去，请重发。");
		}
		return json(response, { ok: true, interrupted: aborted });
	}

	/** 拍板：回答一条待决问题。 */
	async function postAnswer(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson<{ key?: string; text?: string }>(request);
		const key = (body.key ?? "").trim();
		const text = (body.text ?? "").trim();
		if (key === "" || text === "") return fail(response, 400, "需要 key 与 text");

		// 老板只回答「CEO 报上来」的问题：owner 级以外的条目属于管理层授权范围，
		// 老板替他们拍板等于把决策责任揽到自己身上（也正是「待拍板太多」的根源）。
		const pending = await listPending(current(), BACKGROUND_CONTEXT);
		let item = pending.find((entry) => entry.key === key);

		// ADR-026 决策 5：「到期按暂搁执行，问题留在待办，事后可改」。
		// 超时默认结算掉的处置项已经从 listPending 里消失（它有 answer 了），
		// 但它是**机器代你选的**，人回来推翻必须还能答。所以这里再兜一次：
		// 只放行 `decidedBy === "timeout-default"` 的处置项，人自己答过的不许改。
		if (item === undefined) {
			const state = await current().harness.snapshot(PendingDoc, BACKGROUND_CONTEXT);
			item = state?.items.find(
				(entry) => entry.key === key && entry.disposition?.decidedBy === "timeout-default",
			);
		}
		if (item === undefined) return fail(response, 404, "没有这条待决问题（可能已被处理）");

		// 这个入口是老板专属（answeredBy 恒为 "owner"），所以先做层级守卫：
		// 不在 owner 级的问题一律不由老板拍。
		//
		// ADR-026 决策 1 的例外（审计 D-02）：**处置类**待办在 ceo 级时，老板也要能答。
		// 原因：系统里没有独立的老板会话，老板亲自派活写成的 `app.delegate.from` 就是 "CEO"
		// （实测真实库 56 条全是 CEO），所以「老板派的活」的处置待办 level 就是 `ceo`。
		// 如果不放这一级，老板被自己的活打断后，处置问题会进不了他的界面（forYou=false）、
		// 也答不了（409）——处置在老板这里完全不可达。
		// 注意只放**处置类**：普通待决问题依旧“老板只答 owner”，不让老板揽管理层的决策责任。
		const isOwnerDisposition = item.disposition !== undefined && item.level === "ceo";
		if (item.level !== "owner" && !isOwnerDisposition) {
			return fail(response, 409, "这条问题不在老板这一级，应由 CEO 或对应管理层拍板");
		}

		// 处置类待办（ADR-026 决策 4/5）：必须明确选「暂搁/放弃」，且暂搁必须带恢复条件。
		if (item.disposition !== undefined) {
			const settled = await settleDisposition(
				current(),
				{ key, answer: text, answeredBy: "owner" },
				BACKGROUND_CONTEXT,
			);
			if (!settled.ok) return fail(response, 400, settled.reason);
			scheduleOrgPush();
			return json(response, { ok: true, disposition: settled.disposition });
		}

		const ok = await answerPending(
			current(),
			{ key, answer: text, answeredBy: "owner" },
			BACKGROUND_CONTEXT,
		);
		scheduleOrgPush();
		return json(response, { ok });
	}

	const listenHost = host;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, listenHost, () => {
			server.off("error", reject);
			resolve();
		});
	});

	// 端口为 0 时由系统分配，必须读实际监听的端口
	const address = server.address();
	const actualPort = typeof address === "object" && address !== null ? address.port : port;

	return {
		url: `http://${listenHost}:${actualPort}/`,
		async close() {
			unsubscribeCommits?.();
			stopWatchdog();
			if (orgTimer !== undefined) clearTimeout(orgTimer);
			for (const client of orgClients) {
				try {
					client.end();
				} catch {
					/* 已断 */
				}
			}
			orgClients.clear();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				// 有 SSE 长连接时 close 不会立即回调
				setTimeout(resolve, 500);
			});
		},
	};
}

// ── 工具 ────────────────────────────────────────────────────────────────────

function json(response: ServerResponse, value: unknown): void {
	const payload = JSON.stringify(value);
	response.writeHead(200, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	response.end(payload);
}

function fail(response: ServerResponse, status: number, message: string): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify({ error: message }));
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return {} as T;
	return JSON.parse(text) as T;
}

/** 从排队项内容里取文本（与 feed 的 queued 展示保持一致）。 */
function queueText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.flatMap((part) => {
				if (typeof part === "string") return [part];
				if (typeof part !== "object" || part === null) return [];
				const record = part as { readonly type?: string; readonly text?: string };
				return record.type === "text" && record.text !== undefined ? [record.text] : [];
			})
			.join("");
	}
	if (typeof content === "object" && content !== null) {
		return (content as { readonly text?: string }).text ?? "";
	}
	return "";
}

/** 静态资源：限制在 uiDir 内，防目录穿越。 */
async function serveStatic(response: ServerResponse, uiDir: string, path: string): Promise<void> {
	const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
	const target = normalize(join(uiDir, relative));
	if (!target.startsWith(normalize(uiDir))) {
		return fail(response, 403, "禁止访问");
	}

	try {
		const content = await readFile(target);
		response.writeHead(200, {
			"Content-Type": MIME[extname(target)] ?? "application/octet-stream",
			"Cache-Control": "no-cache",
		});
		response.end(content);
	} catch {
		// SPA 回退：未知路径一律返回入口页
		try {
			const index = await readFile(join(uiDir, "index.html"));
			response.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
			response.end(index);
		} catch {
			fail(response, 404, "未找到");
		}
	}
}
