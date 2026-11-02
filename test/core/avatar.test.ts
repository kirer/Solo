/**
 * 头像的画法（ADR-007）。
 *
 * 三件事必须钉住，否则界面上就会悄悄坏掉：
 * 1. **同一张脸永远同一张**：种子相同 → 字节相同。ETag 是按 seed + 尺寸算的，
 *    内容只要掺了随机数（比如 `randomizeIds`），这张 ETag 就是假的。
 * 2. **尺寸有上限**：`?size=999999` 不许把服务端画爆。
 * 3. **种子的差异要看得出来**：两个人画出来不能是同一张图。
 */
import { describe, expect, test } from "vitest";
import { AVATAR_DEFAULT, AVATAR_MAX, AVATAR_MIN, avatarEtag, avatarSvg, clampAvatarSize } from "../../src/app/avatar.ts";

describe("头像", () => {
	test("同一个 seed 画出来逐字节相同", () => {
		expect(avatarSvg("林越", 64)).toBe(avatarSvg("林越", 64));
	});

	test("不同的 seed 是不同的脸", () => {
		expect(avatarSvg("林越", 64)).not.toBe(avatarSvg("沈舟", 64));
	});

	test("是一张独立可用的 SVG", () => {
		const svg = avatarSvg("林越", 48);
		expect(svg.startsWith("<svg")).toBe(true);
		expect(svg).toContain('width="48"');
		expect(svg).toContain('height="48"');
	});
});

describe("尺寸", () => {
	test("夹在 16–256", () => {
		expect(clampAvatarSize(1)).toBe(AVATAR_MIN);
		expect(clampAvatarSize(10_000)).toBe(AVATAR_MAX);
		expect(clampAvatarSize(24)).toBe(24);
	});

	test("缺省与非法值都用 64", () => {
		expect(clampAvatarSize(undefined)).toBe(AVATAR_DEFAULT);
		expect(clampAvatarSize(Number.NaN)).toBe(AVATAR_DEFAULT);
		expect(clampAvatarSize(Number.POSITIVE_INFINITY)).toBe(AVATAR_DEFAULT);
	});

	test("画出来的尺寸也真的被夹住", () => {
		expect(avatarSvg("林越", 10_000)).toContain(`width="${String(AVATAR_MAX)}"`);
	});
});

describe("ETag", () => {
	test("同一份内容同一个 ETag", () => {
		expect(avatarEtag("林越", 64)).toBe(avatarEtag("林越", 64));
	});

	test("换人或换尺寸就换 ETag", () => {
		expect(avatarEtag("林越", 64)).not.toBe(avatarEtag("沈舟", 64));
		expect(avatarEtag("林越", 64)).not.toBe(avatarEtag("林越", 96));
	});
});
