/**
 * DTO 是**唯一权威**这件事，要能被机械地盯住。
 *
 * 以前 `ui/app/src/api/types.ts` 是手抄镜像：抄少了编译会错，但抄**错**（`scope: "own"`、
 * `memory.entries` 写成数组）不会错 —— 界面于是显示"undefined 段"、技能标签永远写"全员"。
 * 现在界面类型从 `view/dto.ts` 直接再导出，这个文件检查三件事：
 *
 * 1. DTO 自己零 import —— 它要是能 import 领域对象，就迟早长成一份投影；
 * 2. 界面类型文件只做再导出，不许重新声明形状（否则又是一份镜像）；
 * 3. 投影函数真吐出来的字段集合 == DTO 声明的字段集合（多一个少一个都炸）。
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { channelList, messageView, orgView } from "../../src/core/app/project.ts";
import type { ViewChannel, ViewMessage } from "../../src/core/view/dto.ts";
import type { DirectoryState } from "../../src/core/agent/roster.ts";
import type { Channel, ChannelState } from "../../src/core/channel/types.ts";

const AT = 1_700_000_000_000;
const ROOT = new URL("../../", import.meta.url).pathname;

async function source(rel: string): Promise<string> {
	return readFile(`${ROOT}${rel}`, "utf8");
}

/** 界面类型文件里所有**声明**（`type X =` / `interface X`）：应当一条都没有。 */
function declarationsOf(text: string): string[] {
	return [...text.matchAll(/^\s*(?:export\s+)?(?:type|interface)\s+(\w+)/gm)].map((match) => match[1]);
}

function specifiersOf(text: string): string[] {
	return [...text.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
}

function directoryOf(labels: Record<string, string>): DirectoryState {
	const slugToConversation: Record<string, number> = { owner: 0 };
	const conversationToSlug: Record<string, string> = { "0": "owner" };
	let next = 1;
	for (const slug of Object.keys(labels)) {
		if (slug === "owner") continue;
		slugToConversation[slug] = next;
		conversationToSlug[String(next)] = slug;
		next += 1;
	}
	return { slugToConversation, conversationToSlug, wake: {}, labels };
}

function stateOf(channels: Channel[], messages: Record<string, ChannelState["messages"][string]>): ChannelState {
	return {
		channels: Object.fromEntries(channels.map((channel) => [channel.id, channel])),
		messages,
		nextSeq: {},
		readMarks: {},
	};
}

const dm: Channel = {
	id: "dm:lin-owner",
	title: "林越",
	members: ["owner", "lin"],
	wakeOnAll: [],
	createdAt: AT,
};

const directory = directoryOf({ lin: "林越" });
const state = stateOf([dm], {
	[dm.id]: [{ seq: 1, at: AT, from: "lin", kind: "say", text: "改完了", mentions: [], read: false } as never],
});

/** 投影出来的一个对象，字段集合必须与 DTO 一字不差。 */
function keysOf(value: object): string[] {
	return Object.keys(value).sort();
}

describe("view/dto.ts 是唯一权威", () => {
	it("DTO 自己零 import（否则它会从形状长成投影）", async () => {
		const text = await source("src/core/view/dto.ts");
		expect(specifiersOf(text)).toEqual([]);
		expect(text).not.toMatch(/\bimport\s*\(/);
		expect(text).not.toMatch(/\brequire\s*\(/);
	});

	it("界面类型文件只再导出 DTO，不重新声明任何形状", async () => {
		const text = await source("ui/app/src/api/types.ts");
		expect(declarationsOf(text)).toEqual([]);
		expect(specifiersOf(text)).toEqual(["../../../../src/core/view/dto.ts"]);
	});

	it("界面用的名字都在 DTO 里（改名就会在这里炸，而不是在运行时显示 undefined）", async () => {
		const text = await source("ui/app/src/api/types.ts");
		// 只解析 `export type { ... }` 那一段：每一行要么是 `ViewX as Y,`，要么本来就不带
		// 前缀（`AttentionItem,`）。
		const block = /export type \{([\s\S]*?)\} from/.exec(text)?.[1] ?? "";
		const exported = [...block.matchAll(/(?:\w+\s+as\s+)?(\w+)\s*,/g)].map((match) => match[1]);
		expect(exported.sort()).toEqual(
			[
				"Actor",
				"Attachment",
				"AttentionItem",
				"Channel",
				"ChannelDetail",
				"ChannelKind",
				"Member",
				"MemoryEntry",
				"Mention",
				"Message",
				"Org",
				"PersonMemory",
				"PersonProfile",
				"SkillInfo",
				"Uploaded",
			].sort(),
		);
	});
});

describe("投影的输出与 DTO 字段一一对应", () => {
	it("Message", () => {
		const [message] = state.messages[dm.id] ?? [];
		const view = messageView(state, dm, message as never, directory);
		// 有人格的这条消息，DTO 声明的就是这些键（可选的 `needsYou` / `replyTo` /
		// `attachments` 在没有内容时**不出现**，不是 `undefined` 占位）。
		expect(keysOf(view)).toEqual(
			(
				[
					"seq",
					"at",
					"from",
					"fromSlug",
					"fromLabel",
					"kind",
					"text",
					"mentions",
					"read",
				] satisfies (keyof ViewMessage)[]
			)
				.slice()
				.sort(),
		);
	});

	it("Channel", () => {
		const [channel] = channelList(state, directory);
		expect(keysOf(channel as ViewChannel)).toEqual(
			(
				[
					"id",
					"kind",
					"title",
					"unread",
					"mentions",
					"preview",
					"lastAt",
					"lastSeq",
					"memberCount",
				] satisfies (keyof ViewChannel)[]
			)
				.slice()
				.sort(),
		);
	});

	it("Org", () => {
		const org = orgView([{ slug: "lin", label: "林越", title: "前端", body: "# 林越" } as never], directory);
		expect(keysOf(org)).toEqual(["people", "workspace"].sort());
	});
});
