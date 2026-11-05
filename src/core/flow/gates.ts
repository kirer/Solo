/**
 * 进程级的串行闸。
 *
 * 两份，用途不同，都必须整个进程一份：
 * - `publish`：保护 commit 之前的「读—算—写—扇出」（ADR-073）。两个 `say` 同时进来，
 *   其中一个可能拿到已释放的读覆盖层，报错而消息其实已经写进去；
 * - `repost`：保护收尾的「读答案 → 判重 → 补发」。两条提交同时结算会各跑一次收尾，
 *   都快照到「频道里还没有这句」，同一句话发两遍（实测 2026-11-02）。
 *
 * 装配层应当只建一份并往下传（Phase 4 会把创建挪进 `shell/`）；这里先给旧调用点一个
 * 共享的默认值，避免每个入口各建一把锁 —— 各建一把等于没串。
 */
import { createSerialGate } from "../runtime/io.ts";
import type { FlowGates } from "./ports.ts";

let shared: FlowGates | undefined;

export function sharedGates(): FlowGates {
	shared ??= { publish: createSerialGate(), repost: createSerialGate() };
	return shared;
}
