/**
 * 成员关系与权限（纯函数，无 IO）。
 *
 * 设计见 `docs/design/COMMS-REFACTOR.md` §3 与 §5。这里只回答四个问题：
 *
 * 1. 谁能看哪个频道？（`visibleChannels`）
 * 2. 谁能 @ 谁？（`canMention`）
 * 3. 谁能给谁派任务？（`canAssign`）
 * 4. 这条消息该唤醒谁？（`channels.ts` 的 `recipientsOf`）
 *
 * ── 关键区分：通信 vs 工作 ──
 *
 * 老板的要求（2026-10-26）：
 * - 通信不限方向（开发可以直接在群里 @ CEO）
 * - 派任务只能上级 → 下级（沿 manager 链）
 * - 上报只能下级 → 上级（沿 manager 链）
 *
 * 所以权限判定**按动作**分，不按「谁对谁」一刀切。
 */

import { OWNER_ID, type Channel, type MemberRole } from "./channels.ts";

/** 组织里一个人（从 CompanyDoc 推导出来的最小视图）。 */
export type OrgPerson = {
	readonly conversationId: number;
	/** 显示名。 */
	readonly label: string;
	readonly role: MemberRole;
	/** 直属上级的会话标识；老板/CEO 没有上级时为 undefined。 */
	readonly managerId?: number;
	/** 所在项目 slug（负责人与员工有）。 */
	readonly project?: string;
	/** 是否已归档（项目终止后员工会被归档）。 */
	readonly archived?: boolean;
};

/** 组织结构（从 CompanyDoc 推导）。 */
export type Org = {
	/** 全部人，含老板（conversationId = OWNER_ID）。 */
	readonly people: readonly OrgPerson[];
	/** 项目 slug → 该项目负责人会话。 */
	readonly projectLeaders: Readonly<Record<string, number>>;
	/** CEO 的会话标识。 */
	readonly ceoId: number;
};

/** 按会话标识找人。 */
export function personOf(org: Org, conversationId: number): OrgPerson | undefined {
	return org.people.find((person) => person.conversationId === conversationId);
}

/** 老板是特殊的：不在 `people` 里也要能解析。 */
export function labelOf(org: Org, conversationId: number): string {
	if (conversationId === OWNER_ID) return "老板";
	return personOf(org, conversationId)?.label ?? `会话 ${conversationId}`;
}

/** 管理层岗位集合。 */
const MANAGEMENT: ReadonlySet<MemberRole> = new Set(["ceo", "management"]);

/** 是不是管理层（含 CEO）。 */
export function isManagement(person: OrgPerson | undefined): boolean {
	return person !== undefined && MANAGEMENT.has(person.role);
}

/** 是不是老板。 */
export function isOwner(conversationId: number): boolean {
	return conversationId === OWNER_ID;
}

// ── 频道可见性 ──────────────────────────────────────────────────────────────

/**
 * 某个人能不能看某个频道。
 *
 * 规则：
 * - 老板：全部（他就是要在所有群里）
 * - `log:<id>`：只有本人 + 老板
 * - `dm:<id>`：只有本人 + 老板
 * - `proj:<slug>`：该项目成员 + 老板 + CEO + 管理层（管理层要能看项目在干什么）
 * - `leadership`：老板 + CEO + 管理层
 * - `company`：全部在职人员 + 老板
 */
export function canView(org: Org, conversationId: number, channel: Channel): boolean {
	if (isOwner(conversationId)) return true;
	const person = personOf(org, conversationId);
	if (person === undefined) return false;

	switch (channel.kind) {
		case "company":
			return person.archived !== true;
		case "leadership":
			return isManagement(person);
		case "project":
			return person.project === channel.project || isManagement(person);
		case "dm":
		case "log":
			return String(conversationId) === channel.id.slice(channel.id.indexOf(":") + 1);
	}
}

/** 这个人能看的全部频道。 */
export function visibleChannels(org: Org, conversationId: number, channels: readonly Channel[]): readonly Channel[] {
	return channels.filter((channel) => channel.archived !== true && canView(org, conversationId, channel));
}

// ── @ 谁 ────────────────────────────────────────────────────────────────────

/**
 * 能不能 @ 某个人。
 *
 * **通信不限方向**：同频道内可以 @ 任何人。唯一的限制是「被 @ 的人必须能看到这个频道」
 * ——否则 @ 一个看不到消息的人没有意义（它收到投递也读不到上下文）。
 *
 * 老板可以 @ 任何人（他在所有频道）。
 */
export function canMention(org: Org, from: number, to: number, channel: Channel): boolean {
	if (from === to) return false;
	const target = personOf(org, to);
	if (target === undefined) return false;
	if (target.archived === true) return false;
	// 被 @ 的人必须能看到这个频道
	return canView(org, to, channel);
}

/** 这个频道里，某人能 @ 的全部人。 */
export function mentionable(org: Org, from: number, channel: Channel): readonly OrgPerson[] {
	return Object.values(channel.members)
		.map((member) => personOf(org, member.conversationId))
		.filter((person): person is OrgPerson => person !== undefined)
		.filter((person) => canMention(org, from, person.conversationId, channel));
}

// ── 派任务 / 上报 ───────────────────────────────────────────────────────────

/**
 * 能不能给某人派任务。
 *
 * 规则（只能从上到下）：
 * 1. **老板可以给任何人派**（在任何地方：群、私聊）
 * 2. 沿 manager 链的上级可以给下级派（直接上级或更上层）
 * 3. 项目负责人可以给本项目员工派
 * 4. 管理层可以给任何项目负责人派（管理层不在 manager 链上，但他们管项目）
 * 5. 同级之间不能派（CTO 不能给 CFO 派任务；那是协作，用 say）
 * 6. 下级不能给上级派（那是上报，用 escalate）
 */
export function canAssign(org: Org, from: number, to: number): boolean {
	if (from === to) return false;
	if (isOwner(from)) return true; // 老板随处可派

	const assigner = personOf(org, from);
	const assignee = personOf(org, to);
	if (assigner === undefined || assignee === undefined) return false;
	if (assignee.archived === true) return false;

	// 沿 manager 链往上找：to 是不是 from 的（间接）下属
	let cursor = assignee.managerId;
	const seen = new Set<number>();
	while (cursor !== undefined && !seen.has(cursor)) {
		if (cursor === from) return true;
		seen.add(cursor);
		cursor = personOf(org, cursor)?.managerId;
	}

	// 项目负责人 → 本项目员工（manager 链已经覆盖，这里兜一层：老数据 manager 可能指向管理层）
	if (assigner.role === "leader" && assignee.project === assigner.project) return true;

	// 管理层 → 任何项目负责人（他们管项目，负责人是项目这一层的执行者）
	if (isManagement(assigner) && assignee.role === "leader") return true;

	return false;
}

/**
 * 能不能向某人上报。
 *
 * 规则（只能从下到上）：`canAssign` 的反向，但不完全对称——
 * 员工可以向**任何**上级上报（不止直属），因为「跳过卡住的直属上级」是真实需求。
 * 但**不能向同级或下级上报**（那是聊天）。
 */
export function canEscalate(org: Org, from: number, to: number): boolean {
	if (from === to) return false;
	if (isOwner(to)) return false; // 老板不是上报对象（由 CEO 决定要不要递老板）
	const reporter = personOf(org, from);
	const target = personOf(org, to);
	if (reporter === undefined || target === undefined) return false;

	// 向自己的（间接）上级上报
	let cursor = reporter.managerId;
	const seen = new Set<number>();
	while (cursor !== undefined && !seen.has(cursor)) {
		if (cursor === to) return true;
		seen.add(cursor);
		cursor = personOf(org, cursor)?.managerId;
	}
	// 管理层之间：下级岗位可以向 CEO 上报（CEO 是所有人的最终上级）
	if (target.role === "ceo" && reporter.role !== "ceo") return true;
	return false;
}

// ── 频道的默认成员 ──────────────────────────────────────────────────────────

/**
 * 公司大群的成员：**全部在职人员 + 老板**。
 *
 * 老板明确要求「大群要包括所有员工」（2026-10-26）。归档员工不加入。
 */
export function companyMembers(org: Org): readonly number[] {
	return [OWNER_ID, ...org.people.filter((person) => person.archived !== true).map((person) => person.conversationId)];
}

/** 领导层群的成员：老板 + CEO + 管理层。 */
export function leadershipMembers(org: Org): readonly number[] {
	return [
		OWNER_ID,
		...org.people
			.filter((person) => person.archived !== true && isManagement(person))
			.map((person) => person.conversationId),
	];
}

/**
 * 项目群的成员：老板 + 项目负责人 + 该项目员工。
 *
 * 去重：负责人自身的 `project` 也是本 slug，直接拼会重复。
 */
export function projectMembers(org: Org, slug: string): readonly number[] {
	const leader = org.projectLeaders[slug];
	const ids = [
		OWNER_ID,
		...(leader === undefined ? [] : [leader]),
		...org.people
			.filter((person) => person.project === slug && person.archived !== true)
			.map((person) => person.conversationId),
	];
	return [...new Set(ids)];
}

/**
 * 某频道的「负责人」（老板发言没 @ 时唤醒谁）。
 *
 * - `company` / `leadership` → CEO
 * - `proj:x` → 该项目负责人
 * - `dm:x` / `log:x` → 对方
 */
export function ownerOfChannel(org: Org, channel: Channel): number | undefined {
	switch (channel.kind) {
		case "company":
		case "leadership":
			return org.ceoId;
		case "project":
			return channel.project === undefined ? undefined : org.projectLeaders[channel.project];
		case "dm":
		case "log": {
			const id = Number(channel.id.slice(channel.id.indexOf(":") + 1));
			return Number.isFinite(id) ? id : undefined;
		}
	}
}
