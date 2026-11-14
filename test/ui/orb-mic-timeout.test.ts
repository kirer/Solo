/**
 * 悬浮球等麦克风等多久：拿到过 → 8 秒；从没拿到过 → 30 秒（Solo 2026-11-14 定）。
 *
 * `client.js` 是浏览器里的 ESM（要 React、要插槽注册器），在 node 里 import 不进来。
 * 所以这里把需要的几段**从文件里截出来**、配一个假 `localStorage` 假的
 * `navigator.mediaDevices` 跑真函数 —— 验的是文件里那几行本身（白名单两处、
 * `micWithTimeout` 的分档），不是另抄一份逻辑来测自己抄的那份。
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const SRC = readFileSync(new URL("../../plugins-src/悬浮球/client.js", import.meta.url), "utf8");

/** 从源码里截一段：`from` 起、`to` 止（都不含 `to`）。 */
function cut(from: string, to: string): string {
	const a = SRC.indexOf(from);
	const b = SRC.indexOf(to, a);
	expect(a, `源码里找不到「${from}」`).toBeGreaterThan(-1);
	expect(b, `源码里找不到「${to}」`).toBeGreaterThan(a);
	return SRC.slice(a, b);
}

/** 三个模块级常量原样搬过来：`PREF_KEY` 一改，测试跟着改。 */
const CONSTS = /^const (?:PREF_KEY|DEFAULT_VOICE|VOICE_NAME_RE) = .*$/gm;
const CLAMP = /function clamp\(value, low, high\) \{[\s\S]*?\n\}/.exec(SRC)?.[0] ?? "";

type Prefs = Record<string, unknown>;

/** 造一份「只有 `getItem` / `setItem`」的假 localStorage：够 `readPrefs`/`savePrefs` 用。 */
function fakeStorage(initial?: Prefs): { store: Map<string, string>; api: Storage } {
	const store = new Map<string, string>();
	if (initial !== undefined) store.set("solo.orb", JSON.stringify(initial));
	const api = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
		clear: () => store.clear(),
		key: () => null,
		get length() {
			return store.size;
		},
	} as unknown as Storage;
	return { store, api };
}

/** 把源码那几段拼成一个模块，带上假的 `localStorage` / `window` / `navigator`。 */
function build(storage: Storage, getUserMedia: (constraints: unknown) => Promise<unknown>) {
	const body = [
		SRC.match(CONSTS)?.join("\n") ?? "",
		cut("function readPrefs", "function clamp"),
		CLAMP,
		cut("const MIC_TIMEOUT_MS", "const stopRecording"),
		"return { readPrefs, savePrefs, micWithTimeout, MIC_TIMEOUT_MS, MIC_TIMEOUT_FIRST_MS };",
	].join("\n");
	expect(body).toContain("micGranted");
	const factory = new Function("localStorage", "window", "navigator", body) as (
		storage: Storage,
		win: unknown,
		nav: unknown,
	) => {
		readPrefs: () => Prefs;
		savePrefs: (next: Prefs) => void;
		micWithTimeout: (constraints: unknown) => Promise<unknown>;
		MIC_TIMEOUT_MS: number;
		MIC_TIMEOUT_FIRST_MS: number;
	};
	// `window.setTimeout` 每次现取全局的：这样 `vi.useFakeTimers()` 接管得到。
	const win = {
		setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
		clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
	};
	return factory(storage, win, { mediaDevices: { getUserMedia } });
}

/** 等到 reject 之后把 `error.name` 记下来；没 settle 就是 `null`。 */
function track(promise: Promise<unknown>): { state: () => string | null } {
	let state: string | null = null;
	void promise.then(
		() => {
			state = "ok";
		},
		(error: unknown) => {
			state = error instanceof Error ? error.name : String(error);
		},
	);
	return { state: () => state };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("等多久：按「拿到过没有」分档", () => {
	it("从没拿到过 → 30 秒才放弃，第 29 秒还等着", async () => {
		vi.useFakeTimers();
		const { api } = fakeStorage();
		// 永不 resolve：模拟「系统授权框还挂着」。
		const mic = build(api, () => new Promise(() => {}));
		expect(mic.MIC_TIMEOUT_FIRST_MS).toBe(30_000);
		const seen = track(mic.micWithTimeout({ audio: true }));
		await vi.advanceTimersByTimeAsync(29_000);
		expect(seen.state()).toBeNull();
		await vi.advanceTimersByTimeAsync(1_500);
		expect(seen.state()).toBe("TimeoutError");
	});

	it("第 10 秒才点允许，录音照常起来、不报超时（这条就是 30 秒档要保住的场景）", async () => {
		vi.useFakeTimers();
		const { api, store } = fakeStorage();
		const mic = build(
			api,
			() => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 10_000)),
		);
		const seen = track(mic.micWithTimeout({ audio: true }));
		await vi.advanceTimersByTimeAsync(10_100);
		expect(seen.state()).toBe("ok");
		// 真拿到过就记一笔，下次才走 8 秒档（不记的话每次都在等 30 秒上限）。
		expect(JSON.parse(store.get("solo.orb") ?? "{}").micGranted).toBe(true);
	});

	it("记过一笔之后 → 8 秒就放弃，不再干等 30 秒", async () => {
		vi.useFakeTimers();
		const { api } = fakeStorage({ micGranted: true });
		const mic = build(api, () => new Promise(() => {}));
		expect(mic.MIC_TIMEOUT_MS).toBe(8_000);
		const seen = track(mic.micWithTimeout({ audio: true }));
		await vi.advanceTimersByTimeAsync(8_500);
		expect(seen.state()).toBe("TimeoutError");
	});

	it("已经拿到过的那次，延迟就在毫秒级（老用户不会因为分档变慢）", async () => {
		vi.useFakeTimers();
		const { api } = fakeStorage({ micGranted: true });
		const mic = build(api, () => Promise.resolve({ ok: true }));
		const seen = track(mic.micWithTimeout({ audio: true }));
		await vi.advanceTimersByTimeAsync(0);
		expect(seen.state()).toBe("ok");
	});
});

describe("这条记录活得过一次重启、也活得过下一次拖球", () => {
	it("存进去读得回来（`readPrefs` 是白名单重建，漏一行就等于没存）", () => {
		const { api } = fakeStorage();
		const mic = build(api, () => Promise.resolve({}));
		expect(mic.readPrefs().micGranted).toBe(false);
		mic.savePrefs({ micGranted: true });
		// 这里读的是**新的一份** `readPrefs`（白名单重建），不是内存里那个对象。
		expect(mic.readPrefs().micGranted).toBe(true);
	});

	it("拖球存一次位置，那一笔不会被顺手抹掉", () => {
		const { api } = fakeStorage({ micGranted: true });
		const mic = build(api, () => Promise.resolve({}));
		mic.savePrefs({ right: 200, top: 40 });
		expect(mic.readPrefs().micGranted).toBe(true);
		expect(mic.readPrefs().right).toBe(200);
	});

	it("手改过的 / 老库里没有这个字段 → 一律当没拿到过（不走真值判断）", () => {
		const cases: Prefs[] = [{}, { micGranted: "false" }, { micGranted: 1 }, { micGranted: null }];
		for (const value of cases) {
			const { api } = fakeStorage(value);
			const mic = build(api, () => Promise.resolve({}));
			expect(mic.readPrefs().micGranted, JSON.stringify(value)).toBe(false);
		}
	});
});

describe("超时那句话说得能照着做", () => {
	it("三处 catch 的文案都带上「点完允许再按一次」，和抛出来的那句一字不差", () => {
		const line = "麦克风没响应：系统可能还在等你点允许。点完允许再按一次。";
		// 抛出去那句 + 三处 `sayProblem` 的文案，一共四处。
		expect(SRC.split(line).length - 1).toBe(4);
		expect(SRC).not.toContain('"麦克风没响应：系统可能还在等你点允许"');
	});
});
