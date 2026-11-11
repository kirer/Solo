import { describe, expect, it } from "vitest";
import { createLoadQueue } from "../../ui/app/src/state/load-queue.ts";

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe("补历史单页闸门", () => {
	it("并发要：只跑一次 load", async () => {
		let runs = 0;
		let release: () => void = () => {};
		const queue = createLoadQueue(async () => {
			runs += 1;
			await new Promise<void>((done) => {
				release = done;
			});
		});
		queue.want();
		queue.want();
		queue.want();
		expect(runs).toBe(1);
		release();
		await settle();
		// 默认不再续：这一页回来就停，要补得有人重新要。
		expect(runs).toBe(1);
		expect(queue.busy()).toBe(false);
	});

	it("默认一页就是一次，不会自己连下去", async () => {
		let runs = 0;
		const queue = createLoadQueue(async () => {
			runs += 1;
		});
		queue.want();
		await settle();
		expect(runs).toBe(1);
		queue.want();
		await settle();
		expect(runs).toBe(2);
	});

	it("给了 continue 判据，还在要且判据为真时才续一页", async () => {
		let runs = 0;
		let more = false;
		const queue = createLoadQueue(
			async () => {
				runs += 1;
			},
			() => more,
		);
		queue.want();
		await settle();
		expect(runs).toBe(1);

		// 判据为真、并且有人在要，才续一页；一次只续一页。
		more = true;
		queue.want();
		queue.want();
		await settle();
		await settle();
		expect(runs).toBe(3);

		more = false;
		queue.want();
		queue.want();
		await settle();
		await settle();
		expect(runs).toBe(4);
	});

	it("load 抛了也不卡死：下一次还叫得动", async () => {
		let runs = 0;
		const queue = createLoadQueue(async () => {
			runs += 1;
			throw new Error("网络断了");
		});
		queue.want();
		await settle();
		expect(queue.busy()).toBe(false);
		queue.want();
		await settle();
		expect(runs).toBe(2);
	});
});
