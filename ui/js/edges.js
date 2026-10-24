/**
 * 沟通连线层：SVG 贝塞尔，实线底 + 一段沿路径慢速移动的短划表示方向。
 *
 * 这一层只负责几何与动画，不决定「该画哪条边」：
 * org.js 传进来的 anchors 是 Map<conversationId, Element>，
 * 项目没翻面时员工端点已经被聚合成项目卡，所以这里拿到的首尾天然是可见元素。
 *
 * 渲染是增量的：已经存在的边只更新 d / opacity / 状态，不重建元素，
 * 这样 SSE 每次推送都不会把流动动画打断。
 */
import { clamp } from "./format.js";

const SVG_NS = "http://www.w3.org/2000/svg";
/** 只画 20 分钟内的沟通。 */
const WINDOW_MS = 24 * 60 * 60_000;
/** 最近 60 秒的边带一个沿路径移动的光点。 */
const FRESH_MS = 6 * 60 * 60_000;
/** 最多 20 条，避免组织图变成蜘蛛网。 */
const MAX_EDGES = 16;
/**
 * 双向沟通时两条线的并排距离。
 * 用端点错开的方式让开，而不是把控制点整体横移，否则两条曲线中段会交叉。
 */
const LANE_GAP = 11;

export function createEdges(svg) {
	const entries = new Map();
	let links = [];
	let anchors = new Map();
	let focus = null;

	const elementIds = new WeakMap();
	let nextElementId = 0;

	const round = (value) => Math.round(value * 10) / 10;
	const svgNode = (name) => document.createElementNS(SVG_NS, name);
	const normalizeId = (value) => {
		if (value === null || value === undefined || value === "") return null;
		const id = Number(value);
		return Number.isFinite(id) ? id : null;
	};

	function pairId(element) {
		let id = elementIds.get(element);
		if (id === undefined) {
			nextElementId += 1;
			id = nextElementId;
			elementIds.set(element, id);
		}
		return id;
	}

	/**
	 * 两个矩形之间的一条平滑曲线。
	 *
	 * 竖向为主的相邻层级走上下边，横向为主的同层走左右边；
	 * `bow` 把控制点推开，双向沟通时两条线才不会重叠成一条。
	 */
	function pathOf(a, b, lane = 0) {
		const dx = b.cx - a.cx;
		const dy = b.cy - a.cy;

		if (Math.abs(dy) >= Math.abs(dx) * 0.6) {
			const down = dy >= 0;
			// 并列的两条边从各自的边缘错开，中段自然分开而不交叉
			const x1 = a.cx + lane;
			const y1 = down ? a.top + a.height : a.top;
			const x2 = b.cx + lane;
			const y2 = down ? b.top : b.top + b.height;
			const midY = (y1 + y2) / 2;
			return `M ${round(x1)} ${round(y1)} C ${round(x1)} ${round(midY)}, ${round(x2)} ${round(midY)}, ${round(x2)} ${round(y2)}`;
		}

		const right = dx >= 0;
		const x1 = right ? a.left + a.width : a.left;
		const y1 = a.cy + lane;
		const x2 = right ? b.left : b.left + b.width;
		const y2 = b.cy + lane;
		const midX = (x1 + x2) / 2;
		return `M ${round(x1)} ${round(y1)} C ${round(midX)} ${round(y1)}, ${round(midX)} ${round(y2)}, ${round(x2)} ${round(y2)}`;
	}

	/** 过滤 + 聚合后去重 + 取最新 20 条，同时算出各自的矩形。 */
	function collect() {
		if (svg === null) return [];
		const base = svg.getBoundingClientRect();
		if (base.width < 2 || base.height < 2) return [];

		const rectCache = new Map();
		const rectOf = (element) => {
			const cached = rectCache.get(element);
			if (cached !== undefined) return cached;
			const box = element.getBoundingClientRect();
			const rect = {
				left: box.left - base.left,
				top: box.top - base.top,
				width: box.width,
				height: box.height,
				cx: box.left - base.left + box.width / 2,
				cy: box.top - base.top + box.height / 2,
			};
			rectCache.set(element, rect);
			return rect;
		};

		const now = Date.now();
		const latest = new Map();

		for (const link of links) {
			if (link === null || link === undefined) continue;
			const from = Number(link.from);
			const to = Number(link.to);
			// 自环（升级链）不画
			if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) continue;
			const at = Number(link.at ?? 0);
			if (!Number.isFinite(at) || now - at > WINDOW_MS) continue;
			const start = anchors.get(from);
			const end = anchors.get(to);
			if (start === undefined || end === undefined || start === end) continue;
			const key = `${from}:${to}`;
			const previous = latest.get(key);
			if (previous !== undefined && previous.at >= at) continue;
			latest.set(key, { from, to, at, kind: String(link.kind ?? "delegate"), start, end });
		}

		const sorted = [...latest.values()].sort((a, b) => b.at - a.at);
		const taken = new Set();
		const kept = [];
		for (const item of sorted) {
			const rectA = rectOf(item.start);
			const rectB = rectOf(item.end);
			if (rectA.width < 2 || rectA.height < 2 || rectB.width < 2 || rectB.height < 2) continue;
			// 聚合之后可能落到同一张卡上：只保留最新的那条
			const pairKey = `${pairId(item.start)}:${pairId(item.end)}`;
			if (taken.has(pairKey)) continue;
			taken.add(pairKey);
			kept.push({
				...item,
				rectA,
				rectB,
				pairKey,
				reverseKey: `${pairId(item.end)}:${pairId(item.start)}`,
			});
			if (kept.length >= MAX_EDGES) break;
		}
		return kept;
	}

	function createEntry(item) {
		const group = svgNode("g");
		group.setAttribute("class", "edge");
		const line = svgNode("path");
		line.setAttribute("class", "edge-line");
		// 归一化路径长度：不同长度的边能用同一套 dasharray / 动画时长
		line.setAttribute("pathLength", "100");
		const spark = svgNode("path");
		spark.setAttribute("class", "edge-spark");
		spark.setAttribute("pathLength", "100");
		group.append(line, spark);
		svg.append(group);
		return { group, line, spark, from: item.from, to: item.to };
	}

	function applyFocus() {
		if (svg === null) return;
		const active = focus !== null;
		svg.classList.toggle("has-focus", active);
		for (const entry of entries.values()) {
			const related = active && (entry.from === focus || entry.to === focus);
			entry.group.classList.toggle("is-related", related);
		}
	}

	function draw() {
		if (svg === null) return;
		const items = collect();
		const alive = new Set();
		const directions = new Set(items.map((item) => item.pairKey));
		// from 较小的方向占一条车道：同一方向的几条边彼此平行，不会交叉
		const forwards = items.filter((item) => item.from < item.to).map((item) => item.from);
		const forwardLane = forwards.length === 0 ? 0 : Math.min(...forwards);

		for (const item of items) {
			const key = `${item.from}:${item.to}`;
			alive.add(key);
			let entry = entries.get(key);
			if (entry === undefined) {
				entry = createEntry(item);
				entries.set(key, entry);
			}

			// 双向沟通：各自朝相反方向弯开，形成一条透镜而不是叠在一起
			// 双向沟通：同一对节点之间再按 from 分组错开，两条线整体平行
			const lane = directions.has(item.reverseKey)
				? (item.from === forwardLane ? LANE_GAP : -LANE_GAP)
				: 0;
			const d = pathOf(item.rectA, item.rectB, lane);
			entry.line.setAttribute("d", d);
			entry.spark.setAttribute("d", d);
			entry.from = item.from;
			entry.to = item.to;
			entry.group.dataset.kind = item.kind;
			entry.group.dataset.from = String(item.from);
			entry.group.dataset.to = String(item.to);

			// 年龄 → 0.32 ~ 0.85 的整组透明度：越新越实
			const age = Math.max(0, Date.now() - item.at);
			const freshness = clamp(1 - age / WINDOW_MS, 0, 1);
			entry.group.setAttribute("opacity", String(round(0.32 + freshness * 0.53)));
			entry.group.classList.toggle("is-recent", age <= FRESH_MS);
		}

		for (const [key, entry] of entries) {
			if (alive.has(key)) continue;
			entry.group.remove();
			entries.delete(key);
		}

		applyFocus();
	}

	return {
		/** anchors: Map<conversationId, Element>（员工可能已聚合成项目卡）。 */
		render(nextLinks, nextAnchors, focusId) {
			links = Array.isArray(nextLinks) ? nextLinks : [];
			anchors = nextAnchors instanceof Map ? nextAnchors : new Map();
			focus = normalizeId(focusId);
			draw();
		},
		/** 用上次的数据重算（翻转结束 / resize 后）。 */
		refresh() {
			draw();
		},
		/** 悬停或选中某人时，只亮他的边。 */
		setFocus(id) {
			const next = normalizeId(id);
			if (next === focus) return;
			focus = next;
			applyFocus();
		},
		clear() {
			for (const entry of entries.values()) entry.group.remove();
			entries.clear();
			links = [];
			anchors = new Map();
			focus = null;
			if (svg !== null) svg.classList.remove("has-focus");
		},
	};
}
