/**
 * 卡顿记录器。
 *
 * **为什么要有这个东西。** 老板两次报「agent 在跑的时候页面卡死，点击输入都没反应」，
 * 而我在无头 Chrome 里用探针量出来是「长任务 0、最慢帧 17ms」—— 两边的现象对不上。
 * 对不上的原因可能有一堆（GPU 渲染、Retina、机器同时跑本地模型……），靠猜是猜不完的。
 *
 * 所以：浏览器自己把「卡了多久、当时在干什么」记下来，上报给服务端
 * （`POST /api/diag`，落在 `workspace/logs/jank.jsonl`）。复现一次，我去读日志，
 * 不用再让老板开 devtools。
 *
 * 只在真的卡的时候写：帧间隔 > `FRAME_GAP_MS` 或长任务 > `TASK_MS`。
 */
const FRAME_GAP_MS = 240;
const TASK_MS = 200;
const REPORT_EVERY_MS = 5_000;

/**
 * 给一条卡顿判断「它到底是不是真的卡」。
 *
 * 21.6 秒的「长帧」很可能不是主线程忙，而是页面被切到后台/系统睡眠时 rAF 被节流
 * （额度用完、定时器降频），回到前台补一帧时算出来的间隔就是几十秒。所以每条记录
 * 都带上可见性状态和「处于当前状态多久」，并给一个粗判：
 *   hidden —— 记录时页面不可见，帧间隔没有意义；
 *   resumed —— 这一帧的间隔比「切回前台后经过的时间」还长，说明跨了一次隐藏/唤醒；
 *   foreground —— 真正在前台连着跑，这才值得去看主线程。
 */
export function classifyJank({ gapMs = 0, visibility = "visible", sinceVisibility = 0 } = {}) {
	if (visibility === "hidden") return "hidden";
	if (Number(sinceVisibility) < Number(gapMs)) return "resumed";
	return "foreground";
}

/** 最近一次「我们正在干的那件事」。卡顿发生时把它一起记上，才知道是谁的锅。 */
let current = "idle";
let since = Date.now();

/** 记一个正在进行的操作。用法：`const end = mark("sse:merge"); …; end();` */
export function mark(label) {
	current = label;
	since = Date.now();
	let done = false;
	return () => {
		if (done) return;
		done = true;
		current = "idle";
		since = Date.now();
	};
}

export function installJankMonitor() {
	if (typeof window === "undefined") return;
	const log = [];
	let last = performance.now();
	let lastReport = Date.now();
	// 可见性状态与「进入这个状态多久」：判断是不是节流伪长帧的唯一依据。
	let visibility = typeof document === "undefined" ? "visible" : document.visibilityState;
	let changedAt = Date.now();
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", () => {
			visibility = document.visibilityState;
			changedAt = Date.now();
		});
	}
	const context = (gapMs = 0) => {
		const sinceVisibility = Date.now() - changedAt;
		return {
			vis: visibility,
			visForMs: sinceVisibility,
			state: classifyJank({ gapMs, visibility, sinceVisibility }),
		};
	};

	const push = (entry) => {
		log.push(entry);
		if (log.length > 40) log.shift();
	};

	const report = () => {
		if (log.length === 0) return;
		const batch = log.splice(0, log.length);
		lastReport = Date.now();
		// `keepalive` 让「刚要刷新页面」时的上报也能发出去。
		void fetch("/api/diag", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "jank", at: Date.now(), entries: batch }),
			keepalive: true,
		}).catch(() => undefined);
	};

	try {
		new PerformanceObserver((list) => {
			for (const task of list.getEntries()) {
				if (task.duration < TASK_MS) continue;
				push({
					why: "longtask",
					ms: Math.round(task.duration),
					doing: current,
					forMs: Date.now() - since,
					...context(task.duration),
				});
			}
		}).observe({ entryTypes: ["longtask"] });
	} catch {
		/* 老浏览器没有 longtask，靠帧间隔兜底 */
	}

	const tick = (now) => {
		const gap = now - last;
		last = now;
		if (gap > FRAME_GAP_MS) {
			push({ why: "frame", ms: Math.round(gap), doing: current, forMs: Date.now() - since, ...context(gap) });
		}
		if (Date.now() - lastReport > REPORT_EVERY_MS) report();
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);

	window.addEventListener("pagehide", report);
}
