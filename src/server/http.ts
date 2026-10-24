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
import { BACKGROUND_CONTEXT, InboxDoc } from "../runtime/index.ts";
import type { CompanyRuntime } from "../runtime/index.ts";
import { answerPending, listPending } from "../company/escalation.ts";
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

/** 中断最多等 abort 多久；超时也必须先把消息排进去，不能把 HTTP 挂死。 */
const INTERRUPT_TIMEOUT_MS = 5_000;

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

		// ADR-026 决策 7.1：回执不经过模型。受理成功即写一条 app.receipt，
		// 模型失败/超时也必须看得见「收到了」——这条是系统写的，与生成结果无关。
		await writeReceipt(runtime, conversationId, text);

		// now 档：先打断当前轮，再把消息投进去（abort 会撤掉队列，所以中断后再 submit）。
		// step/turn 走原有的 whenBusy 语义。
		if (whenBusy === "now") {
			await interruptThenDeliver(runtime, conversation, conversationId, text);
		} else {
			await conversation.submit({ type: "input", content: text, whenBusy }, BACKGROUND_CONTEXT);
		}
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
	): Promise<void> {
		try {
			await runtime.harness.commit(async (tx) => {
				await tx.appendEntry(conversationId as never, {
					kind: "app.receipt",
					data: {
						text: text.slice(0, 280),
						from: "老板",
						timing: "now",
						at: Date.now(),
					},
				});
			}, BACKGROUND_CONTEXT);
		} catch {
			// 回执失败不影响受理
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
	): Promise<void> {
		const inbox = (await runtime.harness.snapshot(InboxDoc, conversationId as never, BACKGROUND_CONTEXT)) as
			| { items?: readonly { mode: string; content: unknown }[] }
			| undefined;
		const queued = (inbox?.items ?? [])
			.filter((item) => item.mode !== "write")
			.map((item) => queueText(item.content))
			.filter((item) => item !== "");

		// 已经不在队列里 = 没有正在跑的活要打断，直接投
		if (!queued.includes(text)) {
			await conversation.submit({ type: "input", content: text, whenBusy: "steer" }, BACKGROUND_CONTEXT);
			return;
		}

		const rest = queued.filter((item) => item !== text);

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

		// 这条优先；被 abort 撤掉的其它排队消息也补回去
		for (const item of [text, ...rest]) {
			await conversation.submit({ type: "input", content: item, whenBusy: "steer" }, BACKGROUND_CONTEXT);
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

		// 这条消息优先；其它被 abort 撤掉的排队消息也补回去，不能顺手吞掉
		for (const item of [text, ...rest]) {
			await conversation.submit(
				{ type: "input", content: item, whenBusy: "steer" },
				BACKGROUND_CONTEXT,
			);
		}

		scheduleOrgPush();
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
		const item = pending.find((entry) => entry.key === key);
		if (item === undefined) return fail(response, 404, "没有这条待决问题（可能已被处理）");
		if (item.level !== "owner") {
			return fail(response, 409, "这条问题不在老板这一级，应由 CEO 或对应管理层拍板");
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
