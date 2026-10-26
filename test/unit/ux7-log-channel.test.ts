/**
 * UX-7：老板能看/能在员工工作记录里插话——但**老板的话写在 `dm:`**，不是 `log:`。
 *
 * ── 口径沿革（重要，别按旧版改回去）──
 *
 * 本用例最初按 CEO 的「默认可见不唤醒，@ 才唤醒」写成，断言了「老板不 @ 不唤醒员工」。
 * 老板随后改了口径（覆盖该决定）：
 *   - **私聊**：老板说的每句话 = 对该员工的直接指令，**等同 @，必须唤醒**；
 *   - **群组**：仍维持「必须 @ 才唤醒」。
 *
 * 于是落地形态变成（CEO 最终答复）：**老板的话落在 `dm:`，`log:` 只承载员工侧工作流水**。
 * 这带来一个关键简化：实现「私聊每句唤醒」**不需要写任何新代码**——
 * `dm` 已有两条独立机制同时保证它：
 *   1. `resolveMentions` 对 `kind === "dm"` 的「没 @ = 全员」兜底；
 *   2. `recipientsOf` 的「老板发言没 @ → 唤醒频道 owner」+ `ownerOfChannel(dm)` 返回对方。
 *
 * 因此本用例断言的是**现状行为**（防将来有人把这两条机制之一删掉），
 * 以及「老板是 `log` 成员」（这是 UX-7 唯一需要的代码改动）。
 *
 * 手法：直接 import 真实 `src/domain/channels.ts` / `src/domain/membership.ts` 的纯函数
 * （不碰库、不起服务、不 boot 整个公司——避免引入第二个真相源）。
 */
import { describe, expect, test } from "vitest";
import {
	OWNER_ID,
	appendMessage,
	createChannel,
	emptyChannelState,
	member,
	recipientsOf,
	resolveMentions,
	type Channel,
} from "../../src/domain/channels.ts";
import { ownerOfChannel, type Org } from "../../src/domain/membership.ts";
import { shouldBeIn } from "../../src/company/channels.ts";

/** 够 `ownerOfChannel` 用的最小 org（它只按 channel.kind 分支）。 */
const ORG = { ceoId: 1, projectLeaders: { system: 149 }, people: [] } as unknown as Org;
const STAFF = 1905;

function build(
	id: string,
	kind: Channel["kind"],
	members: ReturnType<typeof member>[],
	project?: string,
): Channel {
	const created = createChannel(emptyChannelState(), {
		id,
		kind,
		title: id,
		members,
		at: 1,
		...(project === undefined ? {} : { project }),
	});
	const channel = created.channels[id];
	if (channel === undefined) throw new Error(`建频道失败：${id}`);
	return channel;
}

/** 老板/员工说一句话，返回唤醒对象（复用真实 recipientsOf + 真实 ownerOfChannel）。 */
function wakeTargets(channel: Channel, from: number, mentions?: number[]): readonly number[] {
	const message = appendMessage(
		{ channels: { [channel.id]: channel }, nextSeq: 1 },
		channel.id,
		{
			from,
			fromLabel: from === OWNER_ID ? "老板" : "员工",
			kind: "chat",
			text: "x",
			...(mentions === undefined ? {} : { mentions }),
		},
	).message;
	return recipientsOf(channel, message, (target) => ownerOfChannel(ORG, target));
}

/** 私聊频道的标准形态：老板 + 本人，双方 wakeOnAll（现状如此，不改）。 */
const dm = () => build(`dm:${STAFF}`, "dm", [member(OWNER_ID, "owner", 1, true), member(STAFF, "staff", 2, true)]);

describe("UX-7 私聊：老板每句话都唤醒该员工（等同 @）", () => {
	test("老板不 @ 也唤醒——靠 dm 的「没 @ = 全员」兜底", () => {
		expect(resolveMentions(dm(), OWNER_ID, undefined)).toEqual([STAFF]);
	});

	test("老板不 @ 也唤醒——靠「老板发言没 @ → 唤醒频道 owner」", () => {
		expect(ownerOfChannel(ORG, dm())).toBe(STAFF);
		expect(wakeTargets(dm(), OWNER_ID)).toEqual([STAFF]);
	});

	test("两条机制是冗余的：把 owner 兜底退化成 undefined，仍然唤醒（因为 mentions 已被 dm 兜底填上）", () => {
		// 这条守的是「删掉其中一条机制不会立刻坏」——所以它不会红。
		// 真正会红的是上面两条：它们分别单独断言每条机制自己的输出。
		const channel = dm();
		const message = appendMessage(
			{ channels: { [channel.id]: channel }, nextSeq: 1 },
			channel.id,
			{ from: OWNER_ID, fromLabel: "老板", kind: "chat", text: "x" },
		).message;
		// appendMessage 已经把 dm 兜底的结果写进 mentions
		expect(message.mentions).toEqual([STAFF]);
		// 此时即使 ownerOf 返回 undefined，也不会漏唤醒
		expect(recipientsOf(channel, message, () => undefined)).toEqual([STAFF]);
	});

	test("老板显式 @ 他：同样唤醒（不重复计入）", () => {
		expect(wakeTargets(dm(), OWNER_ID, [STAFF])).toEqual([STAFF]);
	});

	test("员工在私聊里回话：唤醒老板，不唤醒自己", () => {
		expect(wakeTargets(dm(), STAFF)).toEqual([OWNER_ID]);
	});
});

describe("UX-7 工作记录（log）：老板是成员，但这里只是员工侧流水", () => {
	test("老板是 log 频道成员（能读、能发；否则会一直显示未读、且不在成员列表里）", () => {
		const channel = build(`log:${STAFF}`, "log", [
			member(OWNER_ID, "owner", 1, false),
			member(STAFF, "staff", 2, true),
		]);
		expect(channel.members[String(OWNER_ID)]).toBeDefined();
	});

	test("员工自己的 wakeOnAll 保持 true（原样不改：那是他自己的流水）", () => {
		const channel = build(`log:${STAFF}`, "log", [
			member(OWNER_ID, "owner", 1, false),
			member(STAFF, "staff", 2, true),
		]);
		expect(channel.members[String(STAFF)]?.wakeOnAll).toBe(true);
	});

	test("员工自己在工作记录里发言：不唤醒老板（老板不因别人的流水被打扰）", () => {
		const channel = build(`log:${STAFF}`, "log", [
			member(OWNER_ID, "owner", 1, false),
			member(STAFF, "staff", 2, true),
		]);
		expect(wakeTargets(channel, STAFF)).not.toContain(OWNER_ID);
	});
});

describe("UX-7 shouldBeIn：老板必须在 log 频道里（否则他在那里发言一直是未读）", () => {
	// 这条守的是交付里唯一真正的代码改动（`shouldBeIn` 去掉 log 例外）。
	// 上面那些用例都是**手写成员**，绕过了 `shouldBeIn`——所以它们抓不到这个改动的回滚。
	// 这里直接对函数本体断言。
	test("老板在 log:<id> 频道里算成员", () => {
		expect(shouldBeIn(`log:${STAFF}`, OWNER_ID, ORG)).toBe(true);
	});

	test("员工在自己那条 log 频道里算成员", () => {
		const org = {
			...ORG,
			people: [{ conversationId: STAFF, role: "staff", project: "system", archived: false }],
		} as unknown as Org;
		expect(shouldBeIn(`log:${STAFF}`, STAFF, org)).toBe(true);
	});

	test("员工不在别人的 log 频道里", () => {
		const org = {
			...ORG,
			people: [{ conversationId: STAFF, role: "staff", project: "system", archived: false }],
		} as unknown as Org;
		expect(shouldBeIn("log:9999", STAFF, org)).toBe(false);
	});
});

describe("UX-7 回归：其他频道的唤醒语义不得被顺手改掉", () => {
	test("群组：老板不 @ 时唤醒项目负责人（原有行为）", () => {
		const project = build(
			"proj:system",
			"project",
			[member(OWNER_ID, "owner", 1, true), member(149, "leader", 2, true), member(STAFF, "staff", 3, false)],
			"system",
		);
		expect(ownerOfChannel(ORG, project)).toBe(149);
		const targets = wakeTargets(project, OWNER_ID);
		expect(targets).toContain(149);
		expect(targets).not.toContain(STAFF);
	});

	test("群组：老板 @ 某员工时，该员工被唤醒", () => {
		const project = build(
			"proj:system",
			"project",
			[member(OWNER_ID, "owner", 1, true), member(149, "leader", 2, true), member(STAFF, "staff", 3, false)],
			"system",
		);
		expect(wakeTargets(project, OWNER_ID, [STAFF])).toContain(STAFF);
	});

	test("公司大群：ownerOfChannel 仍是 CEO", () => {
		const company = build("company", "company", [
			member(OWNER_ID, "owner", 1, true),
			member(1, "ceo", 2, false),
		]);
		expect(ownerOfChannel(ORG, company)).toBe(1);
	});
});
