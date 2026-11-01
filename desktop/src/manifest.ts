/**
 * 更新清单：`latest-mac.json`（Windows 用 `latest-win.json`）是一个纯 JSON，
 * 旁边一份同名 `.sig` 是它的 Ed25519 签名（base64）。
 *
 * 为什么是「自己签清单」而不是 Apple 的 Squirrel：Squirrel.Mac 要求新旧 `.app` 同一个
 * Developer ID 身份，未签名构建根本装不上（ADR-029）。Sparkle / Tauri / 绝大多数
 * 开源桌面应用走的就是这一套 —— 用项目自己的密钥证明「这个包是作者发的」，
 * 系统签名交给发布流程另说。校验与版本比较都在这里，纯函数，可直接单测。
 */
import { createPublicKey, verify } from "node:crypto";

export type UpdateFile = { readonly file: string; readonly sha512: string; readonly size: number };

export type UpdateManifest = {
	readonly version: string;
	/** 按平台分的安装包；`darwin` / `win32`，和 `process.platform` 一致。 */
	readonly files: Readonly<Record<string, UpdateFile>>;
};

const isFile = (value: unknown): value is UpdateFile => {
	if (typeof value !== "object" || value === null) return false;
	const file = value as Record<string, unknown>;
	return typeof file["file"] === "string" && typeof file["sha512"] === "string" && typeof file["size"] === "number";
};

export function parseManifest(text: string): UpdateManifest | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null) return undefined;
	const value = raw as Record<string, unknown>;
	if (typeof value["version"] !== "string" || typeof value["files"] !== "object" || value["files"] === null) {
		return undefined;
	}
	const files: Record<string, UpdateFile> = {};
	for (const [platform, file] of Object.entries(value["files"] as Record<string, unknown>)) {
		if (!isFile(file)) return undefined;
		files[platform] = file;
	}
	return { version: value["version"], files };
}

/** 清单原文的签名是不是这份公钥签的。签名文件是 base64。 */
export function verifyManifest(publicKeyPem: string, text: string, signature: string): boolean {
	try {
		return verify(null, Buffer.from(text, "utf8"), createPublicKey(publicKeyPem), Buffer.from(signature.trim(), "base64"));
	} catch {
		return false;
	}
}

/**
 * `candidate` 是不是比 `current` 新。
 * 只比数字段（2.0.1 > 2.0.0）；预发布后缀当作比同号正式版旧，够用。
 * shortcut: 不实现完整的 semver 预发布优先级，等真用预发布再说。
 */
export function isNewer(candidate: string, current: string): boolean {
	const core = (version: string): number[] =>
		version.split("-")[0]?.split(".").map((part) => Number.parseInt(part, 10) || 0) ?? [];
	const a = core(candidate);
	const b = core(current);
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const left = a[index] ?? 0;
		const right = b[index] ?? 0;
		if (left !== right) return left > right;
	}
	return false;
}

export function fileFor(manifest: UpdateManifest, platform: string): UpdateFile | undefined {
	return manifest.files[platform];
}
