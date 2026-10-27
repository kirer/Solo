/**
 * 记忆分层（#12）的纯函数测试。
 *
 * 这三组断言对应三道闸门——写入门槛、读取预算、总量上限。
 * 它们才是「数据堆积」问题真正的防线，工具接线坏了只是功能不可用，
 * 闸门坏了会静默失控（上下文被记忆塞满、成本翻倍，而且看不出原因）。
 */
import { describe, expect, test } from "vitest";
import {
	appendMemory,
	BRIEF_MATCHED,
	BRIEF_RECENT,
	compactMemory,
	emptyMemoryState,
	entriesOf,
	FOLD_BATCH,
	MEMORY_BODY_LIMIT,
	MEMORY_CAPACITY,
	MAX_DEPTH,
	ownerKeyOf,
	rankMemory,
	renderMemoryBrief,
	type MemoryEntry,
	type MemoryLevel,
} from "../../src/domain/memory.ts";

function entry(id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		id,
		at: 1000,
		level: "staff",
		owner: "7",
		title: `标题 ${id}`,
		body: `正文 ${id}`,
		tags: [],
		source: "manual",
		...overrides,
	};
}

describe("归属键", () => {
	test("员工按会话号，项目按 slug，公司恒定", () => {
		expect(ownerKeyOf("staff", 7, "system")).toBe("7");
		expect(ownerKeyOf("project", 7, "system")).toBe("system");
		expect(ownerKeyOf("company", 7, "system")).toBe("company");
	});

	test("项目层没有项目时返回 undefined（不允许写进无主分区）", () => {
		expect(ownerKeyOf("project", 7, undefined)).toBeUndefined();
	});
});

describe("写入闸门", () => {
	test("正文超长被截断到上限", () => {
		const state = appendMemory(emptyMemoryState(), entry("a", { body: "字".repeat(500) }));
		expect(state.entries[0]?.body.length).toBe(MEMORY_BODY_LIMIT);
		expect(state.entries[0]?.body.endsWith("…")).toBe(true);
	});

	test("同一任务只保留一条记忆（后写的覆盖前面的）", () => {
		let state = appendMemory(emptyMemoryState(), entry("a", { taskId: "T-1", title: "旧" }));
		state = appendMemory(state, entry("b", { taskId: "T-1", title: "新" }));
		expect(state.entries).toHaveLength(1);
		expect(state.entries[0]?.title).toBe("新");
	});

	test("同一任务在别的层不算覆盖", () => {
		let state = appendMemory(emptyMemoryState(), entry("a", { taskId: "T-1" }));
		state = appendMemory(state, entry("b", { taskId: "T-1", level: "company", owner: "company" }));
		expect(state.entries).toHaveLength(2);
	});

	test("没有 taskId 的条目互不覆盖", () => {
		let state = appendMemory(emptyMemoryState(), entry("a"));
		state = appendMemory(state, entry("b"));
		expect(state.entries).toHaveLength(2);
	});
});

describe("总量上限（折叠）", () => {
	test(`超过容量后最老的 ${FOLD_BATCH} 条折成一条阶段总结`, () => {
		let state = emptyMemoryState();
		const cap = MEMORY_CAPACITY.staff;
		for (let index = 0; index < cap + 1; index += 1) {
			state = appendMemory(state, entry(`e${index}`, { at: 1000 + index }));
		}
		state = compactMemory(state);
		// cap + 1 条 → 折掉 20 条成 1 条 → cap + 1 - 20 + 1
		expect(state.entries).toHaveLength(cap + 1 - FOLD_BATCH + 1);
		const summary = entriesOf(state, "staff", "7").find((item) => item.source === "distill");
		expect(summary).toBeDefined();
		expect(summary?.folded).toBe(FOLD_BATCH);
		expect(summary?.title).toContain(`阶段总结（${FOLD_BATCH} 条`);
	});

	test("反复折叠不会堆出一堆总结，且折叠代数有界", () => {
		let state = emptyMemoryState();
		const cap = MEMORY_CAPACITY.staff;
		for (let index = 0; index < cap * 3; index += 1) {
			state = appendMemory(state, entry(`e${index}`, { at: 1000 + index }));
		}
		state = compactMemory(state);
		const summaries = state.entries.filter((item) => item.source === "distill");
		// 单一归属下每层最多一条总结：折叠是「一层一层往上垒」，不会并行堆出很多条
		expect(summaries.length).toBeLessThanOrEqual(MAX_DEPTH);
		expect(state.entries.length).toBeLessThanOrEqual(cap);
		// 旧实现把已有的 distill 再折一次，folded 会累加到 153 代。现在代数必须有界。
		const maxDepth = Math.max(...state.entries.map((item) => item.depth ?? 0));
		expect(maxDepth).toBeLessThanOrEqual(MAX_DEPTH);
	});

	test("写 200 条后折叠代数 <= MAX_DEPTH，distill 正文不嵌套", () => {
		let state = emptyMemoryState();
		for (let index = 0; index < 200; index += 1) {
			state = appendMemory(state, entry(`e${index}`, { at: 1000 + index }));
			// 每 10 条压一次，模拟真实写入路径（writeMemory 每次都 compactMemory）
			if (index % 10 === 9) state = compactMemory(state);
		}
		state = compactMemory(state);
		const maxDepth = Math.max(...state.entries.map((item) => item.depth ?? 0));
		expect(maxDepth).toBeLessThanOrEqual(MAX_DEPTH);
		const summaries = state.entries.filter((item) => item.source === "distill");
		expect(summaries.length).toBeGreaterThan(0);
		for (const summary of summaries) {
			// 旧实现的正文是 `${title}：${firstLine(body, 60)}`，而 distill 的 body 首行
			// 恰好是它自己的嵌套标题行——于是子代 distill 的正文成了 `标题：阶段总结（20 条…）：…`。
			// 新正文只列子条目标题，不拼正文，所以分隔符里不应再出现「：」。
			expect(summary.body.indexOf("【摘要】"), "distill 正文不应再套一层摘要").toBe(-1);
			expect(summary.body.includes("："), "distill 正文只应该是子条目标题列表").toBe(false);
			expect(summary.body.length).toBeLessThanOrEqual(MEMORY_BODY_LIMIT);
		}
	});

	test("distill 的正文不超过 MEMORY_BODY_LIMIT", () => {
		let state = emptyMemoryState();
		for (let index = 0; index < MEMORY_CAPACITY.company * 3; index += 1) {
			state = appendMemory(
				state,
				entry(`e${index}`, { level: "company", owner: "company", at: 1000 + index, title: `标题 `.repeat(1) + index }),
			);
			if (index % 20 === 19) state = compactMemory(state);
		}
		state = compactMemory(state);
		for (const summary of state.entries.filter((item) => item.source === "distill")) {
			expect(summary.body.length).toBeLessThanOrEqual(MEMORY_BODY_LIMIT);
		}
	});

	test("到 MAX_DEPTH 后优先丢最老的原始条目，不丢 distill", () => {
		let state = emptyMemoryState();
		// 先填满到代数上限
		for (let index = 0; index < 200; index += 1) {
			state = appendMemory(state, entry(`e${index}`, { at: 1000 + index }));
			if (index % 10 === 9) state = compactMemory(state);
		}
		state = compactMemory(state);
		const distillIds = new Set(state.entries.filter((item) => item.source === "distill").map((item) => item.id));
		expect(distillIds.size).toBeGreaterThan(0);
		// 再写更多，迫使容量控制生效
		for (let index = 200; index < 400; index += 1) {
			state = appendMemory(state, entry(`x${index}`, { at: 1000 + index }));
			if (index % 10 === 9) state = compactMemory(state);
		}
		state = compactMemory(state);
		// 容量仍然被守住
		expect(state.entries.length).toBeLessThanOrEqual(MEMORY_CAPACITY.staff);
		// 并且仍然有 distill 存活（没被当成「最老的」丢掉）
		expect(state.entries.some((item) => item.source === "distill")).toBe(true);
	});

	test("层级之间互不挤占容量", () => {
		let state = emptyMemoryState();
		for (let index = 0; index < MEMORY_CAPACITY.staff; index += 1) {
			state = appendMemory(state, entry(`e${index}`, { at: 1000 + index }));
		}
		state = appendMemory(state, entry("co", { level: "company", owner: "company" }));
		state = compactMemory(state);
		expect(entriesOf(state, "company", "company")).toHaveLength(1);
	});
});

describe("读取闸门（检索），刻意不用向量检索", () => {
	const seeded = (() => {
		let state = emptyMemoryState();
		state = appendMemory(state, entry("1", { at: 1000, title: "迁移前必须备份 sqlite", body: "否则 WAL 回放会毁库", tags: ["数据库"] }));
		state = appendMemory(state, entry("2", { at: 2000, title: "前端构建要跑 ui:build", body: "dist 是产物不进 git", tags: ["前端"] }));
		state = appendMemory(state, entry("3", { at: 3000, title: "测试并发用 vitest --run", body: "watch 模式会卡住 CI", tags: ["测试"] }));
		return state;
	})();

	test("命中的排在前面（标题与标签权重高于正文）", () => {
		const found = rankMemory(seeded, { level: "staff", owner: "7", query: "备份数据库" });
		expect(found[0]?.id).toBe("1");
	});

	test("正文命中权重低但也能查到", () => {
		const found = rankMemory(seeded, { level: "staff", owner: "7", query: "WAL" });
		expect(found.map((item) => item.id)).toContain("1");
	});

	test("没有关键词时按时间倒序", () => {
		const found = rankMemory(seeded, { level: "staff", owner: "7" });
		expect(found.map((item) => item.id)).toEqual(["3", "2", "1"]);
	});

	test("不相关的关键词返回空（不硬塞）", () => {
		expect(rankMemory(seeded, { level: "staff", owner: "7", query: "量子纠缠" })).toHaveLength(0);
	});

	test("limit 生效", () => {
		expect(rankMemory(seeded, { level: "staff", owner: "7", limit: 1 })).toHaveLength(1);
	});

	test("按 owner 隔离：别人的记忆检索不到", () => {
		expect(rankMemory(seeded, { level: "staff", owner: "8" })).toHaveLength(0);
	});
});

describe("注入提示词的预算", () => {
	test(`最多 ${BRIEF_RECENT + BRIEF_MATCHED} 条，超出的只给条数`, () => {
		let state = emptyMemoryState();
		for (let index = 0; index < 20; index += 1) {
			state = appendMemory(state, entry(`e${index}`, { at: 1000 + index, title: `备份经验 ${index}`, body: "内容" }));
		}
		const brief = renderMemoryBrief(state, { level: "staff", owner: "7", query: "备份" });
		const lines = brief.split("\n").filter((line) => line.startsWith("- "));
		expect(lines.length).toBeLessThanOrEqual(BRIEF_RECENT + BRIEF_MATCHED);
		expect(brief).toContain("共 20 条");
		expect(brief).toContain("用 memory_search 按时检索");
	});

	test("没有记忆时返回空串（不为「没有」写废话）", () => {
		expect(renderMemoryBrief(emptyMemoryState(), { level: "staff", owner: "7" })).toBe("");
	});

	test("最近的排在前面", () => {
		let state = appendMemory(emptyMemoryState(), entry("old", { at: 1000, title: "旧经验" }));
		state = appendMemory(state, entry("new", { at: 9000, title: "新经验" }));
		const brief = renderMemoryBrief(state, { level: "staff", owner: "7" });
		expect(brief.indexOf("新经验")).toBeLessThan(brief.indexOf("旧经验"));
	});

	test("相关但与最近重复的不重复出现", () => {
		let state = emptyMemoryState();
		for (let index = 0; index < 5; index += 1) {
			state = appendMemory(state, entry(`e${index}`, { at: 1000 + index, title: `部署经验 ${index}` }));
		}
		const brief = renderMemoryBrief(state, { level: "staff", owner: "7", query: "部署" });
		const ids = brief.split("\n").filter((line) => line.startsWith("- "));
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("层级标签", () => {
	test("三层都能独立建分区", () => {
		let state = emptyMemoryState();
		for (const level of ["staff", "project", "company"] as MemoryLevel[]) {
			state = appendMemory(state, entry(level, { level, owner: level === "company" ? "company" : "x" }));
		}
		expect(state.entries).toHaveLength(3);
	});
});
