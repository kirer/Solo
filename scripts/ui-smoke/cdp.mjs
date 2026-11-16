// Chrome DevTools Protocol 小驱动。ego-browser 没了之后自己接。
// 用法：import { connect } from "./cdp.mjs"; const page = await connect(9223);
//   await page.goto(url); await page.eval(js); await page.click(x, y); await page.shot(path);
import { setTimeout as sleep } from "node:timers/promises";

function wsUrl(port, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	return (async function loop() {
		for (;;) {
			try {
				const res = await fetch(`http://127.0.0.1:${port}/json/list`);
				const list = await res.json();
				const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
				if (page) return page.webSocketDebuggerUrl;
			} catch {}
			if (Date.now() > deadline) throw new Error(`连不上 Chrome 调试端口 ${port}`);
			await sleep(200);
		}
	})();
}

export async function connect(port) {
	const url = await wsUrl(port);
	const ws = new WebSocket(url);
	await new Promise((ok, bad) => {
		ws.onopen = ok;
		ws.onerror = bad;
	});
	let id = 0;
	const pending = new Map();
	ws.onmessage = (e) => {
		const msg = JSON.parse(e.data);
		if (msg.id === undefined) return;
		const p = pending.get(msg.id);
		if (!p) return;
		pending.delete(msg.id);
		msg.error ? p.bad(new Error(JSON.stringify(msg.error))) : p.ok(msg.result);
	};
	const send = (method, params = {}) =>
		new Promise((ok, bad) => {
			const n = ++id;
			pending.set(n, { ok, bad });
			ws.send(JSON.stringify({ id: n, method, params }));
		});
	await send("Runtime.enable");
	await send("Page.enable");

	return {
		send,
		close: () => ws.close(),
		async goto(target) {
			await send("Page.navigate", { url: target });
			await sleep(2500);
		},
		async eval(expression) {
			const r = await send("Runtime.evaluate", {
				expression: `(async () => { ${expression} })()`,
				awaitPromise: true,
				returnByValue: true,
			});
			if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
			return r.result?.value;
		},
		async move(x, y) {
			await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
		},
		async down(x, y) {
			await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
		},
		async up(x, y) {
			await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
		},
		async click(x, y) {
			await this.move(x, y);
			await sleep(60);
			await this.down(x, y);
			await sleep(40);
			await this.up(x, y);
			await sleep(200);
		},
		async wheel(x, y, dy) {
			await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy });
		},
		async viewport(width, height, scale = 1) {
			// ego 没有这个，CDP 有：量布局前先钉死视口，别拿「差 87px 的窗口高度」当结论。
			await send("Emulation.setDeviceMetricsOverride", {
				width,
				height,
				deviceScaleFactor: scale,
				mobile: false,
			});
			await sleep(300);
		},
		async shot(path) {
			const r = await send("Page.captureScreenshot", { format: "png" });
			const { writeFile } = await import("node:fs/promises");
			await writeFile(path, Buffer.from(r.data, "base64"));
			return path;
		},
		async startCast(dir) {
			// 录一段：把 Page.startScreencast 的帧落到目录里，stopCast 之后自己拼。
			const { mkdir, writeFile } = await import("node:fs/promises");
			await mkdir(dir, { recursive: true });
			let n = 0;
			const onFrame = (e) => {
				const msg = JSON.parse(e.data);
				if (msg.method !== "Page.screencastFrame") return;
				writeFile(`${dir}/${String(n++).padStart(5, "0")}.png`, Buffer.from(msg.params.data, "base64"));
				ws.send(JSON.stringify({ id: ++id, method: "Page.screencastFrameAck", params: { sessionId: msg.params.sessionId } }));
			};
			ws.addEventListener("message", onFrame);
			await send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
			return {
				stop: async () => {
					await send("Page.stopScreencast");
					ws.removeEventListener("message", onFrame);
					await sleep(300);
					return n;
				},
			};
		},
	};
}
