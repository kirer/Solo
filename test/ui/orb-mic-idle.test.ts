/**
 * 不按说话的时候，一次麦克风都不许申请（老板 2026-11-16：装了 2.9.22，「打开直接说话」没开，
 * 菜单栏那颗麦克风指示灯却一直亮）。
 *
 * 这条不是靠「改好某一条路」修掉的：以前「什么时候该听」在三个地方各写一遍（按键、常驻听
 * effect、唤醒词那个 1.5 秒 tick），谁少写一个条件都看不出来。现在判据只有 `micWant`
 * 一处，这个文件钉两件事：
 *
 *   1. 真值表 —— 两个开关都关的时候，`recording` / `transcribing` / 窗口藏没藏 / 私聊建没建，
 *      十六种组合全都不该开；
 *   2. 10 秒空跑 —— 把源码里那个 `tick` 原样拿出来，用假时钟按 1.5 秒一拍跑 10 秒，
 *      `startWake` 一次都不许被调；再把开关打开跑一遍当反向对照，证明这个壳不是恒绿的空断言。
 *
 * `client.js` 是浏览器里的 ESM（要 React、要插槽注册器），import 不进来 —— 所以这里截源码跑，
 * 和 `orb-mic-gate.test.ts` 同一套手法。
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const SRC = readFileSync(new URL("../../plugins-src/悬浮球/client.js", import.meta.url), "utf8");

function cut(from: string, to: string): string {
	const a = SRC.indexOf(from);
	const b = SRC.indexOf(to, a);
	expect(a, `源码里找不到「${from}」`).toBeGreaterThan(-1);
	expect(b, `源码里找不到「${to}」`).toBeGreaterThan(a);
	return SRC.slice(a, b);
}

type Want = { listen: boolean; wake: boolean };
type MicWant = (state: {
	wake?: unknown;
	listen?: unknown;
	recording?: unknown;
	transcribing?: unknown;
	hidden?: unknown;
	dmId?: unknown;
}) => Want;

/** 源码里那个 `micWant`：这是全部判断的唯一一处。 */
function buildWant(): MicWant {
	const body = `${cut("function micWant(", "/**\n * 默认音色")}\nreturn micWant;`;
	return new Function(body)() as MicWant;
}

/** 源码里那个 1.5 秒 `tick`，原样拿出来跑；`startWake` 被调几次由 outside 数。 */
function buildTick(): {
	tick: () => void;
	calls: { wake: number; stop: number };
	setWakeOn: (value: boolean) => void;
	wakeOn: boolean[];
} {
	// `cut` 不含结尾那一行，补回来：tick 是个函数表达式，少了收尾的 `};` 就不是一段能跑的源码。
	const tickSrc = `${cut("\t\t\t\tconst tick = () => {", "\n\t\t\t\t};")}\n\t\t\t\t};`;
	const micWantSrc = cut("function micWant(", "/**\n * 默认音色");
	const calls = { wake: 0, stop: 0 };
	const wakeOn: boolean[] = [];
	const readPrefs = (): Record<string, unknown> => ({ wake: prefs.wake, listen: prefs.listen, dmId: "dm-1" });
	const prefs = { wake: false, listen: false };
	const body = `${micWantSrc}\n${tickSrc}\nreturn tick;`;
	const tick = new Function(
		"readPrefs",
		"setWakeOn",
		"startWake",
		"stopWake",
		"recording",
		"transcribing",
		"windowHidden",
		"dmId",
		body,
	)(
		readPrefs,
		(value: boolean) => void wakeOn.push(value),
		() => void (calls.wake += 1),
		() => void (calls.stop += 1),
		false,
		false,
		false,
		"dm-1",
	) as () => void;
	return {
		tick,
		calls,
		setWakeOn: (value: boolean) => void (prefs.wake = value),
		wakeOn,
	};
}

/** 常量真值：一个都不该开。 */
const OFF = { wake: false, listen: false } as const;

afterEach(() => {
	vi.useRealTimers();
});

describe("micWant：两个开关都关 = 一条都不许开", () => {
	it("录音 / 转写 / 窗口藏起来 / 私聊没建，十六种组合全是 false", () => {
		const micWant = buildWant();
		for (const recording of [false, true]) {
			for (const transcribing of [false, true]) {
				for (const hidden of [false, true]) {
					for (const dmId of [null, "dm-1"]) {
						const want = micWant({ ...OFF, recording, transcribing, hidden, dmId });
						const where = `recording=${String(recording)} transcribing=${String(transcribing)} hidden=${String(hidden)} dmId=${String(dmId)}`;
						expect(want.listen, `listen 不该开：${where}`).toBe(false);
						expect(want.wake, `wake 不该开：${where}`).toBe(false);
					}
				}
			}
		}
	});

	it("开关打开时才开：常驻听要私聊建好，唤醒词要让位给常驻听", () => {
		const micWant = buildWant();
		expect(micWant({ ...OFF, listen: true, dmId: "dm-1" }).listen).toBe(true);
		// 私聊没建好就不听：没有能发的地方，开着只是白占麦克风。
		expect(micWant({ ...OFF, listen: true, dmId: null }).listen).toBe(false);
		expect(micWant({ ...OFF, wake: true, dmId: "dm-1" }).wake).toBe(true);
		// 常驻听开着就不起唤醒词：两路都要麦克风。
		expect(micWant({ ...OFF, wake: true, listen: true, dmId: "dm-1" }).wake).toBe(false);
		// 在按键录音 / 正在转写 / 窗口藏着，唤醒词都得让开。
		expect(micWant({ ...OFF, wake: true, recording: true, dmId: "dm-1" }).wake).toBe(false);
		expect(micWant({ ...OFF, wake: true, transcribing: true, dmId: "dm-1" }).wake).toBe(false);
		expect(micWant({ ...OFF, wake: true, hidden: true, dmId: "dm-1" }).wake).toBe(false);
	});
});

describe("空跑 10 秒：一次 getUserMedia 都不该发生", () => {
	it("源码那个 tick 按 1.5 秒一拍跑 10 秒，两个开关都关：startWake 调用 0 次", () => {
		vi.useFakeTimers();
		const { tick, calls, wakeOn } = buildTick();
		const timer = setInterval(tick, 1500);
		vi.advanceTimersByTime(10_000);
		clearInterval(timer);
		expect(calls.wake, "10 秒里 startWake 被调了 —— 没开唤醒词却在申请麦克风").toBe(0);
		// tick 自己会先跑一遍（effect 里 `tick()` 跟 `setInterval` 各一次），所以关着的时候
		// `setWakeOn(false)` 应该被推到至少 6 次：证明这个壳真在跑，不是空转。
		expect(wakeOn.length).toBeGreaterThanOrEqual(6);
		expect(wakeOn.every((value) => value === false)).toBe(true);
		expect(calls.stop).toBeGreaterThanOrEqual(6);
	});

	it("反向对照：把唤醒词打开，同一个壳 10 秒内会去开 —— 说明上面那条不是恒绿", () => {
		vi.useFakeTimers();
		const { tick, calls, setWakeOn } = buildTick();
		setWakeOn(true);
		const timer = setInterval(tick, 1500);
		vi.advanceTimersByTime(10_000);
		clearInterval(timer);
		expect(calls.wake).toBeGreaterThan(0);
	});
});

describe("源码：判断只有一处，别的路不许自己再写一遍条件", () => {
	it("`micWant(` 只出现在定义与两个调用点里", () => {
		const hits = SRC.split("\n").filter((line) => line.includes("micWant(") && !line.trim().startsWith("*"));
		expect(hits.length, `多出来的调用点：${hits.join(" | ")}`).toBe(3);
	});

	it("申请入口只有三处 start*，且都在 `micWant` 判完之后", () => {
		const opens = SRC.split("\n").filter((line) => line.includes("mic.open("));
		expect(opens.length).toBe(3);
		// 常驻听：effect 里 want 为真才 `startListen`。
		expect(SRC).toContain("}).listen;\n\t\t\t\tif (want && listenRef.current === null) void startListen();");
		// 唤醒词：tick 里 want 为真才 `startWake`。
		expect(SRC).toContain("const want = micWant({ ...prefs, recording, transcribing, hidden: windowHidden, dmId }).wake;");
	});

	it("组件卸载/窗口藏起来时，手上的麦克风全放掉", () => {
		expect(SRC).toContain("mic.releaseAll();");
	});
});
