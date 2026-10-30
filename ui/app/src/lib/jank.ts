/**
 * 卡顿记录器：让浏览器自己说「刚才卡了多久、当时在干什么」。
 *
 * **为什么要有这个东西。** 老板报过两次「agent 在跑的时候页面卡死，点输入没反应」，
 * 而我在无头 Chrome 里量出来是「长任务 0、最慢帧 17ms」—— 两边的现象对不上。
 * 对不上的原因可能有一堆（GPU 渲染、Retina、机器同时在跑本地模型……），靠猜猜不完。
 *
 * 所以：只在真的卡的时候写一条，攒够 5 秒或页面要走了就发给 `POST /api/diag`，
 * 落在 `workspace/logs/jank.jsonl`。复现一次，我去读日志，不用再让老板开 devtools。
 *
 * **只在真卡时写**：帧间隔 > `FRAME_GAP_MS` 或长任务 > `TASK_MS`。正常浏览一条都不产生。
 *
 * 迁移自旧前端 `ui/web/js/jank.js`（ADR-057 那一批），逻辑没变，只是加了类型和
 * `mark()` 的调用点。删掉过一次（换 React 时漏迁），这次带着 `test/ui/jank.test.ts` 一起回来。
 */

import { reportJank } from "../api/client.ts";

const FRAME_GAP_MS = 240;
const TASK_MS = 200;
const REPORT_EVERY_MS = 5_000;
const LOG_LIMIT = 40;

export type JankVerdict = "hidden" | "resumed" | "foreground";

/**
 * 一条「长帧」到底是不是真卡。
 *
 * 21.6 秒的「长帧」很可能不是主线程忙，而是页面被切到后台 / 系统睡眠时 rAF 被节流，
 * 回到前台补一帧算出来的间隔就是几十秒。所以每条记录都带可见性状态和「处于当前状态多久」，
 * 并给一个粗判：
 *   hidden     —— 记录时页面不可见，帧间隔没有意义；
 *   resumed    —— 这一帧的间隔比「切回前台后经过的时间」还长，说明跨了一次隐藏/唤醒；
 *   foreground —— 真在前台连着跑，这才值得去看主线程。
 */
export function classifyJank(input: {
	gapMs?: number;
	visibility?: string;
	sinceVisibility?: number;
} = {}): JankVerdict {
	const gapMs = Number(input.gapMs ?? 0);
	const sinceVisibility = Number(input.sinceVisibility ?? 0);
	if (input.visibility === "hidden") return "hidden";
	if (sinceVisibility < gapMs) return "resumed";
	return "foreground";
}

type JankEntry = {
	why: "frame" | "longtask";
	ms: number;
	doing: string;
	forMs: number;
	vis: string;
	visForMs: number;
	state: JankVerdict;
};

/** 最近一次「我们正在干的那件事」。卡顿发生时把它一起记上，才知道是谁的锅。 */
let doing = "idle";
let doingSince = Date.now();

/**
 * 记一个正在进行的操作。用法：`const end = mark("sse:merge"); …; end();`
 *
 * 返回的函数可重复调用，只有第一次生效 —— 事件处理里常常既走正常路径又走 `catch`，
 * 到处写 `end()` 才不会漏，所以它得幂等。
 */
export function mark(label: string): () => void {
	doing = label;
	doingSince = Date.now();
	let done = false;
	return () => {
		if (done) return;
		done = true;
		doing = "idle";
		doingSince = Date.now();
	};
}

export function installJankMonitor(): void {
	if (typeof window === "undefined") return;

	const log: JankEntry[] = [];
	let lastFrame = performance.now();
	let lastReport = Date.now();
	let visibility = document.visibilityState;
	let changedAt = Date.now();

	document.addEventListener("visibilitychange", () => {
		visibility = document.visibilityState;
		changedAt = Date.now();
	});

	const context = (gapMs: number): Pick<JankEntry, "vis" | "visForMs" | "state"> => {
		const sinceVisibility = Date.now() - changedAt;
		return { vis: visibility, visForMs: sinceVisibility, state: classifyJank({ gapMs, visibility, sinceVisibility }) };
	};

	const push = (entry: JankEntry): void => {
		log.push(entry);
		if (log.length > LOG_LIMIT) log.shift();
	};

	const report = (): void => {
		if (log.length === 0) return;
		const batch = log.splice(0, log.length);
		lastReport = Date.now();
		reportJank({ kind: "jank", at: Date.now(), entries: batch });
	};

	try {
		new PerformanceObserver((list) => {
			for (const task of list.getEntries()) {
				if (task.duration < TASK_MS) continue;
				push({
					why: "longtask",
					ms: Math.round(task.duration),
					doing,
					forMs: Date.now() - doingSince,
					...context(task.duration),
				});
			}
		}).observe({ entryTypes: ["longtask"] });
	} catch {
		/* 老浏览器没有 longtask，靠帧间隔兜底 */
	}

	const tick = (now: number): void => {
		const gap = now - lastFrame;
		lastFrame = now;
		if (gap > FRAME_GAP_MS) {
			push({ why: "frame", ms: Math.round(gap), doing, forMs: Date.now() - doingSince, ...context(gap) });
		}
		if (Date.now() - lastReport > REPORT_EVERY_MS) report();
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);

	// 页面要走了也得把攒着的发出去，否则「一卡就刷新」永远留不下证据。
	window.addEventListener("pagehide", report);
}
