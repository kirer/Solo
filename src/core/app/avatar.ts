/**
 * 头像：用 DiceBear（`@dicebear/core` + `@dicebear/collection`）生成**真实插画**头像。
 *
 * 为什么不用首字母、也不用自己画的几何脸：头像的作用是「扫视时快速认人」。
 * 中文名首字区分度极低（「林越」「林墨」都是「林」），几何脸（一个身体 + 两个点）
 * 一屏几十张全是同一个意思 —— 谁是谁得靠旁边的名字读。插画头像靠 seed 换掉
 * 肤色、发型、眼镜、表情、衣服色，整列排下来才像一个团队。
 *
 * 三条约束：
 * - **同一个人永远同一张脸**：seed 是名字，不掺时间/随机数。
 * - **服务端生成**：客户端零请求成本，也不用把几个画风打进 bundle；SVG 2–4 KB，
 *   内容由 seed 决定、永不变，所以可以长缓存。
 * - **全公司一套画风**：`micah`。混着用 notionists / pixelArt 会像从四个网站抠来的图标。
 */
import { createAvatar } from "@dicebear/core";
import { micah } from "@dicebear/collection";

/** 规格：尺寸夹在 16–256，免得有人 `?size=999999` 把服务端画爆。 */
export const AVATAR_MIN = 16;
export const AVATAR_MAX = 256;
export const AVATAR_DEFAULT = 64;

/**
 * 底色：六支淡彩，色相各差 60°，明度 93% 上下 —— 和原来那套纸感底色同一个意思，
 * 但现在是插画背后的圆底，不是整张脸的形状。相邻的人撞色的概率很低，撞了也不影响认人：
 * 认人的是发型和表情。
 */
const BACKDROPS = ["efd9cf", "ebe4c9", "d5e8d8", "d2e4ee", "ded8ee", "ecd3e5"] as const;

/** 把任意尺寸收进允许区间；不是有限数就用默认值。 */
export function clampAvatarSize(size: number | undefined): number {
	if (size === undefined || !Number.isFinite(size)) return AVATAR_DEFAULT;
	return Math.min(AVATAR_MAX, Math.max(AVATAR_MIN, Math.round(size)));
}

/** FNV-1a：稳定、够散、不依赖运行环境。 */
function hash(text: string): number {
	let value = 2166136261;
	for (const ch of text) {
		value ^= ch.codePointAt(0) ?? 0;
		value = Math.imul(value, 16777619);
	}
	return value >>> 0;
}

/** 一张头像的 SVG。`seed` 通常是显示名；同一个 seed 永远画出同一张脸。 */
export function avatarSvg(seed: string, size: number = AVATAR_DEFAULT): string {
	const bounded = clampAvatarSize(size);
	const backdrop = BACKDROPS[hash(`${seed}:bg`) % BACKDROPS.length] ?? BACKDROPS[0];
	return createAvatar(micah, {
		seed,
		size: bounded,
		// 圆角由 CSS 控制，这里给方图；id 随机化，多个 SVG 内联到同一页也不打架。
		radius: 0,
		// 只取上半身：插画原稿是一张半身像，脸只占中间四成。头像这个尺寸里
		// 认人的是脸，所以放大并把视线挪到中间。
		scale: 170,
		translateY: 18,
		backgroundColor: [backdrop],
		// id 不随机：这张 SVG 是独立文档（`<img src>`），不会和别的头像撞 id，
		// 而字节必须稳定 —— ETag 是按 seed + 尺寸算的，内容一变它就不准了。
		randomizeIds: false,
	}).toString();
}

/** 头像的 ETag：seed + 尺寸决定内容，内容永不变，所以可以长缓存。FNV-1a，不碰 node 的 crypto。 */
export function avatarEtag(seed: string, size: number): string {
	return `"av-${hash(`${seed}:${String(size)}`).toString(36)}-${String(size)}"`;
}
