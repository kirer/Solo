/**
 * 通用工具：每个 agent 都有（`say` / `ask` / `read_channel` / `inbox` /
 * `task_list` / `task_update` / `whoami`）。
 *
 * 设计见 `docs/design/COMMS-REFACTOR.md` §4.2。三条原则：
 *
 * 1. **`say` 与 `ask` 分开**：`ask` 是「我在等你的回答」，会触发投递与超时升级；
 *    `say` 只是「说一句」，不唤醒任何人（除非有 @）。合并成一个工具会让模型
 *    分不清「通知」与「提问」，于是什么都用 ask，成本爆炸。
 *
 * 2. **`task_update` 必须带证据**：报 done 而不给 evidence 会被拒绝并提示。
 *    这是「不上报」问题的第二道防线（第一道是 `transitionTask` 的系统上报）。
 *
 * 3. **`read_channel` 是上下文入口**：投递给 agent 的消息只有摘要，完整历史靠它拉。
 */
import { BACKGROUND_CONTEXT, defineTool, Type, type CompanyRuntime, type Context } from "../../runtime/index.ts";
import {
	advanceRead,
	digestFor,
	hasMember,
	oneLine,
	projectChannelId,
	type Channel,
	type ChannelMessage,
	type ChannelState,
} from "../../domain/channels.ts";
import { labelOf, personOf, type Org } from "../../domain/membership.ts";
import { isTerminal, type TaskEntry } from "../../domain/tasks.ts";
import { postToChannel, readChannels, markChannelRead, markAllRead } from "../channels.ts";
import { buildOrg } from "../org-model.ts";
import { CompanyDoc } from "../docs.ts";
import { listMyTasks, transitionTask, readTasks } from "../tasks.ts";
import { TASK_PRIORITIES, TASK_STATUSES, type TaskStatus } from "../../domain/tasks.ts";

/** 通用工具的依赖。 */
export type UniversalDeps = {
	readonly runtime: CompanyRuntime;
};

/** 文本结果（工具返回给模型的东西必须是自然语言）。 */
function text(value: string) {
	return { output: [{ type: "text" as const, text: value }] };
}

/** 当前会话在组织里的信息。 */
async function contextOf(runtime: CompanyRuntime, conversationId: number, context: Context) {
	const company = await runtime.harness.snapshot(CompanyDoc, context);
	const org = buildOrg(company);
	const channels = await readChannels(runtime, context);
	return { company, org, channels };
}

/** 这个人能看到 / 所在的频道。 */
function myChannels(org: Org, channels: ChannelState, conversationId: number): readonly Channel[] {
	return Object.values(channels.channels).filter(
		(channel) => channel.archived !== true && hasMember(channel, conversationId),
	);
}

/**
 * 解析「在哪个频道发言」。
 *
 * 优先用显式 `channelId`；没给时按会话类型推断：
 * - 员工 / 负责人 → 本项目群（没有项目就用个人记录）
 * - 管理层 → 领导层群
 * - CEO → 公司大群
 */
function resolveChannel(
	org: Org,
	channels: ChannelState,
	conversationId: number,
	explicit: string | undefined,
): Channel | undefined {
	if (explicit !== undefined && explicit !== "") {
		const channel = channels.channels[explicit];
		return channel !== undefined && hasMember(channel, conversationId) ? channel : undefined;
	}
	const person = personOf(org, conversationId);
	if (person?.project !== undefined) {
		const id = projectChannelId(person.project);
		const channel = channels.channels[id];
		if (channel !== undefined) return channel;
	}
	if (person?.role === "leader" || person?.role === "management") {
		const leadership = channels.channels.leadership;
		if (leadership !== undefined && hasMember(leadership, conversationId)) return leadership;
	}
	const company = channels.channels.company;
	if (company !== undefined && hasMember(company, conversationId)) return company;
	return channels.channels[`log:${conversationId}`];
}

/** 把 @ 的名字解析成会话标识。 */
function resolveMentions(
	org: Org,
	channel: Channel,
	conversationId: number,
	names: readonly string[],
): { readonly ids: number[]; readonly unknown: string[] } {
	const ids: number[] = [];
	const unknown: string[] = [];
	for (const raw of names) {
		const name = raw.trim().replace(/^@/, "");
		if (name === "") continue;
		// 支持 "@负责人" 这种角色引用
		if (name === "负责人" || name === "leader") {
			const leader = channel.project === undefined ? undefined : org.projectLeaders[channel.project];
			if (leader !== undefined && leader !== conversationId) ids.push(leader);
			continue;
		}
		if (name === "老板" || name === "owner") {
			ids.push(0);
			continue;
		}
		const person = org.people.find(
			(entry) => entry.conversationId !== conversationId && (entry.label === name || entry.label.includes(name)),
		);
		if (person === undefined) unknown.push(name);
		else ids.push(person.conversationId);
	}
	return { ids: [...new Set(ids)], unknown };
}

/**
 * 渲染一条消息（给 read_channel 与 inbox）。
 *
 * `maxText` 是**正文截断上限**，默认不截断。
 *
 * 曾经这里硬编码 `oneLine(text, 300)`，后果很严重：负责人在群里发了一份 1069 字的
 * 「N5 采样规范」共 9 条，QA 用 read_channel 只读到前 4 条就被截断，于是它按自己猜的
 * 口径开始跑测试，还在群里说「我这边被截断了，请补一下」。整条验收链因此建立在
 * 一份残缺的规范上。
 *
 * 教训：`read_channel` 是 agent **主动**要求看历史的动作，它明确知道自己在花上下文。
 * 工具不该替它决定「这段不重要」——尤其不能用一个 300 字的固定阈值去截断
 * 「规范/契约/验收标准」这类必须逐字执行的文本。
 * 需要短的地方（inbox 的 @ 提醒）自己传 `maxText`。
 */
function renderMessage(org: Org, message: ChannelMessage, maxText?: number): string {
	const time = new Date(message.at).toISOString().slice(11, 16);
	const mentions = message.mentions.length === 0 ? "" : ` @${message.mentions.map((id) => labelOf(org, id)).join("、")}`;
	const body = maxText === undefined ? message.text : oneLine(message.text, maxText);
	const truncated = maxText !== undefined && message.text.length > maxText ? `
（以上为节选，原文 ${message.text.length} 字，用 read_channel 看全文）` : "";
	return `#${message.seq} ${time} ${message.fromLabel}${mentions}：${body}${truncated}`;
}

/** 渲染任务一行。 */
export function renderTaskLine(org: Org, task: TaskEntry): string {
	const assignee = labelOf(org, task.assignee);
	const flags = [
		task.status,
		`负责人 ${assignee}`,
		task.priority === "normal" ? "" : `优先级 ${task.priority}`,
		task.blockedReason === undefined ? "" : `阻塞：${task.blockedReason}`,
	]
		.filter((part) => part !== "")
		.join(" · ");
	return `${task.id} [${flags}] ${task.title}${task.evidence === undefined ? "" : `（证据：${oneLine(task.evidence, 60)}）`}`;
}

/** 创建全部通用工具。 */
export function createUniversalTools(deps: UniversalDeps) {
	const { runtime } = deps;

	const whoami = defineTool({
		name: "whoami",
		description: "查看你是谁：名字、角色、直属上级、下属、所在频道、手上任务数。回答身份相关问题前先调用它。",
		parameters: Type.Object({}),
		execute: async (_args, api, context) => {
			const conversationId = Number(api.conversationId);
			const { org, channels } = await contextOf(runtime, conversationId, context ?? BACKGROUND_CONTEXT);
			const me = personOf(org, conversationId);
			const label = labelOf(org, conversationId);
			const manager = me?.managerId === undefined ? "（无）" : labelOf(org, me.managerId);
			const reports = org.people.filter((person) => person.managerId === conversationId);
			const my = await listMyTasks(runtime, conversationId, context ?? BACKGROUND_CONTEXT);
			const open = my.filter((task) => !isTerminal(task.status));
			const channelsOfMine = myChannels(org, channels, conversationId);
			const digest = digestFor(channels, conversationId, 5);

			return text(
				[
					`你是 ${label}（${me?.role ?? "未知"}）。`,
					me?.project === undefined ? "" : `所在项目：${me.project}`,
					`直属上级：${manager}`,
					reports.length === 0 ? "" : `直接下属：${reports.map((person) => person.label).join("、")}`,
					`手上未完成任务：${open.length} 个${open.length === 0 ? "" : `（${open.map((task) => task.id).join("、")}）`}`,
					`你所在的频道：${channelsOfMine.map((channel) => channel.id).join("、")}`,
					digest.length === 0
						? "没有未读消息。"
						: `未读：${digest.map((item) => `${item.title} ${item.unread} 条${item.mentions > 0 ? `（${item.mentions} 条 @你）` : ""}`).join("；")}`,
				]
					.filter((line) => line !== "")
					.join("\n"),
			);
		},
	});

	const say = defineTool({
		name: "say",
		description: [
			"在当前频道发言。正文里写了 @某人 就会唤醒对方；不写 @ 就不唤醒任何人。",
			"用于：汇报进展、陈述结论、记录决策、同步信息。",
			"如果是要请别人回答或行动，用 ask（语义更明确，会带上「我在等你回答」并触发超时升级）。",
		].join(""),
		parameters: Type.Object({
			text: Type.String({ description: "要说的内容" }),
			channel: Type.Optional(
				Type.String({ description: "频道标识（company / leadership / proj:slug / dm:编号 / log:编号）。不填则用你默认的频道。" }),
			),
		}),
		execute: async (args, api, context) => {
			const conversationId = Number(api.conversationId);
			const ctx = context ?? BACKGROUND_CONTEXT;
			const { org, channels } = await contextOf(runtime, conversationId, ctx);
			const channel = resolveChannel(org, channels, conversationId, args.channel);
			if (channel === undefined) return text("找不到可用的频道。先用 whoami 看你在哪些频道里。");

			const posted = await postToChannel(
				runtime,
				channel.id,
				{
					from: conversationId,
					fromLabel: labelOf(org, conversationId),
					kind: "chat",
					text: args.text,
				},
				{ context: ctx },
			);
			return text(
				`已发到「${channel.title}」（#${posted.message.seq}）。${
					posted.delivery === undefined || posted.delivery.delivered.length === 0
						? "没有唤醒任何人（正文里没有 @ 到本频道的人）。"
						: `已通知：${posted.delivery.delivered.map((id) => labelOf(org, id)).join("、")}。`
				}`,
			);
		},
	});

	const ask = defineTool({
		name: "ask",
		description: [
			"在当前频道提问并 @ 某人（会立刻唤醒对方）。",
			"用于：需求不清楚、需要别人拍板、要别人提供信息。",
			"**不确定就先问，不要猜**——猜错的代价比问一句高得多。",
			"对方 10 分钟没回复会自动升级到上一级。",
		].join(""),
		parameters: Type.Object({
			text: Type.String({ description: "要问的问题，包含必要背景" }),
			mention: Type.Optional(
				Type.String({
					description: "要问谁：人名、岗位名（CTO/CHRO…）、负责人、或 leader。不填则问你的直属上级。",
				}),
			),
			channel: Type.Optional(Type.String({ description: "频道标识，不填用默认频道" })),
		}),
		execute: async (args, api, context) => {
			const conversationId = Number(api.conversationId);
			const ctx = context ?? BACKGROUND_CONTEXT;
			const { org, channels } = await contextOf(runtime, conversationId, ctx);
			const channel = resolveChannel(org, channels, conversationId, args.channel);
			if (channel === undefined) return text("找不到可用的频道。先用 whoami 看你在哪些频道里。");

			// 默认问直属上级
			const me = personOf(org, conversationId);
			const target = args.mention ?? (me?.managerId === undefined ? undefined : labelOf(org, me.managerId));
			if (target === undefined) {
				return text("不知道要问谁：你没有直属上级，请显式指定 mention（人名或岗位名）。");
			}
			const { ids, unknown } = resolveMentions(org, channel, conversationId, [target]);
			if (ids.length === 0) {
				const available = Object.values(channel.members)
					.map((member) => labelOf(org, member.conversationId))
					.join("、");
				return text(
					`频道「${channel.title}」里找不到「${target}」。${unknown.length > 0 ? "" : ""}可 @ 的人：${available}。`,
				);
			}

			const posted = await postToChannel(
				runtime,
				channel.id,
				{
					from: conversationId,
					fromLabel: labelOf(org, conversationId),
					kind: "question",
					text: args.text,
					mentions: ids,
				},
				{ context: ctx },
			);
			const names = ids.map((id) => labelOf(org, id)).join("、");
			return text(
				[
					`已问 ${names}（${channel.title} #${posted.message.seq}）。`,
					"对方已被唤醒，会尽快回复。你可以继续做别的事，不要在这里等。",
					"如果 10 分钟内没有回复，系统会自动升级到上一级并提醒。",
				].join(""),
			);
		},
	});

	const readChannelTool = defineTool({
		name: "read_channel",
		description: [
			"读一个频道的历史消息。",
			"投递给你的消息只有摘要，需要完整上下文（谁说了什么、之前怎么定的）时用这个。",
			"读到会自动标记已读。",
		].join(""),
		parameters: Type.Object({
			channel: Type.Optional(Type.String({ description: "频道标识，不填用默认频道" })),
			limit: Type.Optional(Type.Number({ description: "最多读多少条（默认 30，最多 100）" })),
			since: Type.Optional(Type.Number({ description: "只读这个 seq 之后的消息" })),
		}),
		execute: async (args, api, context) => {
			const conversationId = Number(api.conversationId);
			const ctx = context ?? BACKGROUND_CONTEXT;
			const { org, channels } = await contextOf(runtime, conversationId, ctx);
			const channel = resolveChannel(org, channels, conversationId, args.channel);
			if (channel === undefined) return text("找不到可用的频道。");

			const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
			const since = args.since ?? 0;
			const messages = channel.messages.filter((message) => message.seq > since).slice(-limit);
			if (messages.length === 0) {
				return text(`「${channel.title}」里${since > 0 ? ` #${since} 之后` : ""}没有消息。`);
			}

			// 正文不截断（见 renderMessage 的说明），但整个返回值要有预算上限，
			// 否则一个刷了几百条的群会把上下文一次打满。超预算时**从最旧的开始丢**，
			// 并明确说「这几条没显示」，让模型自己决定要不要 since= 往前翻。
			const BUDGET = 24_000;
			const rendered = messages.map((message) => renderMessage(org, message));
			let start = 0;
			let total = rendered.reduce((sum, line) => sum + line.length, 0);
			while (total > BUDGET && start < rendered.length - 1) {
				total -= rendered[start]!.length;
				start += 1;
			}
			const shown = messages.slice(start);
			const shownLines = rendered.slice(start);
			const dropped = start;

			// **只把读位置推到真正看到的最后一条**。
			// 曾经的写法是 markAllRead（推到 channel.lastSeq）——只读 1 条也会把
			// 后面所有消息标记成已读，未读摘要里就再也不出现，等于静默丢消息。
			const lastShown = shown[shown.length - 1];
			if (lastShown !== undefined) {
				await markChannelRead(runtime, channel.id, conversationId, lastShown.seq, ctx);
			}

			return text(
				[
					dropped > 0
						? `「${channel.title}」最近 ${shown.length} 条（共 ${channel.lastSeq} 条；因篇幅省略了更早的 ${dropped} 条，用 since= 往前翻）：`
						: `「${channel.title}」最近 ${shown.length} 条（共 ${channel.lastSeq} 条）：`,
					...shownLines,
					"",
					`（已标记到 #${lastShown?.seq} 为已读。继续读更早的用 since=${shown[0]?.seq}）`,
				].join("\n"),
			);
		},
	});

	const inbox = defineTool({
		name: "inbox",
		description: "查看你未读的消息（按频道汇总）与 @ 你的问题。",
		parameters: Type.Object({}),
		execute: async (_args, api, context) => {
			const conversationId = Number(api.conversationId);
			const ctx = context ?? BACKGROUND_CONTEXT;
			const { org, channels } = await contextOf(runtime, conversationId, ctx);
			const digest = digestFor(channels, conversationId, 10);
			if (digest.length === 0) return text("没有未读消息。");

			const mentions: string[] = [];
			for (const channel of Object.values(channels.channels)) {
				if (!hasMember(channel, conversationId)) continue;
				const read = channel.members[String(conversationId)]?.lastReadSeq ?? 0;
				for (const message of channel.messages) {
					if (message.seq <= read) continue;
					if (!message.mentions.includes(conversationId)) continue;
					if (message.from === conversationId) continue;
					// inbox 是「扫一眼有哪些 @ 我」，不需要全文；要看全文它自己 read_channel
					mentions.push(`「${channel.title}」${renderMessage(org, message, 400)}`);
				}
			}

			return text(
				[
					`你有 ${digest.reduce((sum, item) => sum + item.unread, 0)} 条未读：`,
					...digest.map(
						(item) =>
							`- ${item.title}：${item.unread} 条${item.mentions > 0 ? `（${item.mentions} 条 @你）` : ""} — ${item.preview}`,
					),
					...(mentions.length === 0 ? [] : ["", "@ 你的（优先回）：", ...mentions.slice(-10)]),
					"",
					"（用 read_channel 看完整内容并标记已读）",
				].join("\n"),
			);
		},
	});

	const taskList = defineTool({
		name: "task_list",
		description: "查看任务：默认只看你自己的未完成任务；可指定 project 看整个项目，或 all 看全部。",
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "项目 slug" })),
			mine: Type.Optional(Type.Boolean({ description: "只看自己的（默认 true）" })),
			all: Type.Optional(Type.Boolean({ description: "看全部（含已完成）" })),
		}),
		execute: async (args, api, context) => {
			const conversationId = Number(api.conversationId);
			const ctx = context ?? BACKGROUND_CONTEXT;
			const { org } = await contextOf(runtime, conversationId, ctx);
			const state = await readTasks(runtime, ctx);
			let tasks = Object.values(state.tasks);
			if (args.project !== undefined) tasks = tasks.filter((task) => task.project === args.project);
			else if (args.mine !== false) tasks = tasks.filter((task) => task.assignee === conversationId);
			if (args.all !== true) tasks = tasks.filter((task) => !isTerminal(task.status));

			if (tasks.length === 0) return text("没有符合条件的任务。");
			tasks.sort((left, right) => left.createdAt - right.createdAt);
			return text(
				[
					`共 ${tasks.length} 个任务：`,
					...tasks.map((task) => renderTaskLine(org, task)),
					"",
					"（用 task_update 报进度 / 完成；完成必须带 evidence）",
				].join("\n"),
			);
		},
	});

	const taskUpdate = defineTool({
		name: "task_update",
		description: [
			"更新任务状态或记一条进度。",
			"状态流转：todo → doing → review/done；doing → blocked（阻塞）。",
			"报 done 必须带 evidence（文件路径、测试输出、提交号）——没有证据的完成会被拒绝。",
			"状态变化会自动上报给下达人，你不需要另外发消息。",
		].join(""),
		parameters: Type.Object({
			task: Type.String({ description: "任务标识，例如 T-3" }),
			status: Type.Optional(
				Type.Union(
					TASK_STATUSES.map((status: TaskStatus) => Type.Literal(status)),
					{ description: "目标状态。不填则只记一条进度。" },
				),
			),
			note: Type.Optional(Type.String({ description: "进度说明" })),
			evidence: Type.Optional(Type.String({ description: "完成证据（status=done 时必填）" })),
			blockedReason: Type.Optional(Type.String({ description: "阻塞原因（status=blocked 时必填）" })),
		}),
		execute: async (args, api, context) => {
			const conversationId = Number(api.conversationId);
			const ctx = context ?? BACKGROUND_CONTEXT;

			if (args.status === "done" && (args.evidence ?? "").trim() === "") {
				return text(
					[
						`任务 ${args.task} 不能这样报完成：缺少 evidence。`,
						"请提供可验证的证据，例如：",
						"- 文件路径（src/login.ts 第 40-60 行）",
						"- 测试输出（npm test → 32 passed）",
						"- 提交号（a1b2c3d）",
						"没有证据的完成等于没做完——负责人看不到证据会退回。",
					].join("\n"),
				);
			}
			if (args.status === "blocked" && (args.blockedReason ?? "").trim() === "") {
				return text(`任务 ${args.task} 报阻塞时必须给 blockedReason（卡在哪、等谁）。`);
			}

			const status = args.status as TaskStatus | undefined;
			if (status === undefined) {
				// 只记进度：用当前状态再迁移一次（幂等 + note）
				const state = await readTasks(runtime, ctx);
				const task = state.tasks[args.task];
				if (task === undefined) return text(`任务不存在：${args.task}。用 task_list 看你的任务。`);
				const result = await transitionTask(
					runtime,
					args.task,
					task.status,
					{ ...(args.note === undefined ? {} : { note: args.note }), by: conversationId },
					ctx,
				);
				return text(result.ok ? `已记进度：${args.task}。` : `更新失败：${result.message}`);
			}

			const result = await transitionTask(
				runtime,
				args.task,
				status,
				{
					...(args.note === undefined ? {} : { note: args.note }),
					...(args.evidence === undefined ? {} : { evidence: args.evidence }),
					...(args.blockedReason === undefined ? {} : { blockedReason: args.blockedReason }),
					by: conversationId,
				},
				ctx,
			);
			if (!result.ok) return text(`更新失败：${result.message}`);
			return text(
				[
					`${args.task} → ${status}。`,
					result.reported ? "已自动上报给下达人，不需要另外发消息。" : "",
				]
					.filter((line) => line !== "")
					.join(""),
			);
		},
	});

	const taskCreate = defineTool({
		name: "task_create",
		description: [
			"给某人创建一个任务。**必须有验收标准（acceptance）**，否则不是任务。",
			"只是让对方「看一下 / 讨论一下」不要用这个——在频道里用 ask。",
			"验收标准要可验证：说清「做到什么算做完」，不要写「做好一点」。",
			"创建后会自动通知负责人，你不用等它做完。",
		].join(""),
		parameters: Type.Object({
			project: Type.String({ description: "项目 slug" }),
			title: Type.String({ description: "一句话标题" }),
			acceptance: Type.String({ description: "验收标准：做到什么算做完（必须可验证）" }),
			assignee: Type.String({ description: "负责人：人名（必须与名册一致）" }),
			brief: Type.Optional(Type.String({ description: "任务背景与具体要求" })),
			priority: Type.Optional(
				Type.Union(TASK_PRIORITIES.map((priority: (typeof TASK_PRIORITIES)[number]) => Type.Literal(priority)), { description: "优先级，默认 normal" }),
			),
			channel: Type.Optional(Type.String({ description: "在哪个频道讨论，默认项目群" })),
		}),
		execute: async (args, api, context) => {
			const conversationId = Number(api.conversationId);
			const ctx = context ?? BACKGROUND_CONTEXT;
			const { org } = await contextOf(runtime, conversationId, ctx);

			const person = org.people.find((entry) => entry.label === args.assignee || entry.label.includes(args.assignee));
			if (person === undefined) {
				const candidates = org.people
					.filter((entry) => entry.project === args.project)
					.map((entry) => entry.label);
				return text(
					`找不到「${args.assignee}」。项目 ${args.project} 里的人：${candidates.length === 0 ? "（无）" : candidates.join("、")}。`,
				);
			}

			const { createTask } = await import("../tasks.ts");
			const result = await createTask(
				runtime,
				{
					project: args.project,
					channelId: args.channel ?? projectChannelId(args.project),
					title: args.title,
					brief: args.brief ?? "",
					acceptance: args.acceptance,
					assignee: person.conversationId,
					assignedBy: conversationId,
					...(args.priority === undefined ? {} : { priority: args.priority }),
				},
				ctx,
			);
			if (!result.ok) return text(result.message);
			return text(
				[
					`已创建任务 ${result.task.id}：${result.task.title}`,
					`负责人：${labelOf(org, result.task.assignee)}（已通知，它会自己开始）。`,
					`验收标准：${result.task.acceptance}`,
					"任务完成或阻塞时你会自动收到上报。现在可以继续做别的事，不要等。",
				].join("\n"),
			);
		},
	});

	return {
		whoami,
		say,
		ask,
		readChannel: readChannelTool,
		inbox,
		taskList,
		taskUpdate,
		taskCreate,
	};
}

/** 通用工具集类型。 */
export type UniversalToolset = ReturnType<typeof createUniversalTools>;

/** 供能力目录使用的工具名。 */
export const UNIVERSAL_TOOL_NAMES = [
	"whoami",
	"say",
	"ask",
	"read_channel",
	"inbox",
	"task_list",
	"task_update",
] as const;
