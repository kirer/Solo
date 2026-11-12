/**
 * 验签：一份文件的原文 + 旁边那份 detached 签名（base64）+ 发布公钥，问「是不是作者发的」。
 *
 * **服务端这一份**：插件清单 `plugins.json`（`src/shell/plugin-download.ts`）。
 *
 * 更新清单的验签在 `desktop/src/manifest.ts`，是另一份实现（WebCrypto）——**桌面壳那份 tsconfig 的
 * `rootDir` 就是 `desktop/src`，引不到 `src/` 下任何文件**，硬合只会把主进程的输出目录冲掉。
 * 两边算法一样、公钥一样（`src/core/update-key.ts` 与 `desktop/src/update-key.ts` 必须一字不差，
 * `test/core/update-key.test.ts` 盯着），清单文件各是各的。
 */
import { createPublicKey, verify } from "node:crypto";

/** 签名是不是这份公钥对这段原文签的。签名是 base64，带不带换行都认。 */
export function verifySignature(publicKeyPem: string, text: string, signature: string): boolean {
	try {
		return verify(null, Buffer.from(text, "utf8"), createPublicKey(publicKeyPem), Buffer.from(signature.trim(), "base64"));
	} catch {
		return false;
	}
}
