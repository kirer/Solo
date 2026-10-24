/**
 * 用量文档的转发。
 *
 * 业务层需要读会话的 token 与成本，但用量文档定义在底层库里（ADR-001）。
 * 这里转发它的 token 与类型，业务层只依赖本模块。
 */
export { UsageDoc, type UsageState } from "@earendil-works/pi-durable";
