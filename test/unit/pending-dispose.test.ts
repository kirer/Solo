/**
 * 待办处置（驳回 / 标记已解决）的单元测试。
 *
 * 背景（老板报的缺陷）：老板级待办在界面上没有任何处置入口，既不能驳回也不能
 * 标记已解决，导致已有结论的待办长期挂在看板上无法清理。
 *
 * 验收口径（本文件逐条覆盖）：
 * 1. 可以被驳回、被标记已解决
 * 2. 操作后从默认列表（listPending）消失
 * 3. 审计有记录（AuditDoc.events 里 type="dispose"）
 * 4. **无权限者不能操作他人待办**（硬性项）
 * 5. 重复操作幂等（不报错、不重复留痕）
 * 6. 已处置的条目不再出现在 listPending 里（没有归档查询接口，见 ADR-041）
 *
 * 全部用临时库（createTestContext），绝不碰真实 workspace/company.sqlite。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT, createRegistry, openCompany, type CompanyRuntime } from "../../src/runtime/index.ts";
import {
	canDisposePending,
	disposePending,
	listPending,
	PendingDoc,
	type PendingItem,
} from "../../src/company/escalation.ts";
import { AuditDoc } from "../../src/company/docs.ts";
import { createTestContext, TEST_MODEL_CATALOG, type TestContext } from "../support.ts";
import { bootstrapCompany } from "../../src/company/org.ts";

const contexts: TestContext[] = [];
const runtimes: CompanyRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
	for (const ctx of contexts.splice(0)) await ctx.cleanup();
});

/** 起一个最小公司：只需要能提交文档、读会话。 */
async function boot(): Promise<{
	runtime: CompanyRuntime;
	dir: string;
	ownerConversationId: number;
	ceoConversationId: number;
	ctoConversationId: number;
}> {
	const ctx = await createTestContext();
	contexts.push(ctx);
	const dir = await mkdtemp(join(tmpdir(), "pending-dispose-"));
	const registry = createRegistry();
	const runtime = await openCompany(
		{ databasePath: ctx.databasePath, models: ctx.models, registry },
		BACKGROUND_CONTEXT,
	);
	runtimes.push(runtime);
	const booted = await bootstrapCompany(
		runtime,
		{
			companyName: "测试公司",
			registry,
			workspaceRoot: join(dir, "projects"),
			modelCatalog: [...TEST_MODEL_CATALOG],
			watchdog: false,
		},
		BACKGROUND_CONTEXT,
	);
	return {
		runtime,
		dir,
		ownerConversationId: booted.roleConversations.ceo,
		ceoConversationId: booted.roleConversations.ceo,
		ctoConversationId: booted.roleConversations.cto,
	};
}

/** 往 PendingDoc 里塞一条待办（key / level / decisionOwner 可控）。 */
async function seedPending(
	runtime: CompanyRuntime,
	item: {
		readonly key: string;
		readonly level: string;
		readonly decisionOwner?: string;
		readonly fromConversationId: number;
	},
): Promise<void> {
	await runtime.harness.commit(async (tx) => {
		const pending = await tx.doc(PendingDoc);
		const entry: PendingItem = {
			key: item.key,
			question: `问题 ${item.key}`,
			level: item.level,
			from: "林越",
			fromConversationId: item.fromConversationId,
			askedAt: Date.now(),
			...(item.decisionOwner === undefined ? {} : { decisionOwner: item.decisionOwner }),
		};
		pending.items.push(entry);
	}, BACKGROUND_CONTEXT);
}

async function auditEvents(runtime: CompanyRuntime, conversationId: number) {
	const state = await runtime.harness.snapshot(AuditDoc, conversationId as never, BACKGROUND_CONTEXT);
	return state?.events ?? [];
}

describe("canDisposePending：权限口径（硬性验收项）", () => {
	const ownerItem: PendingItem = {
		key: "esc:1:0",
		question: "q",
		level: "owner",
		from: "CEO",
		fromConversationId: 1,
		askedAt: 0,
		decisionOwner: "owner",
	};

	test("决策人是 owner 时，只有 owner 能处置", () => {
		expect(canDisposePending(ownerItem, "owner")).toBe(true);
		expect(canDisposePending(ownerItem, "ceo")).toBe(false);
		expect(canDisposePending(ownerItem, "cto")).toBe(false);
	});

	test("决策人是 cto 时，老板也不能替他处置（老板不该揽管理层的决策责任）", () => {
		const ctoItem: PendingItem = { ...ownerItem, level: "cto", decisionOwner: "cto" };
		expect(canDisposePending(ctoItem, "cto")).toBe(true);
		expect(canDisposePending(ctoItem, "owner")).toBe(false);
	});

	test("old data：没有 decisionOwner 时回退到 level", () => {
		const legacy: PendingItem = {
			key: "esc:2:0",
			question: "q",
			level: "cto",
			from: "CTO",
			fromConversationId: 2,
			askedAt: 0,
		};
		expect(canDisposePending(legacy, "cto")).toBe(true);
		expect(canDisposePending(legacy, "owner")).toBe(false);
	});

	test("不知道操作者层级（未识别的会话）一律拒绝", () => {
		expect(canDisposePending(ownerItem, undefined)).toBe(false);
	});
});

describe("disposePending：驳回 / 已解决", () => {
	test("驳回成功：写入状态 + 理由 + disposedBy/At，且从 listPending 消失", async () => {
		const { runtime, ceoConversationId } = await boot();
		await seedPending(runtime, { key: "esc:a", level: "owner", decisionOwner: "owner", fromConversationId: ceoConversationId });
		expect(await listPending(runtime, BACKGROUND_CONTEXT)).toHaveLength(1);

		const outcome = await disposePending(
			runtime,
			{ key: "esc:a", status: "rejected", reason: "这个需求已经砍了", disposedBy: "owner", operatorLevel: "owner" },
			BACKGROUND_CONTEXT,
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error("unreachable");
		expect(outcome.changed).toBe(true);
		expect(outcome.item.disposed).toMatchObject({
			status: "rejected",
			disposedBy: "owner",
			reason: "这个需求已经砍了",
		});
		expect(typeof outcome.item.disposed?.disposedAt).toBe("number");

		// 从默认列表消失
		expect(await listPending(runtime, BACKGROUND_CONTEXT)).toHaveLength(0);
	});

	test("标记已解决：同样写入状态，且 listPending 不再返回", async () => {
		const { runtime, ceoConversationId } = await boot();
		await seedPending(runtime, { key: "esc:b", level: "owner", decisionOwner: "owner", fromConversationId: ceoConversationId });

		const outcome = await disposePending(
			runtime,
			{ key: "esc:b", status: "resolved", disposedBy: "owner", operatorLevel: "owner" },
			BACKGROUND_CONTEXT,
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error("unreachable");
		expect(outcome.item.disposed).toMatchObject({ status: "resolved", reason: "" });
		expect(await listPending(runtime, BACKGROUND_CONTEXT)).toHaveLength(0);
	});

	test("重复处置同一种状态：幂等——成功、changed=false、不重复写审计", async () => {
		const { runtime, ceoConversationId } = await boot();
		await seedPending(runtime, { key: "esc:c", level: "owner", decisionOwner: "owner", fromConversationId: ceoConversationId });

		const first = await disposePending(
			runtime,
			{ key: "esc:c", status: "rejected", reason: "重复测试", disposedBy: "owner", operatorLevel: "owner" },
			BACKGROUND_CONTEXT,
		);
		expect(first.ok && first.changed).toBe(true);

		const before = (await auditEvents(runtime, ceoConversationId)).filter((event) => event.type === "dispose");
		expect(before).toHaveLength(1);

		const second = await disposePending(
			runtime,
			{ key: "esc:c", status: "rejected", reason: "又叫了一次", disposedBy: "owner", operatorLevel: "owner" },
			BACKGROUND_CONTEXT,
		);
		expect(second.ok).toBe(true);
		if (!second.ok) throw new Error("unreachable");
		expect(second.changed).toBe(false); // 幂等命中

		const after = (await auditEvents(runtime, ceoConversationId)).filter((event) => event.type === "dispose");
		expect(after).toHaveLength(1); // 没有重复留痕
	});

	test("先驳回再标已解决：拒绝（两个结论不能并存），且原处置不变", async () => {
		const { runtime, ceoConversationId } = await boot();
		await seedPending(runtime, { key: "esc:d", level: "owner", decisionOwner: "owner", fromConversationId: ceoConversationId });
		await disposePending(
			runtime,
			{ key: "esc:d", status: "rejected", reason: "不要了", disposedBy: "owner", operatorLevel: "owner" },
			BACKGROUND_CONTEXT,
		);

		const conflict = await disposePending(
			runtime,
			{ key: "esc:d", status: "resolved", disposedBy: "owner", operatorLevel: "owner" },
			BACKGROUND_CONTEXT,
		);
		expect(conflict.ok).toBe(false);
		if (conflict.ok) throw new Error("unreachable");
		expect(conflict.code).toBe("archived");

		// 处置结论不变（没有归档查询接口了，直接读文档；ADR-041）
		const state = await runtime.harness.snapshot(PendingDoc, BACKGROUND_CONTEXT);
		const kept = state?.items.filter((entry) => entry.disposed !== undefined) ?? [];
		expect(kept).toHaveLength(1);
		expect(kept[0]?.disposed?.status).toBe("rejected");
	});

	test("无权限（CEO 去处置 owner 的待办）被拒，给出可读原因，且状态未变", async () => {
		const { runtime, ceoConversationId } = await boot();
		await seedPending(runtime, { key: "esc:e", level: "owner", decisionOwner: "owner", fromConversationId: ceoConversationId });

		const outcome = await disposePending(
			runtime,
			{ key: "esc:e", status: "rejected", reason: "CEO 想代老板驳回", disposedBy: "ceo", operatorLevel: "ceo" },
			BACKGROUND_CONTEXT,
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.code).toBe("forbidden");
		expect(outcome.reason).toContain("owner"); // 可读：告诉它该由谁处置
		expect(outcome.reason).toContain("无权");

		// 没有被静默改掉
		const still = await listPending(runtime, BACKGROUND_CONTEXT);
		expect(still).toHaveLength(1);
		expect(still[0]?.disposed).toBeUndefined();
		// 也没有写审计
		expect((await auditEvents(runtime, ceoConversationId)).filter((event) => event.type === "dispose")).toHaveLength(0);
	});

	test("不存在的 key：404 语义（not-found），不抛", async () => {
		const { runtime } = await boot();
		const outcome = await disposePending(
			runtime,
			{ key: "esc:nope", status: "rejected", reason: "x", disposedBy: "owner", operatorLevel: "owner" },
			BACKGROUND_CONTEXT,
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.code).toBe("not-found");
	});

	test("已答复的待办不允许再处置", async () => {
		const { runtime, ceoConversationId } = await boot();
		await runtime.harness.commit(async (tx) => {
			const pending = await tx.doc(PendingDoc);
			pending.items.push({
				key: "esc:f",
				question: "q",
				level: "owner",
				from: "CEO",
				fromConversationId: ceoConversationId,
				askedAt: Date.now(),
				decisionOwner: "owner",
				answer: "已经答了",
				answeredBy: "owner",
			});
		}, BACKGROUND_CONTEXT);

		const outcome = await disposePending(
			runtime,
			{ key: "esc:f", status: "rejected", reason: "x", disposedBy: "owner", operatorLevel: "owner" },
			BACKGROUND_CONTEXT,
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.code).toBe("answered");
	});
});

describe("审计留痕", () => {
	test("驳回写入 type=dispose 的事件，note 以 rejected 开头并带理由，ref=key", async () => {
		const { runtime, ceoConversationId } = await boot();
		await seedPending(runtime, { key: "esc:g", level: "owner", decisionOwner: "owner", fromConversationId: ceoConversationId });

		await disposePending(
			runtime,
			{ key: "esc:g", status: "rejected", reason: "预算不够", disposedBy: "owner", operatorLevel: "owner" },
			BACKGROUND_CONTEXT,
		);

		const events = await auditEvents(runtime, ceoConversationId);
		const disposeEvent = events.find((event) => event.type === "dispose");
		expect(disposeEvent).toBeDefined();
		// ref 带 level：同一升级在多层各有一条，只写 key 事后分不清是哪一条被处置。
		expect(disposeEvent).toMatchObject({ type: "dispose", from: "owner", ref: "esc:g@owner" });
		expect(disposeEvent?.note).toBe("rejected: 预算不够");
		expect(typeof disposeEvent?.at).toBe("number");
	});

	test("标记已解决时 note 是 resolved（无理由时不带冒号）", async () => {
		const { runtime, ceoConversationId } = await boot();
		await seedPending(runtime, { key: "esc:h", level: "owner", decisionOwner: "owner", fromConversationId: ceoConversationId });

		await disposePending(
			runtime,
			{ key: "esc:h", status: "resolved", disposedBy: "owner", operatorLevel: "owner" },
			BACKGROUND_CONTEXT,
		);

		const events = await auditEvents(runtime, ceoConversationId);
		expect(events.find((event) => event.type === "dispose")?.note).toBe("resolved");
	});
});

describe("旧路径不能『复活』已处置的待办", () => {
	test("answerPending 对已处置条目返回 false，且不会写 answer", async () => {
		const { runtime, ceoConversationId } = await boot();
		const { answerPending } = await import("../../src/company/escalation.ts");
		await seedPending(runtime, { key: "esc:m", level: "owner", decisionOwner: "owner", fromConversationId: ceoConversationId });
		await disposePending(
			runtime,
			{ key: "esc:m", status: "resolved", disposedBy: "owner", operatorLevel: "owner" },
			BACKGROUND_CONTEXT,
		);

		const ok = await answerPending(
			runtime,
			{ key: "esc:m", answer: "迟到的答复", answeredBy: "owner" },
			BACKGROUND_CONTEXT,
		);
		expect(ok).toBe(false);

		// 仍然是「已处置、无 answer」，且不在默认列表里
		const state = await runtime.harness.snapshot(PendingDoc, BACKGROUND_CONTEXT);
		const item = state?.items.find((entry) => entry.key === "esc:m");
		expect(item?.answer).toBeUndefined();
		expect(item?.disposed?.status).toBe("resolved");
		expect(await listPending(runtime, BACKGROUND_CONTEXT)).toHaveLength(0);
	});
});

describe("同一 key 在多层各有一条时（升级链的真实形态）", () => {
	/**
	 * 真实形态：一个升级在 ceo 与 owner 各有一条待办（ensurePending 按 (key, level) 去重）。
	 * 老板要处置的是 owner 那条；ceo 那条通常已经带 answer（CEO 是 escalate 上来的）。
	 * 只按 key 找会命中 ceo 那条，于是永远报「已经答复过了」——这是实现第一版的真实 bug。
	 */
	async function seedTwoLevels(runtime: CompanyRuntime, fromConversationId: number) {
		await runtime.harness.commit(async (tx) => {
			const pending = await tx.doc(PendingDoc);
			const base = { question: "q", from: "林越", fromConversationId, askedAt: Date.now() };
			pending.items.push(
				{ ...base, key: "esc:multi", level: "ceo", decisionOwner: "ceo", answer: "老板定。", answeredBy: "ceo", escalate: true },
				{ ...base, key: "esc:multi", level: "owner", decisionOwner: "owner" },
			);
		}, BACKGROUND_CONTEXT);
	}

	test("老板处置的是 owner 那条，不会被 ceo 那条的 answer 挡住", async () => {
		const { runtime, ceoConversationId } = await boot();
		await seedTwoLevels(runtime, ceoConversationId);

		const outcome = await disposePending(
			runtime,
			{ key: "esc:multi", status: "rejected", reason: "不做", disposedBy: "owner", operatorLevel: "owner" },
			BACKGROUND_CONTEXT,
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error("unreachable");
		expect(outcome.item.level).toBe("owner");
		expect(outcome.changed).toBe(true);
	});

	test("重复处置（幂等）不会被 ceo 那条带 answer 的条目顶掉", async () => {
		const { runtime, ceoConversationId } = await boot();
		await seedTwoLevels(runtime, ceoConversationId);
		const input = { key: "esc:multi", status: "rejected" as const, reason: "不做", disposedBy: "owner", operatorLevel: "owner" };

		const first = await disposePending(runtime, input, BACKGROUND_CONTEXT);
		expect(first.ok && first.changed).toBe(true);

		// 关键：第二次必须仍然是「幂等成功」而不是 409/异常
		const second = await disposePending(runtime, input, BACKGROUND_CONTEXT);
		expect(second.ok).toBe(true);
		if (!second.ok) throw new Error("unreachable");
		expect(second.changed).toBe(false);
		expect(second.item.level).toBe("owner");
	});
});
