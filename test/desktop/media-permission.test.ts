/**
 * 麦克风权限那两句话：放不放、启动时写什么。
 * 这两个函数只决定「说给人听的那一句」——真接线在 `main.ts`，这里只钉文案和判据。
 */
import { describe, expect, it } from "vitest";
import { decideMedia, describeMicrophone } from "../../desktop/src/media-permission.ts";

describe("放不放媒体权限", () => {
	it("只要音频就放", () => {
		expect(decideMedia("media", ["audio"]).allow).toBe(true);
		// 没标类型也按音频放：老版本 Electron 不带 mediaTypes。
		expect(decideMedia("media", undefined).allow).toBe(true);
		expect(decideMedia("media", []).allow).toBe(true);
	});

	it("带摄像头或屏幕的一律拒，理由里写清是什么", () => {
		const video = decideMedia("media", ["audio", "video"]);
		expect(video.allow).toBe(false);
		expect(video.reason).toContain("video");
		expect(decideMedia("media", ["video"]).allow).toBe(false);
	});

	it("别的权限不放", () => {
		expect(decideMedia("notifications", undefined).allow).toBe(false);
		expect(decideMedia("geolocation", ["audio"]).allow).toBe(false);
	});
});

describe("启动时的麦克风状态那句话", () => {
	it("四种状态各有各的说法，一个都不许含糊", () => {
		expect(describeMicrophone("granted")).toContain("已允许");
		expect(describeMicrophone("not-determined")).toContain("还没问过");
		// 被拒时得告诉人去哪儿改，只说「没权限」等于没说。
		expect(describeMicrophone("denied")).toContain("隐私与安全性");
		expect(describeMicrophone("restricted")).toContain("限制");
	});

	it("不认识的状态也照原样写出来，别装作正常", () => {
		expect(describeMicrophone("weird")).toContain("weird");
	});
});
