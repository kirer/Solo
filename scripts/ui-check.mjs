#!/usr/bin/env node
/**
 * 网页界面交互验收：用真实浏览器点一遍关键路径，给出 PASS / FAIL。
 *
 * 覆盖用户这次提的六件事：
 *   1. 点人打开对话时主视图不跳、对话宽度不变、可拖动调宽
 *   2. 卡片状态边框与在跑态
 *   3. 点项目卡翻面 / 返回
 *   4. 成员沟通连线
 *   5. 手机布局与底部抽屉（无横向溢出）
 *   6. Markdown、工具/思考折叠
 *
 * 用法：node scripts/ui-check.mjs [--url http://127.0.0.1:7789/]
 * 退出码 0 表示全部通过；失败会打印原因并以 1 退出。
 */

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	process.env.CHROME_PATH,
].filter(Boolean);

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const baseUrl = urlIndex === -1 ? "http://127.0.0.1:7789/" : args[urlIndex + 1];
const chromePath = CHROME_CANDIDATES.find(Boolean);
if (chromePath === undefined) {
	console.error("找不到 Chrome / Chromium / Edge。");
	process.exit(2);
}

const port = 9800 + (process.pid % 400);
const chrome = spawn(
	chromePath,
	[
		"--headless=new",
		"--disable-gpu",
		"--hide-scrollbars",
		"--no-first-run",
		`--remote-debugging-port=${port}`,
		`--user-data-dir=/tmp/ai-company-check-${process.pid}`,
		"--window-size=1440,900",
		"about:blank",
	],
	{ stdio: "ignore" },
);

const sleep = (ms) => delay(Math.max(0, ms));
const results = [];
const pageErrors = [];

function check(name, ok, detail = "") {
	results.push({ name, ok, detail });
	const mark = ok ? "PASS" : "FAIL";
	console.log(`  ${mark}  ${name}${detail === "" ? "" : `  (${detail})`}`);
	if (!ok) process.exitCode = 1;
}

async function waitForDevtools() {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
			const page = targets.find((target) => target.type === "page");
			if (page !== undefined) return page;
		} catch {
			/* 继续等 */
		}
		await sleep(125);
	}
	throw new Error("Chrome 调试端口未就绪");
}

class Cdp {
	constructor(socketUrl) {
		this.id = 0;
		this.pending = new Map();
		this.socket = new WebSocket(socketUrl);
		this.ready = new Promise((resolve, reject) => {
			this.socket.addEventListener("open", resolve);
			this.socket.addEventListener("error", reject);
		});
		this.socket.addEventListener("message", (event) => {
			const message = JSON.parse(event.data);
			if (message.id !== undefined && this.pending.has(message.id)) {
				const { resolve, reject } = this.pending.get(message.id);
				this.pending.delete(message.id);
				if (message.error !== undefined) reject(new Error(message.error.message));
				else resolve(message.result);
				return;
			}
			if (message.method === "Runtime.exceptionThrown") {
				pageErrors.push(message.params.exceptionDetails?.exception?.description ?? "未捕获异常");
			}
			if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
				pageErrors.push(
					message.params.args.map((item) => item.value ?? item.description ?? "").join(" "),
				);
			}
		});
	}

	async send(method, params = {}) {
		await this.ready;
		const id = (this.id += 1);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	async eval(expression) {
		const result = await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (result.exceptionDetails !== undefined) {
			throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
		}
		return result.result?.value;
	}

	async navigate(path) {
		await this.send("Page.navigate", { url: new URL(path, baseUrl).href });
		await sleep(450);
		for (let attempt = 0; attempt < 50; attempt += 1) {
			const ready = await this.eval(
				`Boolean(document.querySelector('.org-head, .org-graph') || document.querySelector('.chat-head'))`,
			).catch(() => false);
			if (ready) break;
			await sleep(150);
		}
		await sleep(900);
	}

	async click(selector) {
		// 只有元素不在视口内才滚动：否则测试自己造成的滚动会被误判成界面跳动。
		const box = await this.eval(
			`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; let r = el.getBoundingClientRect(); if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) { el.scrollIntoView({block:"center"}); r = el.getBoundingClientRect(); } return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
		);
		if (box === null) throw new Error(`找不到元素：${selector}`);
		await this.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: box.x,
			y: box.y,
			button: "left",
			clickCount: 1,
		});
		await this.send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: box.x,
			y: box.y,
			button: "left",
			clickCount: 1,
		});
		await sleep(250);
	}

	async drag(fromX, fromY, toX, toY) {
		await this.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: fromX,
			y: fromY,
			button: "left",
			clickCount: 1,
		});
		await sleep(60);
		await this.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: toX,
			y: toY,
			button: "left",
		});
		await sleep(120);
		await this.send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: toX,
			y: toY,
			button: "left",
			clickCount: 1,
		});
		await sleep(250);
	}
}

const page = await waitForDevtools();
const cdp = new Cdp(page.webSocketDebuggerUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
	source: `try { localStorage.removeItem("ai-company.chat-width"); } catch (e) {}`,
});
await cdp.send("Emulation.setDeviceMetricsOverride", {
	width: 1440,
	height: 900,
	deviceScaleFactor: 2,
	mobile: false,
});

try {
	console.log("\n· 桌面：点人不让主视图跳动 / 对话常驻");
	await cdp.navigate("/");
	const initial = await cdp.eval(`(() => {
		const chat = document.querySelector('#chat');
		const stage = document.querySelector('.stage-inner');
		const nodes = [...document.querySelectorAll('.card[data-conv]')].map((el) => {
			const r = el.getBoundingClientRect();
			return [el.dataset.conv, Math.round(r.x), Math.round(r.y), Math.round(r.width)].join(':');
		});
		return { chat: chat?.getBoundingClientRect().width ?? 0, stage: stage?.getBoundingClientRect().width ?? 0, nodes };
	})()`);
	check("对话面板默认常驻", initial.chat > 300, `${Math.round(initial.chat)}px`);
	// 只断言「组织图渲染出来了」。真实库可能因为没有活跃员工而少于 8 个节点
	// （例如项目已 terminated 且员工已归档），那是数据状态，不是界面坏了。
	check("组织图已渲染", initial.nodes.length >= 4, `${initial.nodes.length} 个节点`);

	const target = await cdp.eval(
		`(() => { const el = document.querySelector('.card[data-conv="7"]'); return el ? "7" : (document.querySelector('.card[data-conv]')?.dataset.conv ?? null); })()`,
	);
	await cdp.click(`.card[data-conv="${target}"]`);
	await sleep(900);
	const opened = await cdp.eval(`(() => {
		const chat = document.querySelector('#chat');
		const stage = document.querySelector('.stage-inner');
		const title = document.querySelector('#chat-title')?.textContent ?? '';
		const nodes = [...document.querySelectorAll('.card[data-conv]')].map((el) => {
			const r = el.getBoundingClientRect();
			return [el.dataset.conv, Math.round(r.x), Math.round(r.y), Math.round(r.width)].join(':');
		});
		return { chat: chat?.getBoundingClientRect().width ?? 0, stage: stage?.getBoundingClientRect().width ?? 0, title, nodes, body: document.querySelector('#chat-body')?.childElementCount ?? 0 };
	})()`);
	check("点人后对话宽度不变", Math.abs(opened.chat - initial.chat) < 1, `${Math.round(initial.chat)} → ${Math.round(opened.chat)}`);
	check("点人后主视图宽度不变", Math.abs(opened.stage - initial.stage) < 1, `${Math.round(initial.stage)} → ${Math.round(opened.stage)}`);
	const moved = initial.nodes
		.map((line, index) => (line === opened.nodes[index] ? null : `${line} → ${opened.nodes[index] ?? "?"}`))
		.filter(Boolean);
	check("点人后卡片位置不跳", moved.length === 0, moved.slice(0, 3).join(" | "));
	check("对话头部切换到被点的人", opened.title.length > 0 && opened.title !== "选择一位同事", opened.title);
	check("对话内容有渲染", opened.body > 0, `${opened.body} 个块`);

	const layout = await cdp.eval(`(() => ({
		// 待办不再有独立区域：它作为一条可交互事项出现在对话流里（.pend）。
		// 顶部那块黄框（#ask-area）已删除——同一条问题出现两次、答完没反应，
		// 正是用户报的问题。
		noSeparateArea: document.querySelector('#ask-area') === null && document.querySelector('.chat-pending') === null,
		noBottomHints: document.querySelector('.chat-hints') === null && document.querySelector('.stage-foot') === null,
		noRail: document.querySelector('.rail') === null,
	}))()`);
	check("待办不再单开区域（并入对话流）", layout.noSeparateArea);
	check("底部没有多余提示条", layout.noBottomHints);
	check("单页面没有侧边导航", layout.noRail);

	console.log("\n· 对话面板拖宽 / 复位 / 收起");
	const resizer = await cdp.eval(`(() => {
		const el = document.querySelector('#chat-resizer');
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2, before: document.querySelector('#chat').getBoundingClientRect().width };
	})()`);
	check("存在拖宽把手", resizer !== null);
	if (resizer !== null) {
		await cdp.drag(resizer.x, resizer.y, resizer.x - 130, resizer.y);
		const wider = await cdp.eval(`document.querySelector('#chat').getBoundingClientRect().width`);
		check("拖动可以把对话调宽", wider > resizer.before + 80, `${Math.round(resizer.before)} → ${Math.round(wider)}`);
		await cdp.eval(`document.querySelector('#chat-resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
		await sleep(350);
		const reset = await cdp.eval(`document.querySelector('#chat').getBoundingClientRect().width`);
		check("双击复位宽度", Math.abs(reset - 480) < 40, `${Math.round(reset)}px`);
	}

	await cdp.click("#chat-collapse");
	await sleep(500);
	const collapsed = await cdp.eval(`({ state: document.body.dataset.chat, width: document.querySelector('#chat').getBoundingClientRect().width, stage: document.querySelector('.stage-inner').getBoundingClientRect().width })`);
	check("桌面可收起对话", collapsed.state === "closed" && collapsed.width < 2, `${collapsed.state} / ${Math.round(collapsed.width)}px`);
	check("收起后主视图变宽", collapsed.stage > initial.stage, `${Math.round(initial.stage)} → ${Math.round(collapsed.stage)}`);
	await cdp.click("#chat-toggle");
	await sleep(500);
	const expanded = await cdp.eval(`({ state: document.body.dataset.chat, width: document.querySelector('#chat').getBoundingClientRect().width })`);
	check("能从左侧栏恢复对话", expanded.state === "open" && expanded.width > 300, `${Math.round(expanded.width)}px`);

	console.log("\n· 项目翻面");
	// 真实库可能没有 active 项目（例如只剩 terminated 且员工已归档）。
	// 翻面是结构能力，找不到项目卡时用 ?dev 假数据验证，避免把数据状态误判成功能坏了。
	const projectFlipProbe = () =>
		cdp.eval(`(() => {
			const front = document.querySelector('.project-face--front [data-flip]') ?? document.querySelector('.project [data-flip]');
			return front === null ? null : { slug: front.closest('.project')?.dataset.project ?? '', label: front.getAttribute('aria-label') ?? '' };
		})()`);
	let flip = await projectFlipProbe();
	if (flip === null) {
		await cdp.navigate("/?dev");
		await cdp.eval("window.__company.useMock()");
		await sleep(900);
		flip = await projectFlipProbe();
	}
	check("存在可翻面的项目卡", flip !== null, flip?.slug ?? "");
	if (flip !== null) {
		await cdp.click(".project-face--front [data-flip]");
		await sleep(1000);
		const flipped = await cdp.eval(`(() => { const p = document.querySelector('.project.is-flipped'); if (!p) return null; const back = p.querySelector('.project-face--back'); const r = back?.getBoundingClientRect(); return { height: p.getBoundingClientRect().height, backVisible: r !== undefined && r.height > 40, rows: p.querySelectorAll('.prj-row--staff').length }; })()`);
		check("点项目卡翻面", flipped !== null && flipped.height > 100, flipped === null ? "" : `${Math.round(flipped.height)}px`);
		check("背面显示员工行", flipped !== null && flipped.backVisible && flipped.rows > 0, flipped === null ? "" : `${flipped.rows} 行`);
		await cdp.click(".prj-return");
		await sleep(900);
		const returned = await cdp.eval(`document.querySelectorAll('.project.is-flipped').length`);
		check("能翻回正面", returned === 0);
	}

	console.log("\n· 外观：深色 / 浅色 / 跟随系统");
	await cdp.eval(`localStorage.removeItem("ai-company.theme")`);
	await cdp.navigate("/");
	const theme0 = await cdp.eval(`({ mode: document.documentElement.dataset.theme, resolved: document.documentElement.dataset.resolved })`);
	check("默认有解析后的主题", ["dark", "light"].includes(theme0.resolved), `${theme0.mode}/${theme0.resolved}`);
	await cdp.click("#settings-toggle");
	await sleep(250);
	const menuOpen = await cdp.eval(`(() => { const m = document.querySelector("#settings"); return { hidden: m.hidden, expanded: document.querySelector("#settings-toggle").getAttribute("aria-expanded"), options: m.querySelectorAll("[data-theme-option]").length }; })()`);
	check("设置可打开且含三项外观", menuOpen.hidden === false && menuOpen.expanded === "true" && menuOpen.options === 3, `${menuOpen.options} 项`);
	const settingsInfo = await cdp.eval(`(() => {
		const close = document.querySelector('#settings-close');
		const r = close?.getBoundingClientRect();
		return {
			close: r ? { w: r.width, h: r.height } : null,
			model: document.querySelector('#company-model')?.textContent ?? '',
			cost: document.querySelector('#settings-cost')?.textContent ?? '',
		};
	})()`);
	check("设置关闭按钮可点", settingsInfo.close !== null && settingsInfo.close.w >= 20 && settingsInfo.close.h >= 20, settingsInfo.close === null ? "" : `${Math.round(settingsInfo.close.w)}×${Math.round(settingsInfo.close.h)}`);
	check("设置显示模型与成本", settingsInfo.model.trim() !== "" && settingsInfo.cost.includes("tokens"), `${settingsInfo.model} / ${settingsInfo.cost}`);
	await cdp.click('[data-theme-option="light"]');
	await sleep(350);
	const light = await cdp.eval(`({ resolved: document.documentElement.dataset.resolved, bg: getComputedStyle(document.body).backgroundColor, stored: localStorage.getItem("ai-company.theme") })`);
	check("浅色主题生效", light.resolved === "light" && light.bg === "rgb(245, 245, 242)", light.bg);
	check("主题选择被记住", light.stored === "light", String(light.stored));
	// 设置面板选完主题不自动关闭，直接点深色
	await cdp.click('[data-theme-option="dark"]');
	await sleep(300);
	await cdp.click("#settings-toggle");
	const dark = await cdp.eval(`({ resolved: document.documentElement.dataset.resolved, bg: getComputedStyle(document.body).backgroundColor })`);
	check("深色主题生效", dark.resolved === "dark" && dark.bg === "rgb(11, 12, 14)", dark.bg);

	// 跟随系统：切到 system 后用 CDP 改系统配色
	await cdp.click("#settings-toggle");
	await sleep(200);
	await cdp.click('[data-theme-option="system"]');
	await cdp.click("#settings-toggle");
	await sleep(200);
	await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
	await sleep(350);
	const sysLight = await cdp.eval(`document.documentElement.dataset.resolved`);
	check("跟随系统：系统浅色时变浅", sysLight === "light", String(sysLight));
	await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
	await sleep(350);
	const sysDark = await cdp.eval(`document.documentElement.dataset.resolved`);
	check("跟随系统：系统深色时变深", sysDark === "dark", String(sysDark));
	await cdp.send("Emulation.setEmulatedMedia", { features: [] });
	await cdp.click("#settings-toggle");
	await sleep(200);
	await cdp.click('[data-theme-option="dark"]');
	await cdp.click("#settings-toggle");
	await sleep(200);

	console.log("\n· 假数据：状态光边 / 连线 / Markdown / 工具折叠");
	await cdp.navigate("/?dev");
	await cdp.eval("window.__company.useMock()");
	await sleep(1000);
	const mock = await cdp.eval(`(() => ({
		live: document.querySelectorAll('.card[data-status="busy"], .card[data-status="waiting"]').length,
		edges: document.querySelectorAll('.edge').length,
		sparks: document.querySelectorAll('.edge.is-recent, .edge.has-spark').length,
		table: document.querySelectorAll('#chat-body .md table').length,
		code: document.querySelectorAll('#chat-body .md-code').length,
		tools: document.querySelectorAll('#chat-body .tool').length,
		thinking: document.querySelectorAll('#chat-body .think, #chat-body .thinking').length,
		queued: document.querySelectorAll('#chat-body .queued, #chat-body .queue').length,
		// ADR-026 决策 7.3：老板自己的消息永不排队。排队项只可能是 agent 派来的，
		// 所以界面上「origin=owner 的排队项」必须结构上为 0。
		ownerQueued: document.querySelectorAll('#chat-body .queued[data-origin="owner"], #chat-body .queue[data-origin="owner"]').length,
		interruptBtns: document.querySelectorAll('#chat-body [data-interrupt]').length,
		overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
	}))()`);
	check("有状态色边框节点", mock.live >= 3, `${mock.live} 个`);
	check("有沟通连线", mock.edges >= 3, `${mock.edges} 条`);
	check("新连线带流动光点", mock.sparks >= 1, `${mock.sparks} 条`);
	check("Markdown 表格已渲染", mock.table >= 1, `${mock.table} 个`);
	check("Markdown 代码块已渲染", mock.code >= 1, `${mock.code} 个`);
	check("工具调用可折叠", mock.tools >= 2, `${mock.tools} 个`);
	check("思考过程存在", mock.thinking >= 1, `${mock.thinking} 个`);
	check("排队消息存在", mock.queued >= 1, `${mock.queued} 个`);
	// ADR-026 决策 7.3「老板通道永不排队」：受理是无条件的（默认 now 档），
	// 所以老板来源的消息在结构上不可能出现在 queued 里。这条断言钉住界面没有
	// 把 agent 的排队误标成老板的（或反过来给老板通道渲染排队）。
	check("老板通道结构上不排队", mock.ownerQueued === 0, `${mock.ownerQueued} 个 origin=owner`);
	// ADR-026 决策 7：老板通道不得再出现「立即处理」这类需要二次点击的按钮，
	// 受理本身已无条件（默认档位 now）。
	check("没有「立即处理」按钮", mock.interruptBtns === 0, `${mock.interruptBtns} 个`);
	check("桌面无横向溢出", mock.overflow === false);

	const openedTool = await cdp.eval(`(() => { const t = document.querySelector('#chat-body .tool'); if (!t) return null; const summary = t.querySelector('summary'); summary?.click(); return { open: t.open === true || t.hasAttribute('open'), name: t.querySelector('.tool-name, .tname')?.textContent ?? '' }; })()`);
	await sleep(300);
	const toolOpen = await cdp.eval(`document.querySelector('#chat-body .tool')?.open === true || document.querySelector('#chat-body .tool')?.hasAttribute('open') === true`);
	check("点开工具看到输出", openedTool !== null && toolOpen === true);

	console.log("\n· 聊天新交互：内嵌档案 / 附件托盘 / @ 提及 / 选项框 / 连线状态");
	const foldAvailable = await cdp.eval(`(() => { const b = document.querySelector('#chat-fold'); return b !== null && !b.hidden; })()`);
	check("角色档案入口可见", foldAvailable === true);
	if (foldAvailable) {
		await cdp.eval(`document.querySelector('#chat-fold').click()`);
		await sleep(750);
	}
	const dock = await cdp.eval(`(() => {
		const el = document.querySelector('#chat-dock');
		const chat = document.querySelector('#chat');
		const r = el?.getBoundingClientRect();
		const cr = chat?.getBoundingClientRect();
		return {
			exists: el !== null,
			open: el?.dataset.open === 'true',
			insideChat: el !== null && chat !== null && chat.contains(el),
			position: el === null ? '' : getComputedStyle(el).position,
			width: Math.round(r?.width ?? 0),
			chatWidth: Math.round(cr?.width ?? 0),
		};
	})()`);
	check("角色档案在对话面板内展开", dock.exists && dock.insideChat && dock.open === true, dock.open ? "open" : "closed");
	// 需求 8：面板不悬浮，宽度与对话面板一致（留 1px 亚像素误差）
	check("档案面板与对话同宽（不悬浮）", Math.abs(dock.width - dock.chatWidth) <= 2 && dock.position !== "fixed", `${dock.width}px / ${dock.chatWidth}px · ${dock.position}`);

	// 需求 4：附件托盘（真实上传链路见后端 platform-api 测试；这里验界面结构）
	const tray = await cdp.eval(`(() => {
		window.__company.chat.seedAttachments?.([{ name: '验收截图.png', size: 20480, mime: 'image/png', url: '' }]);
		const chips = document.querySelectorAll('#attach-tray .attach-chip');
		return { chips: chips.length, visible: document.querySelector('#attach-tray')?.hidden === false };
	})()`);
	check("附件托盘显示文件 chip", tray.chips >= 1 && tray.visible === true, `${tray.chips} 个`);

	// 需求 5：@ 提及
	await cdp.eval(`(() => {
		const input = document.querySelector('#input');
		input.focus();
		input.value = '@';
		input.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
	await sleep(350);
	const mention = await cdp.eval(`(() => {
		const pop = document.querySelector('#mention-pop');
		const items = pop?.querySelectorAll('.mention-item')?.length ?? 0;
		return { hidden: pop?.hidden ?? true, items, text: (pop?.textContent ?? '').trim().slice(0, 60) };
	})()`);
	check("@ 提及弹层可用", mention.hidden === false && mention.items >= 1, `${mention.items} 项 · ${mention.text}`);
	await cdp.eval(`(() => {
		const input = document.querySelector('#input');
		input.value = '';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	})()`);
	await sleep(200);

	// 待办并入对话流：不再有顶部黄框，卡片在流里可交互，答完立刻变「已答复」
	const pend = await cdp.eval(`(() => {
		const cards = [...document.querySelectorAll('.chat-stream .pend')];
		return {
			inStream: cards.length,
			hasOptions: document.querySelectorAll('.chat-stream .pend .pend-opt').length,
			hasReply: document.querySelectorAll('.chat-stream .pend .pend-reply textarea').length,
			topArea: document.querySelector('#ask-area, .chat-pending') === null,
		};
	})()`);
	check("待办渲染在对话流里", pend.inStream >= 1, `${pend.inStream} 张`);
	check("顶部没有独立待办区", pend.topArea === true);
	check("待办带选项与回复框", pend.hasOptions >= 2 && pend.hasReply >= 1, `${pend.hasOptions} 选项 / ${pend.hasReply} 回复框`);

	const answered = await cdp.eval(`(async () => {
		// 拦截 /api/answer，只为验证「答完立刻有反应」，不发真请求
		const realFetch = window.fetch;
		let sent = null;
		window.fetch = async (url, opts) => {
			if (String(url).includes('/api/answer')) {
				sent = JSON.parse(opts.body);
				return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
			}
			return realFetch(url, opts);
		};
		const card = document.querySelector('.chat-stream .pend');
		const textarea = card.querySelector('.pend-reply textarea');
		textarea.value = '按第二个方案来';
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.pend-send').click();
		await new Promise((resolve) => setTimeout(resolve, 500));
		const result = {
			sent,
			answeredClass: card.classList.contains('is-answered'),
			state: card.querySelector('.pend-state')?.textContent?.trim() ?? '',
			replyHidden: getComputedStyle(card.querySelector('.pend-reply')).display === 'none',
		};
		window.fetch = realFetch;
		return result;
	})()`);
	check("点提交后立刻显示已答复", answered.answeredClass === true && answered.state === "已答复", answered.state || "(无)");
	check("答复内容确实发了出去", answered.sent?.text === "按第二个方案来", JSON.stringify(answered.sent));
	check("答复后输入区收起", answered.replyHidden === true);

	// 需求 11：需要选择的回复 → 选项卡片（最后一项固定自定义输入）
	const options = await cdp.eval(`(() => ({
		groups: document.querySelectorAll('.msg-options, .ask-options').length,
		items: document.querySelectorAll('.msg-option, .ask-opt').length,
		custom: document.querySelectorAll('.msg-option--custom').length,
	}))()`);
	check("需要选择的回复渲染成选项卡片", options.groups >= 1 && options.items >= 2, `${options.groups} 组 / ${options.items} 项`);
	check("选项最后一项是自定义输入", options.custom >= 1, `${options.custom} 项`);

	// 需求 6：连线按状态着色（绿/黄/红/中性），不能只有一条固定颜色
	const edges = await cdp.eval(`(() => {
		const list = [...document.querySelectorAll('.edge')];
		const states = list.map((el) => el.dataset.state ?? el.getAttribute('data-state') ?? '').filter(Boolean);
		return { total: list.length, states, nonIdle: states.filter((s) => s !== 'idle').length };
	})()`);
	check("连线按状态着色", edges.total >= 2 && edges.nonIdle >= 1, `${edges.total} 条 · ${[...new Set(edges.states)].join("/")}`);
	check("聊天新交互无横向溢出", (await cdp.eval(`document.documentElement.scrollWidth > window.innerWidth + 1`)) === false);

	console.log("\n· 任务看板：三列 / 卡片 / 点卡开会话 / 收起后无溢出");
	await cdp.navigate("/");
	await sleep(1400);
	const viewInitial = await cdp.eval(`({ view: document.body.dataset.view ?? '', boardHidden: document.querySelector('#board')?.hidden ?? true })`);
	check("默认是组织图视图", viewInitial.view !== "board", viewInitial.view || "(未设置)");
	await cdp.click("#view-board");
	await sleep(1100);
	const board = await cdp.eval(`(() => {
		const el = document.querySelector('#board');
		const r = el?.getBoundingClientRect();
		const cols = [...document.querySelectorAll('#board .board-col')].map((col) => ({
			title: col.querySelector('.board-col-title')?.textContent?.trim() ?? '',
			count: Number(col.querySelector('.board-col-count')?.textContent ?? '0'),
			cards: col.querySelectorAll('.board-card').length,
		}));
		return {
			view: document.body.dataset.view ?? '',
			hidden: el?.hidden ?? true,
			width: Math.round(r?.width ?? 0),
			cols,
			cards: document.querySelectorAll('#board .board-card').length,
			// 数据源：实时数据不显示「示例数据」chip（board-source 只有降级时才出现），
			// 所以这里取「可见的 source chip」或「实时指示器」任一有字即可。
			source:
				(document.querySelector('#board .board-source:not([hidden])')?.textContent?.trim() ?? '') ||
				(document.querySelector('#board .board-live')?.textContent?.trim() ?? ''),
			orgShown: document.querySelector('.org') !== null && getComputedStyle(document.querySelector('.org')).display !== 'none',
		};
	})()`);
	check("切到看板视图", board.view === "board" && board.hidden === false && board.width > 400 && !board.orgShown, `${board.view} / ${board.width}px`);
	check("看板三列齐全", board.cols.length === 3, board.cols.map((col) => `${col.title}:${col.count}`).join(" / "));
	// 空公司（刚清空数据）时看板合法地一张卡都没有，所以只断言「数据源可用」+
	// 「有卡就一定是真卡」；不能要求必须有卡，否则清库后验收会假失败。
	check(
		"看板接上实时数据源",
		board.source !== "" && (board.cards >= 1 || board.cols.every((col) => col.count === 0)),
		`${board.cards} 张 · ${board.source}`,
	);
	const openedCard = await cdp.eval(`(() => {
		const card = document.querySelector('#board .board-card');
		if (card === null) return null;
		card.click();
		return card.getAttribute('data-href') ?? '';
	})()`);
	await sleep(900);
	const cardResult = await cdp.eval(`({ hash: location.hash, title: document.querySelector('#chat-title')?.textContent ?? '' })`);
	check("点看板卡片打开对应会话", /^#\/c\/\d+$/.test(cardResult.hash) && cardResult.title !== "" && cardResult.title !== "选择一位同事", `${cardResult.hash} · ${cardResult.title}`);
	void openedCard;
	await cdp.click("#view-org");
	await sleep(600);
	const backToOrg = await cdp.eval(`({ view: document.body.dataset.view ?? '', boardHidden: document.querySelector('#board')?.hidden ?? false, orgShown: getComputedStyle(document.querySelector('.org')).display !== 'none' })`);
	check("能切回组织图", backToOrg.view !== "board" && backToOrg.boardHidden === true && backToOrg.orgShown === true);
	// 既有 regression：桌面收起对话后不能出现横向滚动
	await cdp.eval(`document.querySelector('#chat-collapse')?.click()`);
	await sleep(700);
	check("收起对话后无横向溢出", (await cdp.eval(`document.documentElement.scrollWidth > window.innerWidth + 1`)) === false, `${await cdp.eval(`document.documentElement.scrollWidth`)} / ${await cdp.eval(`window.innerWidth`)}`);
	await cdp.eval(`document.querySelector('#chat-toggle')?.click()`);
	await sleep(600);

	console.log("\n· 手机：单列 + 底部抽屉 + 无横向溢出");
	await cdp.send("Emulation.setDeviceMetricsOverride", {
		width: 390,
		height: 844,
		deviceScaleFactor: 2,
		mobile: true,
		screenWidth: 390,
		screenHeight: 844,
	});
	await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
	await cdp.navigate("/?dev");
	await cdp.eval("window.__company.useMock()");
	await sleep(800);
	const mobile = await cdp.eval(`(() => {
		const grid = document.querySelector('.tier-grid--roles');
		return {
			overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
			hasRail: document.querySelector('.rail') !== null,
			hasBottomNav: document.querySelector('.rail-foot') !== null,
			rolesColumns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
			settingsVisible: document.querySelector('#settings-toggle')?.getBoundingClientRect().width > 0,
		};
	})()`);
	check("手机无横向溢出", mobile.overflow === false);
	check("手机没有侧边导航（单页面）", mobile.hasRail === false && mobile.hasBottomNav === false);
	check("手机顶部设置入口可见", mobile.settingsVisible === true);
	check("手机高管层单列或两列", mobile.rolesColumns > 0 && mobile.rolesColumns <= 2, `${mobile.rolesColumns} 列`);

	// 需求 9：手机上的看板改为纵向堆叠，且不横向溢出
	await cdp.eval(`document.querySelector('#view-board')?.click()`);
	await sleep(1000);
	const mobileBoard = await cdp.eval(`(() => {
		const cols = [...document.querySelectorAll('#board .board-col')];
		const rects = cols.map((col) => col.getBoundingClientRect());
		const stacked = rects.length === 3 && rects.every((r, index) => index === 0 || r.top >= rects[index - 1].bottom - 2);
		return { cols: cols.length, stacked, overflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
	})()`);
	check("手机看板三列纵向堆叠", mobileBoard.cols === 3 && mobileBoard.stacked, `${mobileBoard.cols} 列`);
	check("手机看板无横向溢出", mobileBoard.overflow === false);
	await cdp.eval(`document.querySelector('#view-org')?.click()`);
	await sleep(500);

	await cdp.eval(`document.querySelector('.card[data-conv="7"]')?.click()`);
	await sleep(800);
	const sheet = await cdp.eval(`(() => { const chat = document.querySelector('#chat'); const r = chat.getBoundingClientRect(); return { state: document.body.dataset.sheet, width: r.width, visible: r.top < window.innerHeight - 40 && r.height > 200 }; })()`);
	check("手机点人打开底部抽屉", sheet.state === "open" && sheet.width > 300, `${Math.round(sheet.width)}px`);
	await cdp.click("#chat-close");
	await sleep(500);
	const closed = await cdp.eval(`(() => { const r = document.querySelector('#chat').getBoundingClientRect(); return { state: document.body.dataset.sheet, bottom: r.top }; })()`);
	check("手机关闭抽屉", closed.state === "closed", closed.state);

	check("控制台 0 错误", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (error) {
	console.error("\n验收脚本出错：", error);
	process.exitCode = 1;
} finally {
	const passed = results.filter((item) => item.ok).length;
	console.log(`\n结果：${passed}/${results.length} 通过`);
	for (const item of results.filter((entry) => !entry.ok)) console.log(`  FAIL · ${item.name}${item.detail === "" ? "" : ` (${item.detail})`}`);
	cdp.socket.close();
	chrome.kill();
}
