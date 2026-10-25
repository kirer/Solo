/**
 * 决策路由（re-export）。
 *
 * 实现已迁到 `src/domain/routing.ts`：它是纯函数，本就不该和 IO 混在一起。
 * 这里保留文件是为了让现有调用方的 import 路径不变。
 */
export * from "../domain/routing.ts";
