/**
 * 画布上有哪几屏、每一屏怎么走到。
 *
 * 加一屏 = 在 `SCREENS` 里加一行 + 在 `capture()` 里多走一步并 `grab("名字")`。
 * 名字就是 `.superdesign/tmp/dom/<名字>.html` 和草稿文件的主键，改名等于新建一屏。
 *
 * 只抓**跑得出来的状态**：界面上没有的东西不摆拍（AGENTS §2 第 6 条）。比如输入框的
 * 「等我选」选项卡只在最后一条消息带 `options` 时出现，workspace 里没有这样的消息，
 * 那就不做这一屏。
 */

export const SCREENS = [
	{ name: "01-group-dark", title: "当前界面 · 群聊主界面（深色）", theme: "dark", width: 1440, height: 900 },
	{ name: "02-right-detail", title: "当前界面 · 右栏 · 详情", theme: "dark", width: 1440, height: 900 },
	{ name: "03-right-skills", title: "当前界面 · 右栏 · 技能", theme: "dark", width: 1440, height: 900 },
	{ name: "04-right-memory", title: "当前界面 · 右栏 · 记忆", theme: "dark", width: 1440, height: 900 },
	{ name: "05-need-menu", title: "当前界面 · 「N 件找你」清单", theme: "dark", width: 1440, height: 900 },
	{ name: "06-plus-menu", title: "当前界面 · ＋ 菜单", theme: "dark", width: 1440, height: 900 },
	{ name: "07-mention", title: "当前界面 · @ 提人", theme: "dark", width: 1440, height: 900 },
	{ name: "08-dm-dark", title: "当前界面 · 私聊（深色）", theme: "dark", width: 1440, height: 900 },
	{ name: "09-blank", title: "当前界面 · 未选会话", theme: "dark", width: 1440, height: 900 },
	{ name: "10-settings", title: "当前界面 · 设置", theme: "dark", width: 1440, height: 900 },
	{ name: "11-team", title: "当前界面 · 团队", theme: "dark", width: 1440, height: 900 },
	{ name: "12-group-light", title: "当前界面 · 群聊主界面（浅色）", theme: "light", width: 1440, height: 900 },
	{ name: "13-mobile-list", title: "当前界面 · 手机 · 会话列表", theme: "dark", width: 390, height: 844, mobile: true },
	{ name: "14-mobile-chat", title: "当前界面 · 手机 · 聊天", theme: "dark", width: 390, height: 844, mobile: true },
	{ name: "15-plugin-sheet", title: "当前界面 · 插件", theme: "dark", width: 1440, height: 900 },
	{ name: "16-right-file", title: "当前界面 · 右栏 · 文件", theme: "dark", width: 1440, height: 900 },
];

const escape = () => `document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))`;
const click = (selector) => `document.querySelector(${JSON.stringify(selector)})?.click()`;
const openGroup = `(() => { const row=[...document.querySelectorAll('.ch')].find(x=>x.dataset.kind==='group'); row?.click(); })()`;
const openDm = `(() => { const row=[...document.querySelectorAll('.ch')].find(x=>x.dataset.kind==='dm'); row?.click(); })()`;
/** 全员频道：团队频道里可能正挂着「等我选」的选项卡，那时没有输入框，@ 弹窗抓不到。 */
const openAll = `(() => { const row=[...document.querySelectorAll('.ch')].find(x=>x.textContent.includes('全员')); row?.click(); })()`;
const tab = (text) =>
	`(() => { const t=[...document.querySelectorAll('.rail-tab')].find(x=>x.textContent.trim()===${JSON.stringify(text)}); t?.click(); })()`;

/** 输入框是受控组件：直接写 `.value` React 看不见，要用原型上的 setter 再派发 input。 */
const typeAt = `(() => {
  const input = document.querySelector('#input');
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(input, '@');
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

const clearInput = `(() => {
  const input = document.querySelector('#input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.blur();
})()`;

export async function capture(page, { origin, grab, wait }) {
	await page.setViewport({ width: 1440, height: 900, dsf: 1 });
	await page.goto(origin, { waitMs: 2500 });
	await page.eval(`localStorage.setItem("solo.theme","dark")`);
	await page.goto(origin, { waitMs: 2500 });

	// 群聊：先开一个团队频道，等消息流落地。
	await page.eval(openGroup);
	await wait(2400);
	await grab("01-group-dark");

	// 右栏三页 + 插件提供的「文件」页签。
	await page.eval(click("#detail-btn"));
	await wait(900);
	await grab("02-right-detail");
	await page.eval(tab("技能"));
	await wait(700);
	await grab("03-right-skills");
	await page.eval(tab("记忆"));
	await wait(700);
	await grab("04-right-memory");
	await page.eval(tab("文件"));
	await wait(800);
	await grab("16-right-file");
	await page.eval(click("#detail-close"));
	await wait(600);

	// 两个浮层。
	await page.eval(click("#unread-total"));
	await wait(700);
	await grab("05-need-menu");
	await page.eval(click("#unread-total"));
	await wait(400);
	await page.eval(click("#plus-btn"));
	await wait(700);
	await grab("06-plus-menu");
	await page.eval(click("#plus-btn"));
	await wait(400);

	// @ 提人：靠一段真输入唤出。换到全员频道 —— 团队频道里可能正挂着「等我选」的选项卡，
	// 那时输入框整个被换掉了（`#input` 不存在），在这里抓会直接抛错。
	await page.eval(openAll);
	await wait(2000);
	await page.eval(typeAt);
	await wait(900);
	await grab("07-mention");
	await page.eval(clearInput);
	await wait(400);

	// 私聊、空态、两个对话框。
	await page.eval(openDm);
	await wait(2200);
	await grab("08-dm-dark");
	await page.eval(click("#back"));
	await wait(700);
	await grab("09-blank");
	await page.eval(click("#settings-btn"));
	await wait(700);
	await grab("10-settings");
	await page.eval(escape());
	await wait(500);
	await page.eval(click("#team-btn"));
	await wait(700);
	await grab("11-team");
	await page.eval(escape());
	await wait(500);
	await page.eval(click("#plugins-btn"));
	await wait(800);
	await grab("15-plugin-sheet");
	await page.eval(escape());
	await wait(500);

	// 浅色：主题挂在 <html> 上，重载才生效。
	await page.eval(`localStorage.setItem("solo.theme","light")`);
	await page.goto(origin, { waitMs: 2200 });
	await page.eval(openGroup);
	await wait(2200);
	await grab("12-group-light");

	// 手机两屏。
	await page.setViewport({ width: 390, height: 844, dsf: 2, mobile: true });
	await page.goto(origin, { waitMs: 2000 });
	await page.eval(`localStorage.setItem("solo.theme","dark")`);
	await page.goto(origin, { waitMs: 2200 });
	await grab("13-mobile-list");
	await page.eval(openGroup);
	await wait(2200);
	await grab("14-mobile-chat");
}
