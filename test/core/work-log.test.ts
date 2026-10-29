/**
 * 命令日志该不该落进频道（ADR-071）。
 *
 * 现场：`run` 每跑一条命令就往 `personalId(slug)` 记一行 `kind:"work"`，而老板的个人频道
 * 就是 `dm:owner-<slug>` —— 同一个房间。实测一个私聊里堆到几百条 `$ cd /Users/...`，
 * 侧栏预览整列变成命令行（老板看不出这个频道里有没有人在说话）。
 */
import { describe, expect, it } from "vitest";
import { shouldLogWork } from "../../src/core/channel/tools.ts";
import type { Channel } from "../../src/core/channel/state.ts";

const AT = 1_700_000_000_000;
const channelOf = (id: string, members: readonly string[]) =>
	({ id, title: id, members, wakeOnAll: [], createdAt: AT }) as Channel;

describe("命令日志落到哪", () => {
	it("老板的私聊不记 —— 那是对话，不是日志", () => {
		expect(shouldLogWork(channelOf("dm:owner-linyue", ["owner", "linyue"]))).toBe(false);
	});

	it("员工之间的私聊照记（那是他自己的工作台）", () => {
		expect(shouldLogWork(channelOf("dm:linyue--shenan", ["linyue", "shenan"]))).toBe(true);
	});

	it("项目频道照记", () => {
		expect(shouldLogWork(channelOf("proj:solo", ["owner", "linyue"]))).toBe(true);
	});

	it("频道不存在就不写", () => {
		expect(shouldLogWork(undefined)).toBe(false);
	});
});
