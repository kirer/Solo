/**
 * 给人开会话：扫文件夹 → 找已有的 → 没有就建 → 立刻进频道、进名册。
 *
 * 这是装配里唯一「造人」的地方。它只认三件事：
 * 1. 名册里有没有这个人的会话（有就复用，重启不会重复造人）；
 * 2. 模型与身份扩展（建会话时一次给全，老会话也补一次）；
 * 3. 频道成员（全员 / 团队 / 私聊，三个都幂等）。
 *
 * 顺序有理由：先开会话、再 bind 名册、再进频道。反过来的话，`hire` 中途失败会留下
 * 「频道里有这个人、但他没有会话」的半成品。
 */
import type { Conversation, Context, Extension, Harness } from "../../core/runtime/index.ts";
import { labelsOf, type Identity } from "../../core/documents/person/identity.ts";
import { conversationFor, type DirectoryState } from "../../core/channel/roster.ts";
import {
	addToAllChannel,
	archiveGoneTeams,
	ensureAllChannel,
	ensureOwnerDm,
	joinTeamChannel,
	type MembershipDeps,
} from "../../core/channel/membership.ts";
import type { DirectoryWire } from "./directory.ts";
import type { ModelSwitcher } from "./models.ts";

export type ConversationWire = {
	/** 给一个人开会话（已存在就直接返回）。 */
	open(slug: string, ctx: Context): Promise<Conversation>;
	/** 启动：扫一遍，给所有人开会话，名册落盘，全员频道与已删团队对账。 */
	start(ctx: Context): Promise<void>;
	/** 重新扫描：新出现的人开会话并进频道；返回新建的 slug。 */
	rescan(ctx: Context): Promise<readonly string[]>;
};

export function createConversationWire(deps: {
	readonly harness: Harness;
	readonly membership: MembershipDeps;
	readonly conversations: Map<string, Conversation>;
	/** 内存名册：读的时候优先信它（刚建好、还没落盘的人也在里面）。 */
	readonly directory: DirectoryState;
	readonly directoryWire: DirectoryWire;
	readonly models: ModelSwitcher;
	readonly identities: () => Promise<readonly Identity[]>;
	/** 装一个人的身份段落（幂等：同名覆盖）。 */
	readonly installIdentity: (slug: string) => Promise<Extension>;
	/** 工具包扩展：插件重装之后按同名原地换掉，所以取的是当下那一份。 */
	readonly toolsExtension: () => Extension;
}): ConversationWire {
	const { harness, membership, conversations, directory, directoryWire, models } = deps;

	async function open(slug: string, ctx: Context): Promise<Conversation> {
		const existing = conversations.get(slug);
		if (existing !== undefined) return existing;
		// 开会话前先看一眼 settings.json：刚加的提供商要能立刻用上（ADR-025）。
		await models.refreshModels(ctx);
		const known = conversationFor(directory, slug);
		if (known !== undefined) {
			const found = await harness.conversation(known as never, ctx);
			if (found !== undefined) {
				// 已有会话也要补一次模型：老库里可能存着 `no_model`，或者建它的时候
				// 还没配模型。`configure` 不改已有对话历史，只改这次选用的模型。
				await models.applyModel(found, slug, ctx);
				// 也补一次身份扩展（幂等）：`hire` 时会立刻开会话，那时还没重启，
				// 注册表里没有它的身份段落。不补的话它醒过来不知道自己是谁。
				await deps.installIdentity(slug);
				conversations.set(slug, found);
				// 已有会话也要补一次团队频道与私聊：老工作区里的人在它们出现之前建的。
				// 两个都幂等。
				await joinTeamChannel(membership, slug, ctx);
				await ensureOwnerDm(membership, slug, ctx);
				return found;
			}
		}
		const wanted = models.modelFor(slug);
		const created = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					// 扩展是**按名字选的**：漏了 `core-tools` 这个人就一个工具都没有（实测踩过）。
					extensions: [deps.toolsExtension(), await deps.installIdentity(slug)],
					// 模型在建会话时一次给全，不要等第一次生成才发现没有模型。
					...(wanted === undefined ? {} : { model: { provider: wanted.provider, modelId: wanted.modelId } }),
				},
			},
			ctx,
		);
		conversations.set(slug, created);
		// **建完会话立刻把映射落盘**：`hire` 走的是 `openAgent`（会创建会话）而不是
		// `rescan`，中间一旦有别的提交把名册写回旧值，这个人的映射就永久丢了 ——
		// 重启后他会拿到一个新会话，旧会话变孤儿。
		await directoryWire.bind(slug, created.id as unknown as number, ctx);
		// 一建出来就进全员频道、团队频道。
		//
		// 踩过的坑：`hire` 会立刻开会话，但全员频道的成员是**启动时**按当时的
		// `members/` 目录写死的。结果新人存在、会话也存在，却不在频道里 —— 别人
		// @ 他，`recipientsOf` 第一规则「@ 的必须是成员」把他过滤掉，消息静默不投递。
		await addToAllChannel(membership, [slug], ctx);
		await joinTeamChannel(membership, slug, ctx);
		// 每个成员一出现就有自己的私聊：他的工作过程在那里看，群聊只留结论。
		await ensureOwnerDm(membership, slug, ctx);
		return created;
	}

	async function start(ctx: Context): Promise<void> {
		const identities = await deps.identities();
		for (const identity of identities) await open(identity.slug, ctx);
		// 名册落盘（一次提交，不是每人一次）。
		await directoryWire.merge(labelsOf(identities), ctx);
		await ensureAllChannel(membership, identities, ctx);
		// 团队目录被删掉（`run rm -rf` / 改名）不会触发任何重投影：启动时兜一次。
		await archiveGoneTeams(membership, ctx);
	}

	async function rescan(ctx: Context): Promise<readonly string[]> {
		const all = await deps.identities();
		const added: string[] = [];
		for (const identity of all) {
			if (conversations.has(identity.slug)) {
				// 已经开着会话的人也要补一次团队频道：`identity.md` 里刚加上 `team:` 的人，
				// 不重扫就永远进不了那个团队的频道（幂等）。
				await joinTeamChannel(membership, identity.slug, ctx);
				// `rescan` 不走 `open`，私聊要在这里单独补（幂等）。
				await ensureOwnerDm(membership, identity.slug, ctx);
				continue;
			}
			await open(identity.slug, ctx);
			added.push(identity.slug);
		}
		if (added.length > 0) {
			// 每次 rescan 都把显示名刷新一遍：`identity.md` 改名后不用清库。
			await directoryWire.merge(labelsOf(all), ctx);
			// 新人的全员频道成员单独提交一次：`merge` 只加不删，与名册刷新互不影响。
			await addToAllChannel(membership, added, ctx);
		}
		return added;
	}

	return { open, start, rescan };
}
