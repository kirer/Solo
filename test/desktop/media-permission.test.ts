/**
 * 麦克风权限那两句话：放不放、启动时写什么。
 * 这两个函数只决定「说给人听的那一句」——真接线在 `main.ts`，这里钉文案、判据，和
 * 「启动时到底做不做什么」（`askForMediaAccess` 一条：不许在启动时自己弹框）。
 */
import { readFileSync } from "node:fs";
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

/**
 * 启动时**不弹框**：弹框交给系统，在渲染侧第一次真调 `getUserMedia` 的时候。
 *
 * 这条只能读源码验 —— 「什么时候弹框」是 Electron 和 macOS 共同决定的行为，脚本里
 * 起不了真麦克风。所以这里钉死的是**我们不主动申请**，以及启动路径上只装了 handler。
 */
describe("启动时不自己弹框", () => {
	const main = readFileSync(new URL("../../desktop/src/main.ts", import.meta.url), "utf8");
	/** 只取 `setupMicrophone` 那一段：别把文件里别处的代码算进来。 */
	const body = (): string => {
		const from = main.indexOf("function setupMicrophone");
		const to = main.indexOf("function createWindow", from);
		expect(from).toBeGreaterThan(-1);
		expect(to).toBeGreaterThan(from);
		return main.slice(from, to);
	};

	it("启动路径上一次都不申请麦克风（注释之外不许出现这个调用）", () => {
		// 注释里会提到它（说明为什么不用），所以认的是调用形状 `.askForMediaAccess(`。
		expect(main).not.toMatch(/\.askForMediaAccess\s*\(/);
	});

	it("启动时只装两条 handler：请求和检查，判据都是 decideMedia", () => {
		const code = body();
		expect(code).toContain("setPermissionRequestHandler");
		expect(code).toContain("setPermissionCheckHandler");
		// 两条路必须给同一个答案，否则「弹框放行、查状态拒绝」会变成谁都查不出的怪事。
		expect(code.match(/decideMedia\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
	});

	it("启动时读一次系统状态：被拒要能在日志里看见（读状态不弹框）", () => {
		expect(body()).toContain("getMediaAccessStatus");
		expect(body()).toContain("describeMicrophone");
	});
});
