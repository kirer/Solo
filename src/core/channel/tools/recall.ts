/**
 * 翻记忆与读历史：把「存档」渲染成模型能读的文本。
 */
import { join } from "node:path";
import { readMemory, sectionsOf } from "../../agent/memory.ts";
import { redact } from "../../agent/secrets.ts";
import { type CoreToolDeps, text } from "./context.ts";
import { assertTeamSlug } from "../../team/doc.ts";
import { readTeamMemory, teamMemorySections } from "../../team/memory.ts";
import type { Message } from "../types.ts";

/**
 * 翻记忆全文（ADR-084 合并进来的那一半）。
 *
 * `team` 为空 = 翻自己的记忆，否则翻那个团队的记忆；`keyword` 为空 = 全文。
 */
export async function recallText(deps: CoreToolDeps, slug: string, team: string | undefined, keyword: string) {
	// 记忆是自由文本，密钥可能早就被写进去了。读的时候也要过一遍脱敏 ——
	// 渲染进提示词的那一路有出口，这一路是「它主动来翻」，同样不能把密钥交出去。
	const mask = (value: string) => redact(value, deps.workspaceRoot);
	if (team !== undefined && team !== "") {
		const target = team;
		try {
			assertTeamSlug(target);
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error));
		}
		const source = await readTeamMemory(deps.teamsRoot, target);
		if (source === undefined) return text(`团队「${target}」还没有记忆。`);
		if (keyword === "") return text(mask(source));
		const sections = teamMemorySections(source).filter(
			(section) => section.heading.includes(keyword) || section.body.includes(keyword),
		);
		if (sections.length === 0) return text(`团队「${target}」的记忆里没有「${keyword}」。`);
		return text(mask(sections.map((section) => `## ${section.heading}\n${section.body}`).join("\n\n")));
	}

	const source = await readMemory(join(deps.agentsRoot, slug));
	if (source === undefined) return text("我还没记过任何东西。");
	if (keyword === "") return text(mask(source));
	const sections = sectionsOf(source).filter(
		(section) => section.heading.includes(keyword) || section.body.includes(keyword),
	);
	if (sections.length === 0) return text(`记忆里没有「${keyword}」。`);
	return text(mask(sections.map((section) => `## ${section.heading}\n${section.body}`).join("\n\n")));
}

/** 一条消息的一行渲染（`chats` 用）。 */
export function renderLine(message: Message): string {
	const time = new Date(message.at).toISOString().slice(11, 16);
	const mentions = message.mentions.length === 0 ? "" : ` @${message.mentions.join("、")}`;
	const quoted = message.replyTo === undefined ? "" : `（回复 #${message.replyTo}）`;
	// 附件要在历史里留下痕迹：不然补看历史的人不知道那条消息带过图，会以为对方在说空话。
	const files = (message.attachments ?? []).map((item) =>
		item.kind === "image" ? `[图片 ${item.name} · uploads/${item.id}]` : `[文件 ${item.name} · uploads/${item.id}]`,
	);
	const suffix = files.length === 0 ? "" : ` ${files.join(" ")}`;
	return `#${message.seq} ${time} ${message.from}${mentions}：${quoted}${message.text}${suffix}`;
}
