/**
 * 动效：弹簧曲线 + 进退场辅助 + 滑块 + FLIP。
 *
 * 曲线不用手写贝塞尔，按阻尼谐振采样后用 `linear()` 输出。好处是「有质量的回应」
 * 不用调参：过冲幅度、回弹次数都是从刚度/阻尼推出来的，而且和 JS 里 WAAPI 用的
 * 是同一条曲线，CSS 与 JS 不会两套手感。
 */

const SAMPLES = 25;
const STEP = 0.01;
const CAP = 2;
const TOLERANCE = 0.001;

/**
 * 阻尼谐振的位移响应：欠阻尼下
 *   x(t) = 1 - e^{-ζω₀t} (cos(ω_d t) + (ζω₀/ω_d) sin(ω_d t))
 * 采样到 |1-x| <= 0.001 为止，再均分成 25 个点交给 `linear()`。
 */
function sampleSpring(stiffness, damping) {
	const w0 = Math.sqrt(stiffness);
	const zeta = damping / (2 * w0);
	if (zeta >= 1) {
		// 过阻尼没有回弹：退化成 ease-out，仍然采样，保持接口一致。
		const values = [];
		for (let i = 0; i < SAMPLES; i += 1) values.push(1 - Math.exp(-3 * (i / (SAMPLES - 1))));
		return { values, duration: 260 };
	}
	const wd = w0 * Math.sqrt(1 - zeta * zeta);
	const at = (t) =>
		1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));

	let settled = CAP;
	for (let t = STEP; t <= CAP; t += STEP) {
		if (Math.abs(1 - at(t)) <= TOLERANCE) {
			settled = t;
			break;
		}
	}
	const values = [];
	for (let i = 0; i < SAMPLES; i += 1) values.push(at((settled * i) / (SAMPLES - 1)));
	values[0] = 0;
	values[SAMPLES - 1] = 1;
	return { values, duration: Math.round(settled * 1000) };
}

/**
 * 钢度 / 阻尼 → `linear(...)` 字符串，同时返回自然时长。
 * @param {number} stiffness
 * @param {number} damping
 */
export function springEasing(stiffness, damping) {
	const { values, duration } = sampleSpring(stiffness, damping);
	const points = values.map((v) => Number(v.toFixed(4)));
	return { easing: `linear(${points.join(", ")})`, duration, values };
}

const TAP = springEasing(900, 48); // 290ms，1.5% 过冲：按下、切换、滑块
const POP = springEasing(500, 22); // 430ms，17% 过冲：浮层出现
const SHEET = springEasing(400, 31.2); // 420ms，2% 过冲：面板开合

const LEAD = springEasing(784, 48.2).values; // 滑块前沿（快）
const TRAIL = springEasing(289, 29.2).values; // 滑块后沿（慢）

/** 启动时把弹簧曲线写进 :root，CSS 与 WAAPI 共用同一套手感。 */
export function installMotionTokens(root = document.documentElement) {
	root.style.setProperty("--ease-tap", TAP.easing);
	root.style.setProperty("--dur-tap", `${TAP.duration}ms`);
	root.style.setProperty("--ease-pop", POP.easing);
	root.style.setProperty("--dur-pop", `${POP.duration}ms`);
	root.style.setProperty("--ease-sheet", SHEET.easing);
	root.style.setProperty("--dur-sheet", `${SHEET.duration}ms`);
}

export function prefersReducedMotion() {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 关闭而不立刻摘 DOM：先 `data-leaving`（CSS 播 blur 退场），到点再藏。
 * reduced-motion 下 ms 归 0 —— 动画被禁掉了，等下去只是让界面变慢。
 */
export function withLinger(el, ms = 120, done) {
	if (!el) return;
	const wait = prefersReducedMotion() ? 0 : ms;
	el.dataset.leaving = "true";
	window.setTimeout(() => {
		delete el.dataset.leaving;
		if (done) done();
		else el.hidden = true;
	}, wait);
}

/* ── 滑块：前沿先到、后沿后到，看起来像被拉长再收回 ─────────────────── */

const glideState = new WeakMap();

/**
 * @param {HTMLElement} el  滑块元素（绝对定位）
 * @param {{x:number,w:number}} to 目标几何
 */
export function glide(el, to) {
	if (!el) return null;
	const from = glideState.get(el) ?? to;
	glideState.set(el, to);

	el.style.transform = `translateX(${to.x}px)`;
	el.style.width = `${to.w}px`;

	if (prefersReducedMotion()) return null;

	const frames = [];
	const fromRight = from.x + from.w;
	const toRight = to.x + to.w;
	for (let i = 0; i < SAMPLES; i += 1) {
		const x = from.x + (to.x - from.x) * TRAIL[i];
		const right = fromRight + (toRight - fromRight) * LEAD[i];
		frames.push({
			transform: `translateX(${x.toFixed(2)}px)`,
			width: `${Math.max(0, right - x).toFixed(2)}px`,
		});
	}
	return el.animate(frames, { duration: 380, easing: "linear" });
}

/* ── FLIP：位置变了就让元素「滑过去」，而不是瞬移 ───────────────────── */

/**
 * @param {HTMLElement} container
 * @param {() => void} mutate  会改变布局的那次改动
 * @param {string} selector    参与对比的子元素
 */
export function flip(container, mutate, selector = ":scope > *") {
	if (!container) return;
	if (prefersReducedMotion()) {
		mutate();
		return;
	}
	const before = new Map();
	for (const node of container.querySelectorAll(selector)) {
		before.set(node, node.getBoundingClientRect().top);
	}
	mutate();
	for (const node of container.querySelectorAll(selector)) {
		const was = before.get(node);
		if (was === undefined) continue;
		const now = node.getBoundingClientRect().top;
		const delta = was - now;
		if (Math.abs(delta) < 1) continue;
		node.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], {
			duration: 240,
			easing: TAP.easing,
		});
	}
}

export const MOTION = { TAP, POP, SHEET, SAMPLES };
