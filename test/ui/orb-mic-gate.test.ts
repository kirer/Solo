/**
 * 麦克风只有一个出入口（2026-11-16 老板：没打开「直接说话」的时候别占系统麦克风）。
 *
 * 这条毛病以前是这么来的：三条路各自 `getUserMedia`、各自 `track.stop()`，拿到手之后
 * 中间哪一步抛错（AudioContext 起不来、设备中途掉了），那条 stream 就没人停 ——
 * `listenRef` 还是 null、`stopListen` 当场早退，界面上的开关是关的，菜单栏那颗麦克风
 * 指示灯却一直亮着。所以规矩收成 `micGate`：申请与释放都在一处，没人收养就当场放掉。
 *
 * `client.js` 是浏览器里的 ESM（要 React、要插槽注册器），import 不进来 ——
 * 这里既**跑**文件里那段 `micGate`，也**读**源码断言另外三件事：
 * `track.stop()` 只剩一处、`getUserMedia(` 只剩一处、三条路的 catch 都放得掉。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const SRC = readFileSync(new URL("../../plugins-src/悬浮球/client.js", import.meta.url), "utf8");

/** 从源码里截一段：`from` 起、`to` 止（都不含 `to`）。 */
function cut(from: string, to: string): string {
	const a = SRC.indexOf(from);
	const b = SRC.indexOf(to, a);
	expect(a, `源码里找不到「${from}」`).toBeGreaterThan(-1);
	expect(b, `源码里找不到「${to}」`).toBeGreaterThan(a);
	return SRC.slice(a, b);
}

type Gate = {
	open: (acquire: () => Promise<unknown>) => Promise<unknown>;
	release: (stream: unknown) => void;
	releaseAll: () => void;
	held: () => number;
};

function buildGate(): Gate {
	const body = `${cut("/**\n * 麦克风的唯一出入口", "/**\n * 默认音色")}\nreturn micGate();`;
	const factory = new Function(body) as () => Gate;
	return factory();
}

/** 假麦克风：记下每次 `stop()`，好用来看「真的放掉了没有」。 */
function fakeStream(name: string): { stream: unknown; stopped: () => number } {
	let stops = 0;
	const stream = {
		name,
		getTracks: () => [{ stop: () => void (stops += 1) }],
	};
	return { stream, stopped: () => stops };
}

describe("micGate：申请与释放只有一处", () => {
	it("拿到手算占着，release 之后归零并且真的 stop 了轨道", async () => {
		const gate = buildGate();
		const fake = fakeStream("按键录音");
		const stream = await gate.open(() => Promise.resolve(fake.stream));
		expect(stream).toBe(fake.stream);
		expect(gate.held()).toBe(1);
		gate.release(stream);
		expect(fake.stopped()).toBe(1);
		expect(gate.held()).toBe(0);
	});

	it("重复放、放个 null 都不炸（各处收尾都会顺手调一遍）", async () => {
		const gate = buildGate();
		const fake = fakeStream("直接说话");
		const stream = await gate.open(() => Promise.resolve(fake.stream));
		gate.release(stream);
		gate.release(stream);
		gate.release(null);
		gate.release(undefined);
		expect(fake.stopped()).toBe(1);
		expect(gate.held()).toBe(0);
	});

	it("申请本身就失败：一条都不记账", async () => {
		const gate = buildGate();
		await expect(gate.open(() => Promise.reject(new Error("没权限")))).rejects.toThrow("没权限");
		expect(gate.held()).toBe(0);
	});

	it("releaseAll 把手上的一起收干净（窗口藏起来、组件卸载走这条）", async () => {
		const gate = buildGate();
		const one = fakeStream("直接说话");
		const two = fakeStream("唤醒词");
		await gate.open(() => Promise.resolve(one.stream));
		await gate.open(() => Promise.resolve(two.stream));
		expect(gate.held()).toBe(2);
		gate.releaseAll();
		expect(gate.held()).toBe(0);
		expect(one.stopped()).toBe(1);
		expect(two.stopped()).toBe(1);
	});
});

describe("源码：不该有第二条申请/停止的路", () => {
	it("`track.stop()` 全文件只剩 micGate 里那一处", () => {
		const code = SRC.split("\n")
			.map((line, index) => ({ line, index }))
			.filter(({ line }) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
			.map(({ line }) => line)
			.join("\n");
		expect(code.match(/track\.stop\(\)/g) ?? []).toHaveLength(1);
	});

	it("`getUserMedia(` 真调用只剩 micWithTimeout 那一处，别处都是「有没有」的探测", () => {
		const calls = (SRC.match(/mediaDevices\.getUserMedia\(/g) ?? []).length;
		expect(calls).toBe(1);
		const at = SRC.indexOf("mediaDevices.getUserMedia(");
		expect(SRC.slice(Math.max(0, at - 400), at)).toContain("const micWithTimeout");
	});

	/** 函数体里最后那个 `} catch {` … `} finally {`：半路抛错的收尾就写在这儿。 */
	function catchOf(body: string): string {
		const at = body.lastIndexOf("} catch {");
		expect(at, "这个函数里找不到外层 catch").toBeGreaterThan(-1);
		const end = body.indexOf("} finally {", at);
		expect(end, "外层 catch 后面没有 finally").toBeGreaterThan(at);
		return body.slice(at, end);
	}

	it("三条路拿到手之后半路抛错，catch 里都放得掉", () => {
		// 直接说话：外层 catch（AudioContext 起不来、建图抛错都在这里收尾）。
		const listen = cut("const startListen = async () => {", "const toggleListen");
		expect(catchOf(listen)).toContain("mic.release(stream);");
		// 唤醒词：外层 catch 也要放。
		const wake = cut("const startWake = async () => {", "const woke = async () => {");
		expect(catchOf(wake)).toContain("mic.release(stream);");
		// 按键录音：catch 走 cleanupStream，cleanupStream 走 mic.release。
		const record = cut("const startRecording = async () => {", "const toggleSpeak");
		expect(record).toContain("cleanupStream();");
		expect(cut("const cleanupStream = () => {", "\n\t\t\t};")).toContain("mic.release(streamRef.current);");
	});

	it("申请一律经闸：三条路里没有裸的 micWithTimeout 调用", () => {
		for (const [from, to] of [
			["const startRecording = async () => {", "const toggleSpeak"],
			["const startListen = async () => {", "const toggleListen"],
			["const startWake = async () => {", "const woke = async () => {"],
		] as const) {
			const body = cut(from, to);
			const bare = body.replace(/mic\.open\(\(\) =>\s*micWithTimeout\(/g, "");
			expect(bare.includes("micWithTimeout("), `${from} 里还有人绕过闸直接申请`).toBe(false);
		}
	});

	it("窗口藏起来就不再听：常驻听与唤醒词的开关都看 windowHidden", () => {
		expect(SRC).toContain("const want = listenOn && dmId !== null && !recording && !windowHidden;");
		expect(SRC).toContain("!transcribing && !windowHidden) void startWake();");
	});
});
