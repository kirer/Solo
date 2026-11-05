/**
 * 身份段：一个人为什么知道「我是谁」。
 *
 * 每个人装的扩展不一样（key 里带 slug），所以这里是一个工厂。扩展是**按名字**
 * 从注册表解析的：名字找不到就被静默丢弃，会话里一个 section 都没有，模型完全
 * 不知道自己是谁。所以每加一个人都必须先 install 它自己的身份扩展。
 *
 * 提示词段是每次请求现读文件渲染的（`PromptSection.render`），不是建会话时算好
 * 写进 `instructions` —— 改文件 = 改身份，不需要重开会话。
 */
import type { Extension, Harness, Registry, Context } from "../../core/runtime/index.ts";
import { BACKGROUND_CONTEXT, defineExtension } from "../../core/runtime/index.ts";
import { agentSections, renderAgentSection, type ChatRef } from "../../core/documents/prompt.ts";
import { ChannelDoc, chatKind } from "../../core/channel/types.ts";
import { channelsOf } from "../../core/channel/rules.ts";
import type { Layout } from "../../core/layout.ts";
import type { TextCatalog } from "../../core/documents/base/catalog.ts";

export type IdentityWire = {
	extensionFor(slug: string): Promise<Extension>;
	/** 装一个人的身份段落（幂等：同名覆盖）。 */
	install(slug: string): Promise<Extension>;
	/** 某人**此刻**会看到的提示词原文（自测与调试用）。 */
	promptOf(slug: string): Promise<string>;
};

export function createIdentityWire(deps: {
	readonly registry: Registry;
	readonly layout: Layout;
	readonly harness: Harness;
	/** 插件追加的提示词。活引用：重装插件之后下一次渲染看到新的。 */
	readonly prompt: () => readonly string[];
	readonly text?: TextCatalog;
}): IdentityWire {
	const paths = () => ({
		layout: deps.layout,
		chats: (slug: string) => chatRefsOf(deps.harness, slug),
		extraPrompt: deps.prompt(),
		...(deps.text === undefined ? {} : { text: deps.text }),
	});

	async function extensionFor(slug: string): Promise<Extension> {
		return defineExtension({
			name: `core-identity:${slug}`,
			sections: await agentSections(deps.registry, paths(), slug),
		});
	}

	async function install(slug: string): Promise<Extension> {
		const extension = await extensionFor(slug);
		deps.registry.install(extension);
		return extension;
	}

	return {
		extensionFor,
		install,
		promptOf: (slug) => renderAgentSection(deps.registry, paths(), slug),
	};
}

/**
 * 某人此刻在哪些会话里（提示词「你在组织里的位置」一节要用）。
 *
 * 私聊还是群聊由成员推（`chatKind`），不靠 id 前缀 —— `all` 和 `team:x` 在这里
 * 都是“群”，没有谁特殊。
 */
async function chatRefsOf(harness: Harness, slug: string): Promise<readonly ChatRef[]> {
	const state = await harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT as Context);
	if (state === undefined) return [];
	return channelsOf(state, slug).map((channel) => ({ id: channel.id, title: channel.title, kind: chatKind(channel) }));
}
