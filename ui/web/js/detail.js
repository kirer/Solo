/**
 * 详情面板的内容：私聊看「这个人」，群/项目看「这个群」。
 *
 * 这里只把数据变成 HTML 字符串，不发请求、不碰 DOM 结构 —— 开关和取数在 `app.js`。
 * 一条硬规矩：**档案里的东西全部来自后端**。没有的技能不画空标题，没有记忆就说没有，
 * 不为了「看起来完整」造一行假数据。
 */

import { avatarSvg } from "./avatar.js";
import { escapeHtml, relTime } from "./format.js";
import { renderMarkdown } from "./markdown.js";

// 老板自己的 slug。他没有「档案」这一页（`GET /api/people/owner` 是 404），
// 所以成员列表里他是不可点的 —— 见下面那段注释。
const OWNER_SLUG = "owner";

const KIND_LABEL = { company: "全员", leadership: "领导层", project: "项目", dm: "私聊", other: "频道" };

/**
 * `identity.md` 的正文通常以 `# 名字` 开头，而面板顶上已经写着名字了。
 * 同一屏出现两遍同一个名字，看起来像渲染错了 —— 只在**完全一致**时剥掉那一行。
 */
function bodyWithoutName(body, name) {
	if (!body) return "";
	const first = body.split("\n", 1)[0]?.trim() ?? "";
	if (first.replace(/^#+\s*/, "") !== name) return body;
	return body.slice(first.length).replace(/^\n+/, "");
}

function statusTag(label) {
	if (!label) return "";
	return `<span class="detail-state">${escapeHtml(label)}</span>`;
}

function section(title, inner, extra = "") {
	if (inner === "") return "";
	return `<section class="detail-sec"><h3 class="detail-sec-head">${escapeHtml(title)}${extra}</h3>${inner}</section>`;
}

function labeled(label, value) {
	if (!value) return "";
	return `<div class="detail-field"><span class="detail-k">${escapeHtml(label)}</span><span class="detail-v">${escapeHtml(
		value,
	)}</span></div>`;
}

/** 一个人：身份、汇报关系、所在频道、预置提示词、技能、记忆。 */
export function personDetailHtml(person, options = {}) {
	if (!person) return "";
	const statusLabel = options.statusLabel ?? "";
	const channels = Array.isArray(person.channels) ? person.channels : [];
	const skills = Array.isArray(person.skills) ? person.skills : [];
	const memory = person.memory ?? { exists: false, entries: 0 };
	const skillsInner =
		skills.length === 0
			? `<p class="detail-empty">还没有技能。他可以在干活时自己写一份。</p>`
			: `<ul class="detail-skills">${skills
					.map(
						(skill) => `<li class="detail-skill">
						<span class="detail-skill-name">${escapeHtml(skill.name)}</span>
						${skill.overrides ? `<span class="detail-badge">覆盖公司同名</span>` : ""}
						${skill.scope === "personal" ? `<span class="detail-badge">自己的</span>` : ""}
						<span class="detail-skill-desc">${escapeHtml(skill.description ?? "")}</span>
					</li>`,
					)
					.join("")}</ul>`;
	const memoryInner = memory.exists
		? `<p class="detail-memory">${memory.entries} 条记忆${memory.digest ? ` · ${escapeHtml(String(memory.digest).split("\n")[0])}` : ""}</p>
			<button class="detail-btn" type="button" data-open-memory="${escapeHtml(person.slug)}">打开记忆</button>`
		: `<p class="detail-empty">还没有记忆。你跟他说话时他会记下来。</p>`;
	const channelsInner =
		channels.length === 0
			? `<p class="detail-empty">不在任何频道里。</p>`
			: `<div class="detail-chips">${channels
					.map(
						(channel) =>
							`<button class="detail-chip" type="button" data-goto="${escapeHtml(channel.id)}">${escapeHtml(
								channel.title ?? channel.id,
							)}</button>`,
					)
					.join("")}</div>`;

	return `<header class="detail-head">
		<span class="detail-av">${avatarSvg({
			slug: person.slug,
			name: person.label,
			size: 56,
			state: options.presence ?? "idle",
		})}</span>
		<span class="detail-ident">
			<h2 class="detail-name" id="detail-name">${escapeHtml(person.label ?? person.slug)}</h2>
			<span class="detail-tags">${[person.title, person.project].filter(Boolean).map((text) => `<span class="detail-tag">${escapeHtml(text)}</span>`).join("")}${statusTag(statusLabel)}</span>
		</span>
	</header>
	${section(
		"关系",
		[
			labeled("向谁汇报", person.managerLabel ?? ""),
			labeled("岗位", person.title ?? ""),
			labeled("项目", person.project ?? ""),
		].join(""),
	)}
	${section("在哪些频道", channelsInner)}
	${section("预置提示词", person.body ? `<div class="detail-doc">${renderMarkdown(bodyWithoutName(person.body, person.label ?? person.slug))}</div>` : `<p class="detail-empty">identity.md 是空的。</p>`)}
	${section("技能", skillsInner)}
	${section("记忆", memoryInner)}`;
}

/** 一个群/项目：它是谁的地方，里面有谁。 */
export function channelDetailHtml(channel, options = {}) {
	if (!channel) return "";
	const source = Array.isArray(options.members) ? options.members : [];
	// 知言（slug=知言）固定排第一（pin to top）：群/项目成员列表恒在首位。
	const members = [...source].sort((left, right) =>
		left.slug === "知言" ? -1 : right.slug === "知言" ? 1 : 0,
	);
	const kind = KIND_LABEL[options.kind ?? ""] ?? "频道";
	const membersInner =
		members.length === 0
			? `<p class="detail-empty">还没有成员。</p>`
			: `<ul class="detail-people">${members
					.map((member) => {
						const face = avatarSvg({ slug: member.slug, name: member.label, size: 24, state: member.presence ?? "idle" });
						const name = `<span class="detail-person-name">${escapeHtml(member.label ?? member.slug)}</span>`;
						const title = member.title ? `<span class="detail-person-title">${escapeHtml(member.title)}</span>` : "";
						// 老大没有「档案」可看（他自己的名片就是这个界面），所以这里不做成按钮：
						// 做成按钮的结果是点进去报「没有这个人」—— 一个不该出现的 404。
						if (member.slug === OWNER_SLUG) {
							return `<li class="detail-person"><span class="detail-person-btn is-static">${face}${name}${title}</span></li>`;
						}
						return `<li class="detail-person">
						<button class="detail-person-btn" type="button" data-open-person="${escapeHtml(member.slug)}">
							${face}${name}${title}
						</button>
					</li>`;
					})
					.join("")}</ul>`;

	return `<header class="detail-head">
		<span class="detail-av">${options.avatarHtml ?? ""}</span>
		<span class="detail-ident">
			<h2 class="detail-name" id="detail-name">${escapeHtml(channel.title ?? channel.id)}</h2>
			<span class="detail-tags"><span class="detail-tag">${escapeHtml(kind)}</span>${
				channel.project ? `<span class="detail-tag">${escapeHtml(channel.project)}</span>` : ""
			}${
				channel.ownerLabel ? `<span class="detail-tag">负责人 ${escapeHtml(channel.ownerLabel)}</span>` : ""
			}</span>
		</span>
	</header>
	${
		// 没有「人话」就不画这一段（空标签比没有更难看），有就单独一行显示原文。
		(options.preview ?? "") === ""
			? ""
			: section(
					"最近",
					`<p class="detail-recent">${escapeHtml(options.preview ?? "")}</p>${labeled(
						"时间",
						options.lastAt ? relTime(options.lastAt) : "",
					)}`,
				)
	}
	${section(`成员 ${members.length}`, membersInner)}`;
}
