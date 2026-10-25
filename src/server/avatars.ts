/**
 * 头像：给每个人一张**真实的插画头像**，而不是首字母方块。
 *
 * ── 为什么不用首字母 ──
 *
 * 首字母方块（`林`、`许`）在聊天界面里几乎不可读：中文名字的第一个字
 * 区分度极低（「林越」「林墨」都是「林」），而且它没有提供任何「这是一个人」的
 * 直觉。微信、飞书、Slack 都用真实头像，因为头像的作用是**扫视时快速认人**，
 * 不是占位。
 *
 * ── 怎么做 ──
 *
 * 用 DiceBear（`@dicebear/core` + `@dicebear/collection`）在**服务端**生成 SVG：
 *
 * - seed = 名字 + 角色 → 同一个人永远同一张脸（重启、换设备都不变）
 * - 老板用 `notionists`（干净的手绘人物），员工用 `micah` / `lorelei` 系列
 * - 输出是纯 SVG 字符串，无外部请求、无隐私问题、体积 2–4KB
 *
 * ── 为什么不放前端 ──
 *
 * 前端生成需要把 DiceBear 打进 bundle（几十个样式，体积大）；
 * 服务端生成一次、加 HTTP 缓存，客户端零成本。而且头像属于「人的属性」，
 * 应该在服务端有唯一答案（和 label 一样）。
 */
import { createAvatar } from "@dicebear/core";
import { micah } from "@dicebear/collection";

/**
 * 头像风格：**全公司只用一套**。
 *
 * 试过「按名字哈希挑风格」（notionists / micah / lorelei / pixelArt 混着来），
 * 结果是像素风的人和手绘风的人并排出现，看起来像从四个网站上抠来的图标，
 * 而不是同一家公司的同事。统一成一套之后，整列头像才像一个团队。
 *
 * 选 `micah`：真实肤色 + 明确发型 + 平涂配色，在深色背景上仍然有分量；
 * 对比过 notionists（纯线稿，深色下糊成一片）、lorelei（灰白，区分度低）、
 * avataaars（卡通感过强，像客服机器人）。区分度靠 **seed**（名字决定肤色、
 * 发型、眼镜、表情、衣服色），不靠换画风。
 */
const STYLE = micah;

export type AvatarStyle = "micah";

/**
 * 生成一张头像 SVG。
 *
 * @param seed 稳定标识（通常是人名；老板传 `"老板"`）
 * @param size 像素尺寸，默认 96
 */
export function avatarSvg(seed: string, size = 96): string {
	const style = STYLE as unknown as Parameters<typeof createAvatar>[0];
	return createAvatar(style, {
		seed,
		size,
		// 圆角由 CSS 控制，这里给方图
		radius: 0,
		randomizeIds: true,
	}).toString();
}

/** 头像的 ETag：名字 + 尺寸决定内容，内容永不变，所以可以长缓存。 */
export function avatarEtag(seed: string, size: number): string {
	return `"av-${Buffer.from(`${seed}:${size}`).toString("base64url")}"`;
}
