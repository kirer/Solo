/**
 * 外壳：把「文件夹」和「库」缝在一起。
 *
 * 这一份文件是新核心的**唯一装配点**。它做四件事，顺序不能变：
 *
 * 1. **装能力包**：注册表是内存态、不持久化，必须先装再开会话（否则重启后所有
 *    agent 都失去工具，而它们自己看不出来）。
 * 2. **扫文件夹**：`agents/<slug>/identity.md` 就是 agent 的全部事实。扫出谁存在。
 * 3. **给每个 agent 开会话**：会话 id 是底层分配的，所以要写进名册（`core.directory`）。
 *    已有的会话复用，没有的新建 —— 这样重启不会重复造人。
 * 4. **播种频道**：只有一条「公司」频道，成员是所有 agent + 老板。别的频道谁需要谁建。
 *
 * 这里没有「CEO」「CTO」这些字。谁是谁的上级，全在 `identity.md` 的 `manager` 字段里；
 * 谁是「离老板最近的人」，就是 `manager: owner` 的那一个 —— 由文档决定，不由代码决定。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Conversation, Harness, Registry, Extension } from "@earendil-works/pi-durable";
import {
	BACKGROUND_CONTEXT,
	createRegistry,
	defineExtension,
	type Context,
	type JsonObject,
} from "../runtime/index.ts";
import { OWNER_SLUG, readAllIdentities } from "../agent/identity.ts";
import { agentSection } from "../agent/runtime.ts";
import { createCoreTools, type CoreToolDeps } from "../channel/tools.ts";
import { ChannelDoc, OWNER, channelsOf, ensureChannel, type ChannelState } from "../channel/state.ts";
import { DirectoryDoc, emptyDirectory, type DirectoryState } from "../company/directory.ts";

/** 外壳配置。全部是路径和名字，没有行为开关。 */
export type CoreShellOptions = {
	/** `workspace/agents`。每个 agent 一个文件夹。 */
	readonly agentsRoot: string;
	/** `workspace/projects`。 */
	readonly projectsRoot: string;
	/** 公司频道 id。 */
	readonly companyChannel?: string;
	/** 老板显示名。只用于渲染。 */
	readonly ownerName?: string;
};

export type CoreShell = {
	readonly harness: Harness;
	readonly registry: Registry;
	/** slug → 会话。已经建好的都在里面。 */
	readonly conversations: ReadonlyMap<string, Conversation>;
	/** 名册快照（只读用途；写请走工具）。 */
	readonly directory: DirectoryState;
	/** 重新扫描文件夹，给新出现的人开会话。返回新建的 slug。 */
	readonly rescan: (context?: Context) => Promise<readonly string[]>;
	/** 读一次频道状态（工具内部已自带，这个是给外壳/API 用的）。 */
	readonly channels: (context?: Context) => Promise<ChannelState>;
	/** 老板说话。宿主入口，语义与 agent 的 `say` 完全一致。 */
	readonly ownerSay: (
		options: { readonly channelId: string; readonly text: string; readonly replyTo?: number },
		context?: Context,
	) => Promise<{ readonly seq: number; readonly delivery: import("../channel/deliver.ts").DeliverResult }>;
	readonly close: (context?: Context) => Promise<void>;
};

/**
 * 装配。
 *
 * `harness` 与 `registry` 由调用方先建好（`openCore` 的产物），因为打开库与装配是
 * 两件不同的事：前者是运行时，后者是本应用的组织语义。
 */
export async function assembleCore(
	harness: Harness,
	registry: Registry,
	options: CoreShellOptions,
	context: Context = BACKGROUND_CONTEXT,
): Promise<CoreShell> {
	const companyChannel = options.companyChannel ?? "company";

	// ── 1. 装能力包 ────────────────────────────────────────────────
	const toolDeps: CoreToolDeps = {
		harness,
		agentsRoot: options.agentsRoot,
		projectsRoot: options.projectsRoot,
		directory: async (ctx) => (await harness.snapshot(DirectoryDoc, ctx)) ?? emptyDirectory(),
		saveDirectory: async (change, ctx) => {
			await harness.commit(async (tx) => {
				const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
				Object.assign(doc, change({ ...emptyDirectory(), ...doc }));
			}, ctx);
		},
		openAgent: async (slug, ctx) => (await openOne(slug, ctx)).id as unknown as number,
	};
	const tools = createCoreTools(toolDeps);
	const toolsExtension = defineExtension({ name: "core-tools", tools });

	// 身份段落：每个 agent 装的扩展不一样（key 里带 slug），所以这里是一个工厂。
	const identityExtension = (slug: string): Extension =>
		defineExtension({
			name: `core-identity:${slug}`,
			sections: [agentSection(registry, { agents: options.agentsRoot, projects: options.projectsRoot }, slug)],
		});

	registry.install(toolsExtension);

	/**
	 * 装一个人的身份段落。
	 *
	 * 关键：`agent.extensions` 是**按名字**从注册表里解析的，名字找不到就被静默丢弃
	 * （实测踩过：会话里一个 section 都没有，模型完全不知道自己的身份）。
	 * 所以每加一个人都必须先 install 它自己的身份扩展。
	 */
	function installIdentity(slug: string): Extension {
		const extension = identityExtension(slug);
		registry.install(extension);
		return extension;
	}

	// ── 2 & 3. 扫文件夹 + 开会话 ──────────────────────────────────
	const identities = await readAllIdentities(options.agentsRoot);
	const directory: DirectoryState = (await harness.snapshot(DirectoryDoc, context)) ?? emptyDirectory();
	const conversations = new Map<string, Conversation>();

	/** 给一个 slug 开会话（内部用：先查名册，再建）。 */
	async function openOne(slug: string, ctx: Context): Promise<Conversation> {
		const existing = conversations.get(slug);
		if (existing !== undefined) return existing;
		const known = directory.slugToConversation[slug];
		if (known !== undefined) {
			const found = await harness.conversation(known as never, ctx);
			if (found !== undefined) {
				conversations.set(slug, found);
				return found;
			}
		}
		const created = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				// 扩展是**按名字选的**：漏了 `core-tools` 这个人就一个工具都没有（实测踩过）。
				agent: { extensions: [toolsExtension, installIdentity(slug)] },
			},
			ctx,
		);
		conversations.set(slug, created);
		const id = created.id as unknown as number;
		directory.slugToConversation[slug] = id;
		directory.conversationToSlug[String(id)] = slug;
		return created;
	}

	for (const identity of identities) {
		await openOne(identity.slug, context);
	}

	// 名册落盘（一次提交，不是每人一次）。
	await harness.commit(async (tx) => {
		const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
		Object.assign(doc, {
			slugToConversation: { ...doc.slugToConversation, ...directory.slugToConversation },
			conversationToSlug: { ...doc.conversationToSlug, ...directory.conversationToSlug },
		});
	}, context);

	// ── 4. 播种公司频道 ──────────────────────────────────────────
	await harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		const members = [OWNER, ...identities.map((item) => item.slug)];
		if (doc.channels[companyChannel] === undefined) {
			Object.assign(doc, ensureChannel(doc, { id: companyChannel, title: "公司", members, wakeOnAll: [], at: Date.now() }));
		} else {
			// 频道已存在：把新出现的人加进去（老板永远在）。
			const channel = doc.channels[companyChannel];
			if (channel !== undefined) {
				// 整体替换频道记录，不用 push / 不用就地改：文档读出来的是副本，
				// 就地改不产生 op（实测消息会静默消失）。
				const missing = members.filter((member) => !channel.members.includes(member));
				if (missing.length > 0) {
					doc.channels[companyChannel] = { ...channel, members: [...channel.members, ...missing] };
				}
			}
		}
	}, context);

	const shell: CoreShell = {
		harness,
		registry,
		conversations,
		directory,
		async rescan(ctx: Context = BACKGROUND_CONTEXT): Promise<readonly string[]> {
			const all = await readAllIdentities(options.agentsRoot);
			const added: string[] = [];
			for (const identity of all) {
				if (conversations.has(identity.slug)) continue;
				await openOne(identity.slug, ctx);
				added.push(identity.slug);
			}
			if (added.length > 0) {
				await harness.commit(async (tx) => {
					const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
					Object.assign(doc, {
						slugToConversation: { ...doc.slugToConversation, ...directory.slugToConversation },
						conversationToSlug: { ...doc.conversationToSlug, ...directory.conversationToSlug },
					});
					const channelDoc = (await tx.doc(ChannelDoc)) as ChannelState;
					const channel = channelDoc.channels[companyChannel];
					if (channel !== undefined) {
						const missing = added.filter((slug) => !channel.members.includes(slug));
						if (missing.length > 0) {
							channelDoc.channels[companyChannel] = { ...channel, members: [...channel.members, ...missing] };
						}
					}
				}, ctx);
			}
			return added;
		},
		async channels(ctx: Context = BACKGROUND_CONTEXT): Promise<ChannelState> {
			return (await harness.snapshot(ChannelDoc, ctx)) ?? { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
		},
		ownerSay: (input, ctx) => ownerSpeak(shell, input, ctx),
		close: (ctx?: Context) => harness.close(ctx ?? context),
	};
	return shell;
}

/** 建空的注册表（外壳自己的构造器，省得调用方记顺序）。 */
export function createCoreRegistry(): Registry {
	return createRegistry();
}

/**
 * 老板开口：把老板的一句话投进频道。
 *
 * 老板不是 agent（没有会话、没有提示词），所以它不能走 `say` 工具，需要一个宿主入口。
 * 语义与 agent 完全一致：同一套 @ 解析、同一套收件人规则、同一套投递。
 */
export async function ownerSpeak(
	shell: CoreShell,
	options: { readonly channelId: string; readonly text: string; readonly agent?: string; readonly replyTo?: number },
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ readonly seq: number; readonly delivery: import("../channel/deliver.ts").DeliverResult }> {
	const state = await shell.channels(context);
	const channel = state.channels[options.channelId];
	if (channel === undefined) throw new Error(`频道不存在：${options.channelId}`);
	const { postMessage } = await import("../channel/post.ts");
	const { conversationFor } = await import("../company/directory.ts");
	const result = await postMessage(
		{
			harness: shell.harness,
			state,
			conversationOf: async (slug: string) => {
				const id = conversationFor(shell.directory, slug);
				if (id !== undefined) {
					const found = await shell.harness.conversation(id as never, context);
					if (found !== undefined) return found;
				}
				return shell.conversations.get(slug);
			},
			labelOf: (slug: string) => slug,
		},
		{
			channelId: options.channelId,
			from: OWNER,
			text: options.text,
			at: Date.now(),
			...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
		},
		context,
	);
	return { seq: result.message.seq, delivery: result.delivery };
}

/**
 * 给一个工作区播种「老板身边的人」。
 *
 * 这是**唯一**一处预置身份的地方，而且只写文件、不写代码：一个 `manager: owner` 的
 * agent，正文说清「你是老板唯一直接对话的人，其余的人由你按需要创建」。
 * 之后它自己就会 `hire` 别人 —— 那些人的身份是它写的，不是代码写的。
 */
export async function seedOwnerAssistant(
	agentsRoot: string,
	options: { readonly name: string; readonly body?: string },
): Promise<string> {
	const { createAgent } = await import("../company/org.ts");
	const identity = await createAgent({
		root: agentsRoot,
		name: options.name,
		title: "负责人",
		manager: OWNER_SLUG,
		body:
			options.body ??
			[
				"你是老板唯一直接对话的人。老板不直接管别人，只跟你说话。",
				"",
				"## 你做什么",
				"老板说一件事，你判断它需要谁，就用 `hire` 建人，把职责、边界、汇报关系写进它的身份。",
				"你不必请示：招人、分工、定边界都是你的活。做完在频道里向老板说清楚。",
				"",
				"## 你的边界",
				"你不写代码、不做设计。你只决定「谁来做、做什么、做到什么程度」，然后验收。",
				"一个任务需要三个人时，就建三个人；需要一个人时，就一个人做到底。",
				"",
				"## 怎么说话",
				"对老板：结论先行，一句话说清做完了什么、卡在哪、要他定什么。不铺垫、不罗列过程。",
				"对下属：说清目标与验收标准，不说做法。",
				"",
				"## 你自己也在变",
				"你可以用 `update_identity` 改自己的身份。发现「我该更关注成本」这类结论，就写进自己的 identity.md。",
				"经验用 `remember` 记下来，下次先 `recall` 再动手。",
			].join("\n"),
	});
	return identity.slug;
}
