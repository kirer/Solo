/**
 * 队列文档的转发。
 *
 * 老板发消息时如果会话正忙，消息会排进队列。界面需要读它来显示
 * 「已排队」——否则老板会以为消息没发出去。
 */
export { InboxDoc, type InboxItem, type InboxState } from "@earendil-works/pi-durable";
