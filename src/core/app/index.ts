/**
 * 用例层（app）的入口：把「发消息 / 读频道 / 开团队 / 招人」这些动作装成一个对象。
 *
 * 依赖方向是单向的：`interface → app → {view, domain} → runtime`。
 * 这一层**不 import `node:http`**，也不认识 request / response —— 于是同一批动作能被
 * HTTP、SSE、CLI 或测试直接调，不必假装自己是浏览器。
 *
 * 它也不 import `shell/`（装配）。装配出来的东西由调用方通过 `CoreServices` 递进来。
 */
import { dirname } from "node:path";
import { createChat } from "./chat.ts";
import { createDiag } from "./diag.ts";
import { createFiles } from "./files.ts";
import { createPeople } from "./people.ts";
import { createRead } from "./read.ts";
import { createSnapshots } from "./snapshot.ts";
import { createUploads } from "./uploads.ts";
import type { CoreServices } from "./types.ts";

export function createApp(services: CoreServices) {
	const snapshots = createSnapshots(services);
	const read = createRead(services, snapshots);
	const people = createPeople(services, snapshots, read);
	const chat = createChat(services, snapshots);
	const files = createFiles(dirname(services.agentsRoot));
	const uploads = createUploads(services);
	const diag = services.diag ?? createDiag(dirname(services.agentsRoot));
	return { snapshots, read, people, chat, files, uploads, diag };
}

export type App = ReturnType<typeof createApp>;
export { AppError } from "./errors.ts";
/**
 * 「我」是谁 —— 这一段会话的唯一主人。
 *
 * 接口层要它（SSE 里判断哪条消息该带 `needsYou`、哪条算「我发的」），但它属于身份，
 * 不能跟着接口层去 import `agent/`（分层规则禁止）。所以由用例层把它转出来：
 * 接口层只认 `app/`，身份的定义仍在 `agent/identity.ts`。
 */
export { OWNER_SLUG } from "../agent/identity.ts";
export type { CoreServices } from "./types.ts";
