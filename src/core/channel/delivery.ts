/**
 * 投递正文：把「谁在什么频道里叫了你、这一轮该怎么回」拼成一段话。
 *
 * 文案全部来自 `prompt/*.md`，这里只做三件机械的事：
 * 1. 按条件**选**片段（只有你 / 还有别人 / 有同事 / 私聊 / 多人 / 未读 / 合并唤醒）；
 * 2. 把名字、数量、频道标题填进插槽；
 * 3. 按固定顺序拼起来。
 *
 * 为什么文案不进代码：这些句子是「行为约束」，改一句不该重新编译、发版。它们和
 * 系统提示词里的模板同源，改 `<appRoot>/prompt/*.md` 下一条消息就生效。
 */
import { OWNER, chatKind, type Channel, type ChannelState, type Message } from "./types.ts";
import { deliveryTargets } from "./mentions.ts";
import { channelsOf, tail, unreadCount } from "./rules.ts";
import { loadTemplates, type PromptTemplate } from "../documents/base/template.ts";
import { createFsx } from "../fsx.ts";
import { renderSlots, toolSlots, type SlotValue } from "../documents/base/slots.ts";
import { oneLine } from "../documents/base/oneline.ts";
import { fill, type TextCatalog } from "../documents/base/catalog.ts";

/**
 * 回话规矩的一个条件片段：正文 + 模板自己写的兜底句。
 *
 * 兜底句住在同一个 md 的 `default:` 头里（一句文案一个家）：文件被删空时，这句话不能
 * 跟着消失 —— 少了「这一轮只有你被叫醒」，模型就可能不说话。
 */
export type ReplyFragment = { readonly body: string; readonly fallback: string };

/** 回话规矩的三个条件片段。 */
export type ReplyFragments = {
	readonly alone: ReplyFragment;
	readonly shared: ReplyFragment;
	readonly colleagues: ReplyFragment;
};

/** delivery 段的全部模板：每轮现读，改文件下一条生效。 */
export type DeliveryPrompt = {
	readonly reply: string;
	readonly interrupted: string;
	readonly alone: ReplyFragment;
	readonly shared: ReplyFragment;
	readonly colleagues: ReplyFragment;
	readonly dm: string;
	readonly multi: string;
	readonly merged: string;
	readonly digest: string;
	/** 插话时提醒「手上那件活属于哪个频道，答完回去」。写 `prompt/88-task.md`。 */
	readonly task: string;
};

/** 填一份片段；空模板返回空串，由调用方决定「不贴」还是用事实兜底。 */
function fillFragment(template: string, values: Readonly<Record<string, SlotValue>> = {}): string {
	if (template.trim() === "") return "";
	return renderSlots(template, { ...toolSlots(template), ...values }).text.trim();
}

/** 正文优先，正文空/删了就用模板自带的兜底句。 */
function fillPair(fragment: ReplyFragment, values: Readonly<Record<string, SlotValue>> = {}): string {
	return fillFragment(fragment.body, values) || fillFragment(fragment.fallback, values);
}

/** 合并唤醒的尾注。模板缺失时整句不贴。 */
export function mergedNotice(template: string, merged: number): string {
	return fillFragment(template, { merged });
}

/** 这个频道是不是「我和某个人的私聊」。形态按成员推，不看 id 前缀。 */
function isOwnerDm(channel: Channel, viewer: string | undefined): boolean {
	if (chatKind(channel) !== "dm") return false;
	return viewer === undefined || channel.members.includes(viewer);
}

/**
 * 每轮贴在投递正文末尾的「怎么回话」。
 *
 * 为什么不写进系统提示词：静态规矩在长上下文里会被稀释，而这一段贴着生成点，
 * 每轮重申一次。
 *
 * 代码只判断条件：`others.length === 0` 选 `alone`，否则选 `shared`；有没有同事选
 * `colleagues`。两句文案分别来自 `prompt/81-alone.md`、`82-shared.md`、`83-colleagues.md`。
 */
export function renderReplyRules(options: {
	readonly woken: readonly string[];
	readonly viewer?: string | undefined;
	readonly labelOf?: ((slug: string) => string) | undefined;
	/** 这个频道里除自己和我之外的成员。有他们才提「成员的事在群里说」。 */
	readonly colleagues?: readonly string[] | undefined;
	/** `prompt/80-reply.md` 的正文。空串 = 没有模板（整段不贴）。 */
	readonly template: string;
	readonly fragments: ReplyFragments;
}): string {
	if (options.template.trim() === "") return "";
	const others = options.woken.filter((slug) => slug !== options.viewer);
	const label = options.labelOf ?? ((slug: string) => slug);
	const colleagues = (options.colleagues ?? []).filter((slug) => slug !== options.viewer);

	// 条件句必须是整行、且一定有值：留空会让 80-reply 渲染成「（未设置）」。
	const alone =
		others.length === 0
			? fillPair(options.fragments.alone)
			: fillPair(options.fragments.shared, { others: others.map(label).join("、") });
	// 没有同事时贴的也是这份片段的兜底句（`83-colleagues.md` 的 `default:`）：
	// 「这个频道里只有你和我」和「要问谁就 @ 他」是同一件事的两面，不另开一个文件。
	const colleagueLine =
		colleagues.length === 0
			? fillFragment(options.fragments.colleagues.fallback)
			: fillPair(options.fragments.colleagues, { colleagues: colleagues.map(label).join("、") });

	const slots: Record<string, SlotValue> = {
		...toolSlots(options.template),
		"reply.alone": alone,
		"reply.colleagues": colleagueLine,
	};
	return renderSlots(options.template, slots).text.trim();
}

/** 一条消息交给模型时的正文。纯函数，方便单测。 */
export function renderDelivery(options: {
	readonly channel: Channel;
	readonly message: Message;
	/** 收件人。用来从「还 @ 了」里剔掉自己——否则每个人都会看到「还 @ 了你」。 */
	readonly viewer?: string | undefined;
	/**
	 * 这条实际会叫醒谁（投递层已经算好的名单）。
	 *
	 * 给了就用它，不再自己推一遍：名单里多了一条「接上一位说话的」（ADR-015）之后，
	 * 两处各推一次就会出现「正文说叫醒甲、实际叫醒乙」。
	 */
	readonly woken?: readonly string[];
	readonly labelOf?: ((slug: string) => string) | undefined;
	/**
	 * 这条不是按 @ 推出来的，是助理看完之后转给他的（ADR-063）。
	 *
	 * 只多一句「谁让你看这条」：原文、回话频道、收尾都照旧。
	 */
	readonly routedBy?: string;
	/** 这句是插进一轮正在跑的工作里的。 */
	readonly interrupted?: boolean;
	/**
	 * 打断时他手上那件活所在的频道标题（和这条消息的频道不同才给）。
	 *
	 * 只提醒「活属于哪儿」；回话仍然回这条消息的频道（`reply`）。结论回哪儿由
	 * 结算收尾决定（`turn/finish.ts`），这里不替它做主。
	 */
	readonly taskChannelTitle?: string | undefined;
	/** 附件说明（`planAttachments` 的 `lines`）。没有附件时为空。 */
	readonly attachmentLines?: readonly string[];
	/** 这一轮要用的全部 delivery 模板，由 `deliveryText()` 现读。 */
	readonly prompt: DeliveryPrompt;
	/** 机械文案目录（`text/channel.md`）。 */
	readonly catalog?: TextCatalog;
}): string {
	const label = options.labelOf ?? ((slug: string) => slug);
	const { channel, message, prompt } = options;
	const t = (key: string, slots: Record<string, string | number | undefined> = {}): string =>
		fill(options.catalog, key, slots);
	const quoted = message.replyTo === undefined ? "" : t("delivery.quoted", { seq: message.replyTo });
	const others = message.mentions.filter(
		(slug) => slug !== message.from && slug !== options.viewer,
	);
	const also = others.length === 0 ? "" : `\n${t("delivery.also-mentioned", { names: others.map(label).join("、") })}`;
	// 「这条会叫醒谁、你是第几个」和「别人也在看」必须由代码注入：模型看不到投递名单，
	// 于是两个人被同时叫醒时各写一条重复甚至矛盾的回复，谁也不知道对方也在场。
	const woken = options.woken ?? deliveryTargets(channel, message);
	const line = [also];
	if (woken.length > 0) {
		const position =
			options.viewer === undefined ? "" : t("delivery.woken.position", { n: woken.indexOf(options.viewer) + 1 || 1 });
		line.push(
			`\n${t("delivery.woken", { names: woken.map(label).join("、"), position })}`,
		);
		const multi = woken.length > 1 ? fillFragment(prompt.multi) : "";
		if (multi !== "") line.push(`\n${multi}`);
	}
	return [
		// 第一行必须带**频道 id**：模型以前只看到标题，于是它只能用 `say` 的缺省频道回话；
		// 一旦缺省频道猜错（例如猜成私聊），整段对话就跑到别的房间里去了。
		t("delivery.head", { title: channel.title, seq: message.seq, id: channel.id, quoted }),
		`${label(message.from)}：${message.text}${line.join("")}`,
		...(options.routedBy === undefined || options.routedBy === options.viewer
			? []
			: [t("delivery.routed", { name: label(options.routedBy) })]),
		...(isOwnerDm(channel, options.viewer) ? [fillFragment(prompt.dm)].filter((text) => text !== "") : []),
		...(options.attachmentLines === undefined || options.attachmentLines.length === 0
			? []
			: ["", t("delivery.attachments"), ...options.attachmentLines]),
		// 「怎么回话」每轮贴在最后：它比系统提示词里的同一句规矩有效得多。
		renderReplyRules({
			template: prompt.reply,
			fragments: prompt,
			woken,
			viewer: options.viewer,
			labelOf: label,
			// 只在群聊里说「成员的事在群里说」：私聊里没有第三方，提了反而让它去找人。
			colleagues:
				chatKind(channel) === "dm"
					? []
					: channel.members.filter((slug) => slug !== OWNER && slug !== options.viewer),
		}),
		...(options.interrupted === true ? [fillFragment(prompt.interrupted)].filter((text) => text !== "") : []),
		// 插话时把「你手上那件活属于哪个频道」说清楚：私聊插话改写的是 `reply`，
		// 不改 `task`（见 `wake.ts` 的两层记录）。
		...(options.interrupted === true && options.taskChannelTitle !== undefined
			? [fillFragment(prompt.task, { task: options.taskChannelTitle })].filter((text) => text !== "")
			: []),
	].join("\n");
}

/**
 * 读 delivery 段的模板（`80-reply`、`85-…` 等）。
 *
 * 缺哪段就空串（调用方整段不贴）：模板是 workspace 里的活文件，可能被改成任意样子，
 * 读不到不该让投递失败 —— 但也不能静默：回话模板缺失就 warn 一次。
 */
export async function deliveryText(promptDir: string | undefined): Promise<DeliveryPrompt> {
	if (promptDir === undefined) {
		console.warn("[core] 投递没拿到模板目录（prompt/）：回话规矩不会贴");
		return emptyDeliveryPrompt();
	}
	// `promptDir` 本身就是模板目录，所以段目录是 `.`（不是默认的 `prompt`，那会变成 prompt/prompt）。
	const templates = await loadTemplates(createFsx(promptDir), ".");
	const delivery: readonly PromptTemplate[] = templates.filter((template) => template.use === "delivery");
	const bodyOf = (segment: string): string => delivery.find((item) => item.segment === segment)?.body ?? "";
	const fragmentOf = (segment: string): ReplyFragment => {
		const template = delivery.find((item) => item.segment === segment);
		return { body: template?.body ?? "", fallback: template?.default ?? "" };
	};
	const prompt: DeliveryPrompt = {
		reply: bodyOf("reply"),
		interrupted: bodyOf("interrupted"),
		alone: fragmentOf("alone"),
		shared: fragmentOf("shared"),
		colleagues: fragmentOf("colleagues"),
		dm: bodyOf("dm"),
		multi: bodyOf("multi"),
		merged: bodyOf("merged"),
		digest: bodyOf("digest"),
		task: bodyOf("task"),
	};
	if (prompt.reply === "") console.warn(`[core] ${promptDir} 里没有回话模板（80-reply.md）：这一段不会贴`);
	return prompt;
}

function emptyDeliveryPrompt(): DeliveryPrompt {
	return {
		reply: "",
		interrupted: "",
		alone: { body: "", fallback: "" },
		shared: { body: "", fallback: "" },
		colleagues: { body: "", fallback: "" },
		dm: "",
		multi: "",
		merged: "",
		digest: "",
		task: "",
	};
}

/** 未读摘要的机械行（`chats` 与会话投递共用）。 */
export function digestRows(
	state: ChannelState,
	slug: string,
	limit = 5,
	catalog?: TextCatalog,
): { readonly total: number; readonly rows: readonly string[] } {
	const rows: string[] = [];
	let total = 0;
	for (const channel of channelsOf(state, slug)) {
		const unread = unreadCount(state, channel.id, slug);
		if (unread === 0) continue;
		total += unread;
		const last = tail(state, channel.id, 1)[0];
		const preview = last === undefined ? "" : fill(catalog, "delivery.digest.preview", { text: oneLine(last.text, 60) });
		rows.push(fill(catalog, "delivery.digest.row", { title: channel.title, unread, preview }));
		if (rows.length >= limit) break;
	}
	return { total, rows };
}

/**
 * 未读摘要的正文。模板缺失时只给行列表 —— 事实仍然在，只是少了「这是背景」那句。
 */
export function digestNotice(template: string, total: number, rows: readonly string[]): string {
	if (rows.length === 0) return "";
	if (template.trim() === "") return rows.join("\n");
	return fillFragment(template, { total, rows: rows.join("\n") });
}
