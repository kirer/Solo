/**
 * `task`：频道里的任务板。
 *
 * - `list` —— 谁在做什么：默认只列在做 / 卡住 / 待办，按负责人分组；
 * - `mine` —— 只看自己名下；
 * - `update` —— 改一条（状态 / 负责人 / 验收）：成员只在自己名下，划掉只有助理能；
 * - `add` —— 助理从一条消息补标：那句话够格当目标，才有资格进板。
 *
 * 两条纪律：
 * - **一次只落一件活**，任务本体和那条 `note` 交给 `commitTaskNote` 同一次 commit；
 * - **状态名是中文**（`task.status.*`）：模型看到的摘要里不该冒出 `blocked` 这种词，
 *   那是数据，不是给人看的话。
 */
import { BACKGROUND_CONTEXT, Type, defineTool, type Context } from "../../runtime/index.ts";
import { readAllIdentities, type Identity } from "../../documents/member/identity.ts";
import { isAssistantDir } from "../../layout.ts";
import { canCreate, checkMove, checkPermission, type PermissionRefusal } from "../task-rules.ts";
import { tasksOf, type ChannelState, type Task, type TaskHistoryEntry, type TaskStatus } from "../types.ts";
import { commitTaskNote, type TaskNotePlan } from "../write.ts";
import { defaultChannel } from "./channel-choice.ts";
import { actionOf, readState, selfOrError, text, type CoreToolDeps } from "./context.ts";
import { fill } from "../../documents/base/catalog.ts";

const ACTIONS = ["list", "mine", "update", "add"] as const;

const STATUSES: readonly TaskStatus[] = ["open", "doing", "blocked", "done", "dropped"];

/**
 * 板上「还算活着」的状态。`done` / `dropped` 不列：板是「现在要做什么」，
 * 翻旧账去看消息。
 */
const ON_BOARD: readonly TaskStatus[] = ["open", "doing", "blocked"];

/** 摘要里那条标题的上限。再长就把一行摘要撑成两行，模型反而看不清有哪几条。 */
const TITLE_LIMIT = 12;

const DAY = 86_400_000;

/**
 * 摘要里的标题：超过 12 字就截掉加 `…`。
 *
 * 按**字符**数而不是字节：中文一个字一个字符，按字节算会把一句正常的话截成半句。
 */
function clipTitle(title: string): string {
	const chars = Array.from(title.trim());
	return chars.length <= TITLE_LIMIT ? chars.join("") : `${chars.slice(0, TITLE_LIMIT).join("")}…`;
}

/**
 * 「多久没动」：离最后一次变更几天。
 *
 * 没有变更记录（刚建、还没落 note）或时间读不到，都算今天 —— 宁少报「没人管」，
 * 不要因为一次读不到就把一条活打成积压。
 */
function silentOf(at: number, now: number): string {
	if (at <= 0) return "今天";
	const days = Math.floor((now - at) / DAY);
	return days <= 0 ? "今天" : `${days} 天`;
}

/** 一次变更落在哪条消息上：`history` 最后一格是索引，时间要去消息里读。 */
function changedAtOf(state: ChannelState, task: Task): number {
	const last = task.history[task.history.length - 1];
	if (last === undefined) return 0;
	const message = (state.messages[task.channelId] ?? []).find((item) => item.seq === last.seq);
	return message?.at ?? 0;
}

type Row = { readonly task: Task; readonly changedAt: number };

/**
 * 板上的条目：跨频道汇总，只留活着的状态。
 *
 * 为什么不按频道分开列：人问「现在谁在做什么」，答案是一张单子，不是七个频道各自的单子。
 * 频道只在权限那一层起作用 —— 看不到的频道，它的任务也不该出现在你面前。
 */
function boardOf(state: ChannelState, visible: readonly string[], owner?: string): Row[] {
	const rows: Row[] = [];
	for (const channelId of visible) {
		const table = tasksOf(state, channelId);
		for (const id of Object.keys(table).sort()) {
			const task = table[id];
			if (task === undefined || !ON_BOARD.includes(task.status)) continue;
			if (owner !== undefined && task.owner !== owner) continue;
			rows.push({ task, changedAt: changedAtOf(state, task) });
		}
	}
	// 按负责人分组（行里已经带了负责人，所以分组就是排序），同一个人名下按 id 排。
	rows.sort((a, b) =>
		a.task.owner === b.task.owner ? a.task.id.localeCompare(b.task.id) : a.task.owner.localeCompare(b.task.owner),
	);
	return rows;
}

export function createTaskTool(deps: CoreToolDeps) {
	const t = (key: string, slots: Record<string, string | number | undefined> = {}): string =>
		fill(deps.text, key, slots);

	const statusName = (status: TaskStatus): string => t(`task.status.${status}`) || status;

	/** 谁在板上的显示名：名册里没有这个人（离职、改名）也要说清楚，别把 slug 摆上来。 */
	const ownerLabel = (owner: string, roster: readonly Identity[]): string =>
		roster.some((identity) => identity.slug === owner) ? owner : t("task.list.owner");

	/** 输入里的 `owner` 解成 slug：认 slug，也认名字（人写的是名字）。 */
	const resolveOwner = (raw: string, roster: readonly Identity[]): string | undefined => {
		const wanted = raw.trim().replace(/^@/, "");
		const hit = roster.find((identity) => identity.slug === wanted || identity.name === wanted);
		return hit?.slug;
	};

	const tool = defineTool({
		name: "task",
		description: t("task.description"),
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: t("task.param.action") })),
			id: Type.Optional(Type.String({ description: t("task.param.id") })),
			status: Type.Optional(Type.String({ description: t("task.param.status") })),
			note: Type.Optional(Type.String({ description: t("task.param.note") })),
			title: Type.Optional(Type.String({ description: t("task.param.title") })),
			accept: Type.Optional(Type.String({ description: t("task.param.accept") })),
			from: Type.Optional(Type.Number({ description: t("task.param.from") })),
			owner: Type.Optional(Type.String({ description: t("task.param.owner") })),
		}),
		execute: async (args, api, context) => {
			const ctx: Context = context ?? BACKGROUND_CONTEXT;
			const conversationId = Number(api.conversationId);
			const slug = await selfOrError(deps, conversationId, ctx);
			if (typeof slug !== "string") return text(slug);
			const action = actionOf(args.action, ACTIONS, "list", "action", deps.text);
			if (typeof action !== "string") return text(action);

			const state = await readState(deps);
			const all = await readAllIdentities(deps.layout.agentRoots);
			const self = all.find((identity) => identity.slug === slug);
			const actor = { slug, assistant: self !== undefined && isAssistantDir(deps.layout, self.dir) };
			// 能看到哪些频道：助理看全部，成员只看自己在的（私聊里也有活）。
			const visible = Object.keys(state.channels)
				.filter((id) => actor.assistant || state.channels[id]?.members.includes(slug) === true)
				.sort();
			const now = Date.now();

			/** 拒绝话术：规矩层的 why 到人话。四种权限拒法分开说，因为下一步不一样。 */
			const refusal = (why: PermissionRefusal, task: Task | undefined): string => {
				const id = task?.id ?? "";
				const owner = task?.owner ?? "";
				if (why === "assign") return t("task.refuse.assign", { id, owner });
				if (why === "dropped") return t("task.refuse.member.dropped");
				if (why === "add") return t("task.refuse.member.add");
				const assistant = all.filter((identity) => isAssistantDir(deps.layout, identity.dir)).map((i) => i.slug);
				return t("task.refuse.member.other", { id, assistant: assistant.join(" / ") });
			};

			if (action === "list" || action === "mine") {
				const mine = action === "mine";
				const rows = boardOf(state, visible, mine ? slug : undefined);
				const blocked = rows.filter((row) => row.task.status === "blocked");
				const total = rows.length;
				const doing = rows.filter((row) => row.task.status === "doing").length;
				// 摘要：**只带一条**最近卡住的，多的不列 —— 摘要的用处是「要不要去看」。
				const latest = blocked.reduce<Row | undefined>(
					(pick, row) => (pick === undefined || row.changedAt > pick.changedAt ? row : pick),
					undefined,
				);
				const header = mine
					? blocked.length === 0
						? t("task.mine.header.calm", { total, doing })
						: t("task.mine.header", { total, doing, blocked: blocked.length })
					: blocked.length === 0 || latest === undefined
						? t("task.list.header.calm", { total })
						: t("task.list.header", { total, blocked: blocked.length, title: clipTitle(latest.task.title) });
				if (rows.length === 0) return text([header, t("task.list.empty")].filter((line) => line !== "").join("\n"));
				const lines = rows.map((row) =>
					t("task.list.line", {
						id: row.task.id,
						status: statusName(row.task.status),
						owner: ownerLabel(row.task.owner, all),
						title: row.task.title,
						silent: silentOf(row.changedAt, now),
						// 「有目标、没有验收」要看得见：门槛是判断，没人念就没人知道 —— 这里兜一句。
						missing: (row.task.accept ?? "").trim() === "" ? t("task.list.no-accept") : "",
					}),
				);
				const footer = mine ? "" : t("task.list.footer");
				return text([header, ...lines, footer].filter((line) => line !== "").join("\n"));
			}

			// 改 / 建都要落在**一个**频道上：默认就是这一轮被叫醒的那个（和 `say` 同一套）。
			const target = await defaultChannel(deps, state, slug, conversationId, undefined, ctx);
			if ("error" in target) return text(target);
			const channelId = target.channelId;
			const channelTitle = state.channels[channelId]?.title ?? channelId;

			if (action === "add") {
				if (!canCreate(actor).ok) return text(refusal("add", undefined));
				const from = args.from;
				const title = (args.title ?? "").trim();
				const ownerRaw = (args.owner ?? "").trim();
				if (from === undefined || title === "" || ownerRaw === "") return text(t("task.refuse.add"));
				const owner = resolveOwner(ownerRaw, all);
				if (owner === undefined) return text(t("task.refuse.add"));
				const origin = (state.messages[channelId] ?? []).find((item) => item.seq === from);
				if (origin === undefined) return text(t("task.refuse.from", { channel: channelTitle, seq: from }));
				// 同一句话、同一个负责人只建一条：重复补标只会让板变成回声壁。
				const dup = Object.values(tasksOf(state, channelId)).find(
					(task) => task.originSeq === from && task.owner === owner,
				);
				if (dup !== undefined) return text(t("task.refuse.dup", { id: dup.id }));
				const accept = (args.accept ?? "").trim();
				const result = await commitTaskNote(
					{ harness: deps.harness },
					{
						channelId,
						at: now,
						plan: (current, _attempt, id): TaskNotePlan => {
							// 新建时 `current` 一定是 undefined（没给 id）；给了就是有人同时建了同号，放弃。
							if (current !== undefined) return { refuse: t("task.refuse.dup", { id }) };
							const created: Task = {
								id,
								title,
								owner,
								...(accept === "" ? {} : { accept }),
								status: "open",
								channelId,
								originSeq: from,
								history: [],
							};
							return { task: created, what: "created", text: `${id}：建了一条：${title}` };
						},
					},
					ctx,
				);
				if (!result.ok) return text(result.message);
				return text(t("task.add.done", { id: result.task.id, owner: result.task.owner, title: result.task.title }));
			}

			// update
			const id = (args.id ?? "").trim();
			if (id === "") return text(t("task.param.id"));
			const statusRaw = (args.status ?? "").trim();
			const ownerRaw = (args.owner ?? "").trim();
			const acceptRaw = (args.accept ?? "").trim();
			const said = (args.note ?? "").trim();
			if (statusRaw === "" && ownerRaw === "" && acceptRaw === "") return text(t("task.param.status"));
			if (statusRaw !== "" && !STATUSES.includes(statusRaw as TaskStatus)) return text(t("task.refuse.status"));
			const to = statusRaw === "" ? undefined : (statusRaw as TaskStatus);
			const snapshot = tasksOf(state, channelId)[id];

			const result = await commitTaskNote(
				{ harness: deps.harness },
				{
					channelId,
					at: now,
					id,
					// 并发凭据：我读到的 `history` 长度。盘上变了就按新状态重算（`plan` 是纯的）。
					...(snapshot === undefined ? {} : { expectHistoryLength: snapshot.history.length }),
					plan: (current, _attempt, _id): TaskNotePlan => {
						if (current === undefined) return { refuse: t("task.refuse.id", { id }) };
						const next: Task = { ...current };
						const done: string[] = [];
						let what: TaskHistoryEntry["what"] = "status";
						if (ownerRaw !== "") {
							const owner = resolveOwner(ownerRaw, all);
							if (owner !== undefined && owner !== current.owner) {
								const allowed = checkPermission(actor, current, { kind: "owner", owner });
								if (!allowed.ok) return { refuse: refusal(allowed.why, current) };
								next.owner = owner;
								what = "assigned";
								done.push(`改派给 ${owner}`);
							}
						}
						if (acceptRaw !== "" && acceptRaw !== (current.accept ?? "")) {
							const allowed = checkPermission(actor, current, { kind: "accept", accept: acceptRaw });
							if (!allowed.ok) return { refuse: refusal(allowed.why, current) };
							next.accept = acceptRaw;
							if (done.length === 0) what = "accept";
							done.push(`验收：${acceptRaw}`);
						}
						if (to !== undefined) {
							const allowed = checkPermission(actor, current, { kind: "status", to });
							if (!allowed.ok) return { refuse: refusal(allowed.why, current) };
							const move = checkMove(current.status, to, said);
							if (!move.ok) {
								if (move.why === "same") {
									return { refuse: t("task.refuse.move.same", { id, status: statusName(to) }) };
								}
								if (move.why === "terminal") {
									return {
										refuse: t("task.refuse.move.terminal", {
											id,
											status: statusName(current.status),
										}),
									};
								}
								if (move.why === "note") return { refuse: t("task.refuse.note") };
								return {
									refuse: t("task.refuse.move.invalid", {
										id,
										from: statusName(current.status),
										to: statusName(to),
									}),
								};
							}
							next.status = to;
							if (done.length === 0) what = "status";
							done.push(`改成${statusName(to)}`);
						}
						if (done.length === 0) return { refuse: t("task.refuse.move.same", { id, status: statusName(current.status) }) };
						const body = `${id}：${done.join("；")}${said === "" ? "" : `：${said}`}`;
						return { task: next, what, text: body };
					},
				},
				ctx,
			);
			if (!result.ok) return text(result.reason === "missing" ? t("task.refuse.id", { id }) : result.message);
			return text(t("task.update.done", { id: result.task.id, status: statusName(result.task.status) }));
		},
	});
	return tool;
}
