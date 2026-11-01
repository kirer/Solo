/**
 * 更新清单的三件事：验签、比版本、按平台取包。
 * 验签是这条更新路线上唯一的安全边界 —— 签名不过就一个字节都不能信。
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fileFor, isNewer, parseManifest, verifyManifest } from "../../desktop/src/manifest.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;

const text = JSON.stringify({
	version: "2.0.1",
	files: { darwin: { file: "Solo-2.0.1-arm64.zip", sha512: "abc==", size: 148416516 } },
});
const signature = sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64");

describe("更新清单", () => {
	it("发布密钥签的清单能验过", () => {
		expect(verifyManifest(publicPem, text, signature)).toBe(true);
	});

	it("改一个字、换一份签名、换个密钥都过不去", () => {
		expect(verifyManifest(publicPem, text.replace("2.0.1", "2.0.2"), signature)).toBe(false);
		expect(verifyManifest(publicPem, text, Buffer.from("nope").toString("base64"))).toBe(false);
		const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }) as string;
		expect(verifyManifest(other, text, signature)).toBe(false);
	});

	it("格式不对的清单返回 undefined，不抛", () => {
		expect(parseManifest("不是 json")).toBeUndefined();
		expect(parseManifest('{"version":"2.0.1"}')).toBeUndefined();
		expect(parseManifest('{"version":"2.0.1","files":{"darwin":{"file":"x.zip"}}}')).toBeUndefined();
		expect(parseManifest(text)?.files["darwin"]?.size).toBe(148416516);
	});

	it("只比数字段，缺的位按 0 算", () => {
		expect(isNewer("2.0.1", "2.0.0")).toBe(true);
		expect(isNewer("2.1.0", "2.0.9")).toBe(true);
		expect(isNewer("2.0.0", "2.0.0")).toBe(false);
		expect(isNewer("2.0.0", "2.0.1")).toBe(false);
		expect(isNewer("2.0", "2.0.0")).toBe(false);
		expect(isNewer("2.0.0", "2.0")).toBe(false);
		expect(isNewer("3", "2.9.9")).toBe(true);
	});

	it("平台不在清单里就是没有", () => {
		const manifest = parseManifest(text);
		expect(manifest === undefined ? undefined : fileFor(manifest, "darwin")?.file).toBe("Solo-2.0.1-arm64.zip");
		expect(manifest === undefined ? undefined : fileFor(manifest, "win32")).toBeUndefined();
	});
});
