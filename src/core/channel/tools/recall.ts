/**
 * 翻记忆与读历史：把「存档」渲染成模型能读的文本。
 */
import { join } from "node:path";
import { readMemory } from "../../documents/member/memory.ts";
import { sectionsOf } from "../../documents/base/memory.ts";
import { readIdentity } from "../../documents/member/identity.ts";
import { redact } from "../../secrets.ts";
import { type CoreToolDeps, text } from "./context.ts";
import { assertTeamSlug } from "../../documents/team/doc.ts";
import { readTeamMemory, teamMemorySections } from "../../documents/team/memory.ts";
import type { Message } from "../types.ts";
import { fill, type TextCatalog } from "../../documents/base/catalog.ts";

/**
 * 翻记忆全文（ADR-084 合并进来的那一半）。
 *
 * `team` 为空 = 翻自己的记忆，否则翻那个团队的记忆；`keyword` 为空 = 全文。
 */
export async function recallText(deps: CoreToolDeps, slug: string, team: string | undefined, keyword: string) {
	// 记忆是自由文本，密钥可能早就被写进去了。读的时候也要过一遍脱敏 ——
	// 渲染进提示词的那一路有出口，这一路是「它主动来翻」，同样不能把密钥交出去。
	const mask = (value: string) => redact(value, deps.layout.appRoot);
	if (team !== undefined && team !== "") {
		const target = team;
		try {
			assertTeamSlug(target, deps.text);
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error));
		}
		const source = await readTeamMemory(deps.layout.teamsRoot, target);
		if (source === undefined) return text(fill(deps.text, "recall.team.empty", { team: target }));
		if (keyword === "") return text(mask(source));
		const sections = teamMemorySections(source).filter(
			(section) => section.heading.includes(keyword) || section.body.includes(keyword),
		);
		if (sections.length === 0) {
			return text(fill(deps.text, "recall.team.no-match", { team: target, keyword }));
		}
		return text(mask(sections.map((section) => `## ${section.heading}\n${section.body}`).join("\n\n")));
	}

	const dir = (await readIdentity(deps.layout.agentRoots, slug))?.dir ?? join(deps.layout.membersRoot, slug);
	const source = await readMemory(dir);
	if (source === undefined) return text(fill(deps.text, "recall.self.empty"));
	if (keyword === "") return text(mask(source));
	const sections = sectionsOf(source).filter(
		(section) => section.heading.includes(keyword) || section.body.includes(keyword),
	);
	if (sections.length === 0) return text(fill(deps.text, "recall.self.no-match", { keyword }));
	return text(mask(sections.map((section) => `## ${section.heading}\n${section.body}`).join("\n\n")));
}

/** 一条消息的一行渲染（`chats` 用）。 */
export function renderLine(message: Message, catalog?: TextCatalog): string {
	const time = new Date(message.at).toISOString().slice(11, 16);
	const mentions = message.mentions.length === 0 ? "" : ` @${message.mentions.join("、")}`;
	const quoted = message.replyTo === undefined ? "" : fill(catalog, "delivery.quoted", { seq: message.replyTo });
	// 附件要在历史里留下痕迹：不然补看历史的人不知道那条消息带过图，会以为对方在说空话。
	const files = (message.attachments ?? []).map((item) =>
		fill(catalog, item.kind === "image" ? "recall.attachment.image" : "recall.attachment.file", {
			name: item.name,
			id: item.id,
		}),
	);
	const suffix = files.length === 0 ? "" : ` ${files.join(" ")}`;
	return `#${message.seq} ${time} ${message.from}${mentions}：${quoted}${message.text}${suffix}`;
}
