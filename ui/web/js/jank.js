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
				push({ why: "longtask", ms: Math.round(task.duration), doing: current, forMs: Date.now() - since });
			}
		}).observe({ entryTypes: ["longtask"] });
	} catch {
		/* 老浏览器没有 longtask，靠帧间隔兜底 */
	}

	const tick = (now) => {
		const gap = now - last;
		last = now;
		if (gap > FRAME_GAP_MS) push({ why: "frame", ms: Math.round(gap), doing: current, forMs: Date.now() - since });
		if (Date.now() - lastReport > REPORT_EVERY_MS) report();
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);

	window.addEventListener("pagehide", report);
}
