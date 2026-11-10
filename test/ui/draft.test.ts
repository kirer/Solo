/**
 * 输入框草稿：按频道落盘、发完清掉、坏值不炸。
 *
 * 这条线的意义在「不要让人白干活」：打了一半的话切个频道就没了，比功能少一个严重得多。
 * 所以这里钉三件事 —— 各频道互不串、发出去之后真的清干净、存的东西坏了也不能让人打不了字。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Store = Map<string, string>;

function installStorage(): Store {
	const store: Store = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
		clear: () => store.clear(),
		key: (index: number) => [...store.keys()][index] ?? null,
		get length() {
			return store.size;
		},
	});
	return store;
}

const file = { id: "up-1", name: "报表.xlsx", kind: "file" as const, bytes: 1024 };

describe("输入框草稿", () => {
	let store: Store;

	beforeEach(() => {
		store = installStorage();
		vi.resetModules();
	});

	it("每个频道各存一份，不会互相串", async () => {
		const { writeDraft, readDraft } = await import("../../ui/app/src/lib/draft.ts");
		writeDraft("a", { text: "给 a 的话", files: [] });
		writeDraft("b", { text: "给 b 的话", files: [] });
		expect(readDraft("a").text).toBe("给 a 的话");
		expect(readDraft("b").text).toBe("给 b 的话");
	});

	it("附件一起存、一起恢复（只存回执，不存预览地址）", async () => {
		const { writeDraft, readDraft } = await import("../../ui/app/src/lib/draft.ts");
		writeDraft("a", { text: "", files: [file] });
		const back = readDraft("a");
		expect(back.files).toEqual([file]);
		expect(store.get("solo.draft.a")).not.toContain("blob:");
	});

	it("发出去之后这个频道清空，别的频道不受影响", async () => {
		const { writeDraft, readDraft, clearDraft } = await import("../../ui/app/src/lib/draft.ts");
		writeDraft("a", { text: "发出去的", files: [file] });
		writeDraft("b", { text: "还没发的", files: [] });
		clearDraft("a");
		expect(readDraft("a")).toEqual({ text: "", files: [] });
		expect(readDraft("b").text).toBe("还没发的");
	});

	it("空草稿不占坑：正文空、附件也空就把那条 key 删掉", async () => {
		const { writeDraft } = await import("../../ui/app/src/lib/draft.ts");
		writeDraft("a", { text: "  ", files: [] });
		writeDraft("a", { text: "", files: [] });
		expect(store.has("solo.draft.a")).toBe(false);
	});

	it("存坏了的、类型不对的，一律当空，不抛错", async () => {
		const { readDraft } = await import("../../ui/app/src/lib/draft.ts");
		store.set("solo.draft.a", "这不是 JSON");
		expect(readDraft("a")).toEqual({ text: "", files: [] });
		store.set("solo.draft.a", JSON.stringify({ text: 123, files: "不是数组" }));
		expect(readDraft("a")).toEqual({ text: "", files: [] });
		store.set("solo.draft.a", JSON.stringify({ text: "ok", files: [{ id: 1 }] }));
		expect(readDraft("a")).toEqual({ text: "ok", files: [] });
	});

	it("没有频道、没有 localStorage 都不炸", async () => {
		const { readDraft, writeDraft, clearDraft } = await import("../../ui/app/src/lib/draft.ts");
		expect(readDraft(null)).toEqual({ text: "", files: [] });
		writeDraft(null, { text: "x", files: [] });
		clearDraft(null);
		vi.stubGlobal("localStorage", undefined);
		vi.resetModules();
		const fresh = await import("../../ui/app/src/lib/draft.ts");
		expect(fresh.readDraft("a")).toEqual({ text: "", files: [] });
		expect(() => fresh.writeDraft("a", { text: "x", files: [] })).not.toThrow();
	});

	it("超长正文截断，不会把 localStorage 写爆", async () => {
		const { writeDraft, readDraft } = await import("../../ui/app/src/lib/draft.ts");
		writeDraft("a", { text: "字".repeat(30000), files: [] });
		expect(readDraft("a").text.length).toBe(20000);
	});
});
