/**
 * 正文读取：**带宽高的字节流**。
 *
 * 为什么不是 `interface/http` 自己读：`readBounded` 与 `UploadTooLargeError` 住在
 * `channel/uploads.ts`（附件的上限那里就是一处定义）。接口层不许直接 import 频道
 * 内部实现（`scripts/check-boundaries.mjs` 会拦），所以在这里转一道手。
 *
 * 只有一个函数，但它是**语义**而不是转发：先读完再比上限等于没有上限
 * （一个 4GB 的请求先把内存吃光），所以必须边读边数。
 */
export { UploadTooLargeError, readBounded as readBody } from "../channel/uploads.ts";
