/**
 * 生成更新签名用的 Ed25519 密钥对（跑一次就够）。
 *
 * 私钥留在发布机（默认 `~/.solo-update-key.pem`，权限 600，不进仓库）；
 * 公钥写进 `desktop/src/update-key.ts`，随应用一起编译。
 * 换钥匙 = 已经装出去的版本再也验不过新清单，所以生成后要妥善保管。
 *
 *   npm run update:key
 *   npm run update:key -- --out /path/to/key.pem
 */
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { out: { type: "string" } } });
const out = values.out ?? join(homedir(), ".solo-update-key.pem");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;

writeFileSync(out, privatePem, { mode: 0o600 });
chmodSync(out, 0o600);

writeFileSync(
	new URL("../desktop/src/update-key.ts", import.meta.url),
	"/** 更新清单的 Ed25519 公钥。`npm run update:key` 生成；私钥不在仓库里。 */\n" +
		`export const UPDATE_PUBLIC_KEY = ${JSON.stringify(publicPem)};\n`,
);

console.log(`私钥：${out}（权限 600，别提交、别外传）`);
console.log("公钥：desktop/src/update-key.ts");
