/**
 * 头像：一张插画，由服务端按名字画好（`GET /api/avatar/:seed`）。
 *
 * 为什么不在前端画：插画头像要换肤色、发型、眼镜、表情、衣服色 —— 那是一套几百条路径的
 * 图形库。打进 bundle 是几百 KB，画在一屏几十张脸上是几十毫秒；放到服务端只算一次，
 * 内容由 seed 决定、永不变，浏览器长缓存之后就是一张本地图片。
 *
 * 这个文件只剩两件事：**算种子**和**给尺寸**。
 * - 种子取 `slug`：改显示名不该换脸（同一个人，改了称呼还是他）。
 * - 请求 2 倍尺寸给高清屏，服务端夹在 16–256。
 */

/**
 * 脸的状态。只影响 `data-state`，由 CSS（`motion.css` 的 `.av[data-state=…]`）决定动不动：
 * 认得的只有 thinking / working / done，其余一律静止。
 */
type AvatarState = "idle" | "thinking" | "working" | "done";

/** 画一张脸要的输入。`slug` 定脸，`name` 只在没 slug 时当退路。 */
type AvatarSpec = {
	slug?: string | undefined;
	name?: string | undefined;
	size?: number | undefined;
	state?: AvatarState | undefined;
};

/** 同一组输入的字符串是常量：一屏几十行就是几十张脸，不必每行拼一遍。 */
const CACHE = new Map<string, string>();

/**
 * @param spec 见 {@link AvatarSpec}
 * @returns 一个 `<img>` 字符串（消费者的 `__html` 直接塞进去）
 */
export function avatarSvg({ slug, name, size = 24, state = "idle" }: AvatarSpec): string {
	const seed = slug || name || "anon";
	const px = Math.max(1, Math.round(size));
	const cacheKey = `${seed}|${px}|${state}`;
	const hit = CACHE.get(cacheKey);
	if (hit !== undefined) return hit;

	// 座位尺寸可能是小数（比例分配出来的），请求时取整；服务端还会再过一遍区间。
	const src = `/api/avatar/${encodeURIComponent(seed)}?size=${String(Math.round(px * 2))}`;
	const img = `<img class="av" data-state="${state}" src="${src}" width="${String(px)}" height="${String(
		px,
	)}" alt="" aria-hidden="true" decoding="async" draggable="false">`;
	CACHE.set(cacheKey, img);
	return img;
}

/** 一个座位：左上角坐标与直径，单位 px（相对群头像的边长盒）。 */
type Seat = { x: number; y: number; d: number };

/** 2×2 / 对角 / 品字的座位表。返回 [{x,y,d}]，坐标单位是 px。 */
function seatsFor(count: number, size: number): Seat[] {
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

/** 群头像里坐着的一个人：`slug` 决定脸，`label` 只是没有 slug 时的退路。 */
type AvatarPerson = {
	slug?: string | undefined;
	label?: string | undefined;
};

/** 群头像的输入。`people` 按顺序坐，超过 4 个的不画（见 groupAvatar 的小尺寸规则）。 */
type GroupAvatarSpec = {
	people?: readonly AvatarPerson[] | undefined;
	size?: number | undefined;
	state?: AvatarState | undefined;
};

/**
 * 群组头像：不叠、不用负 margin —— 给后画的座位「挖洞」，交界才不会糊成一片。
 * 每个洞是一条 radial-gradient；多条用 mask-composite:intersect 求交。
 * r + 0.5 那个半像素是抗锯齿的关键，去掉就会出现一圈毛边。
 *
 * @param spec 见 {@link GroupAvatarSpec}
 * @returns 内联 HTML 字符串
 */
export function groupAvatar({ people = [], size = 24, state = "idle" }: GroupAvatarSpec): string {
	// 24px 那一档放不下 2×2（每张只剩 11px，四张糊成一堆点），所以小尺寸只排对角两张。
	const shown = people.slice(0, size < 28 ? 2 : 4);
	if (shown.length <= 1) {
		const only = shown[0] ?? { slug: "all", label: "全员" };
		return `<span class="av-g" style="width:${size}px;height:${size}px">${avatarSvg({
			slug: only.slug,
			name: only.label,
			size,
			state,
		})}</span>`;
	}

	const seats = seatsFor(shown.length, size);
	const parts = seats.map((seat, index) => {
		const person = shown[index];
		// 座位数与 `shown.length` 同长（`seatsFor` 对 1–4 张正好各排 1/2/3/4 个座位），
		// 走到这里必然有人；`undefined` 只是把下标访问的类型收窄掉，缺座就空着。
		if (person === undefined) return "";
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
		return `<span class="av-seat" style="left:${seat.x}px;top:${seat.y}px;width:${seat.d}px;height:${
			seat.d
		}px;${mask}">${avatarSvg({ slug: person.slug, name: person.label, size: seat.d, state })}</span>`;
	});

	return `<span class="av-g" style="width:${size}px;height:${size}px">${parts.join("")}</span>`;
}
