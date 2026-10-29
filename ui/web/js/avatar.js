/**
 * 头像：一个 slug 画出一个人。纯 SVG，没有图片、没有 emoji、没有字母色块。
 *
 * 三件事决定它「像一个人」而不是一个图标：
 *   1. 外形按 slug 的哈希分成三族（圆胖 / 带角 / 方肩）。
 *   2. 眼睛是**画上去**的两块 --av-eye 色，不是 <mask> 挖的洞。
 *      原先用 mask 是为了「眼睛透出纸色、歪头时跟着形状走」，但代价是每张脸
 *      都带一份 <defs><mask>，而且动画（av-bob）每一帧都要重新栅格化蒙版 ——
 *      一屏几十张脸时这是 CPU 大户。实测眼睛的矩形在三个外形里都在脸内部，
 *      直接画两块颜色完全等价，视觉上一像素不差，省掉全部 defs。
 *   3. 底色只做身份，不做数据：明度 > 92%，色相固定间隔 60°，
 *      相邻两个人永远不会撞成一个色。
 */

/** 色相固定间隔 60°，明度 93–95%，饱和度压到 40% 上下。 */
const TONES = [
	"hsl(14 52% 93%)",
	"hsl(74 44% 93%)",
	"hsl(134 40% 93%)",
	"hsl(194 46% 93%)",
	"hsl(254 48% 93%)",
	"hsl(314 46% 93%)",
];

/** 三族外形（100×100 单位盒）。都在 14–88 之间，留出描边和形变的余量。 */
const BODIES = [
	// 0 圆胖：肩膀很软，最年轻
	"M50 14C69.3 14 85 28.4 85 49.4 85 71.6 70.6 87 50 87 29.4 87 15 71.6 15 49.4 15 28.4 30.7 14 50 14Z",
	// 1 带角：两个角是独立的路径，画在身体之前
	"M50 24C67 24 81 36 81 55 81 74 67 88 50 88 33 88 19 74 19 55 19 36 33 24 50 24Z",
	// 2 方肩：一条平顶的肩线，最像「管事的人」
	"M30 21H70C78 21 82 26 82 34V56C82 75 68 88 50 88 32 88 18 75 18 56V34C18 26 22 21 30 21Z",
];

const HORNS = "M27.5 27 22 9.5 41 19.5ZM72.5 27 78 9.5 59 19.5Z";

/**
 * 缓存：同一个 slug + 尺寸 + 状态画出来的字符串是常量。
 *
 * 为什么值得缓存：一屏几十行就是几十张脸，每行都重新拼一遍 SVG 字符串
 * （几十次字符串拼接 + 哈希）纯属重复劳动。缓存后同一张脸一屏只拼一次。
 * 因为没有 `<mask id>` 那种「必须全局唯一」的东西了，字符串可以安全复用。
 */
const CACHE = new Map();

/** FNV-1a：稳定、够散、不依赖运行环境。 */
function hash(text) {
	let h = 2166136261;
	for (const ch of String(text)) {
		h ^= ch.codePointAt(0) ?? 0;
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/**
 * 老板的脸固定下来，不走哈希。
 *
 * 为什么：`owner` 不在 `people` 名册里（他是人，不是 agent），哈希出来是「圆胖」那族，
 * 和另外六七个人撞成同一种脸。老板的消息在界面上必须一眼认出来 —— 它是这个产品的
 * 主语。所以固定成「方肩」（第三族，最像管事的人）+ 暖色调（和强调色同一支色相），
 * 不论在哪个频道、不管名册里多了一个人，他的脸都不变。
 */
const OWNER_SLUG = "owner";
const OWNER_LOOK = { shape: 2, tone: "hsl(14 52% 91%)" };

/**
 * @param {{slug?:string,name?:string,size?:number,state?:"idle"|"thinking"|"working"|"done"}} spec
 * @returns {string} 内联 SVG 字符串
 */
export function avatarSvg({ slug, name, size = 24, state = "idle" }) {
	const key = slug || name || "anon";
	const cacheKey = `${key}|${size}|${state}`;
	const hit = CACHE.get(cacheKey);
	if (hit !== undefined) return hit;

	const shape = key === OWNER_SLUG ? OWNER_LOOK.shape : hash(key) % BODIES.length;
	const tone = key === OWNER_SLUG ? OWNER_LOOK.tone : TONES[hash(`${key}:tone`) % TONES.length];

	const horns =
		shape === 1
			? `<path d="${HORNS}" fill="${tone}" stroke="var(--ink)" stroke-width="3" stroke-linejoin="round"/>`
			: "";

	// 眼睛：两块圆角矩形，直接填 --av-eye（和原来蒙版挖出来的颜色相同）。
	const svg = `<svg class="av" data-shape="${shape}" data-state="${state}" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
	<g class="av-b">${horns}<path class="av-body" d="${BODIES[shape]}" fill="${tone}" stroke="var(--ink)" stroke-width="3" stroke-linejoin="round"/><g class="av-eyes" fill="var(--av-eye)"><rect x="32" y="44.5" width="10.5" height="15" rx="5.25"/><rect x="57.5" y="44.5" width="10.5" height="15" rx="5.25"/></g></g>
</svg>`;
	CACHE.set(cacheKey, svg);
	return svg;
}

/** 2×2 / 对角 / 品字的座位表。返回 [{x,y,d}]，坐标单位是 px。 */
function seatsFor(count, size) {
	if (count <= 1) return [{ x: 0, y: 0, d: size }];
	if (count === 2) {
		const d = (size * 2) / 3;
		return [
			{ x: 0, y: 0, d },
			{ x: size - d, y: size - d, d },
		];
	}
	if (count === 3) {
		const d = (size * 5) / 9;
		return [
			{ x: (size - d) / 2, y: 0, d },
			{ x: 0, y: size - d, d },
			{ x: size - d, y: size - d, d },
		];
	}
	// 4+：2×2，gutter 各占 4%
	const d = size / 2 - size * 0.04;
	const far = size - d;
	return [
		{ x: 0, y: 0, d },
		{ x: far, y: 0, d },
		{ x: 0, y: far, d },
		{ x: far, y: far, d },
	];
}

/**
 * 群组头像：不叠、不用负 margin —— 给后画的座位「挖洞」，交界才不会糊成一片。
 * 每个洞是一条 radial-gradient；多条用 mask-composite:intersect 求交。
 * r + 0.5 那个半像素是抗锯齿的关键，去掉就会出现一圈毛边。
 *
 * @param {{people?:Array<{slug?:string,label?:string}>,size?:number,state?:string}} spec
 * @returns {string}
 */
export function groupAvatar({ people = [], size = 24, state = "idle" }) {
	// 24px 那一档放不下 2×2（每张只剩 11px，四张糊成一堆点），所以小尺寸只排对角两张。
	const shown = people.slice(0, size < 28 ? 2 : 4);
	if (shown.length <= 1) {
		const only = shown[0] ?? { slug: "company", label: "公司" };
		return `<span class="av-g" style="width:${size}px;height:${size}px">${avatarSvg({
			slug: only.slug,
			name: only.label,
			size,
			state,
		})}</span>`;
	}

	const seats = seatsFor(shown.length, size);
	const parts = seats.map((seat, index) => {
		const holes = seats.slice(0, index).map((prev) => {
			const cx = prev.x + prev.d / 2 - seat.x;
			const cy = prev.y + prev.d / 2 - seat.y;
			const r = prev.d / 2 + 0.5;
			return `radial-gradient(circle at ${cx.toFixed(2)}px ${cy.toFixed(2)}px, transparent ${r.toFixed(
				2,
			)}px, #000 ${(r + 0.5).toFixed(2)}px)`;
		});
		const mask = holes.length
			? `mask-image:${holes.join(",")};mask-composite:intersect;-webkit-mask-image:${holes.join(
					",",
				)};-webkit-mask-composite:source-in;`
			: "";
		const person = shown[index];
		return `<span class="av-seat" style="left:${seat.x}px;top:${seat.y}px;width:${seat.d}px;height:${
			seat.d
		}px;${mask}">${avatarSvg({ slug: person.slug, name: person.label, size: seat.d, state })}</span>`;
	});

	return `<span class="av-g" style="width:${size}px;height:${size}px">${parts.join("")}</span>`;
}
