#!/usr/bin/env node
/**
 * 把 `.superdesign/drafts/v6/` 里**手写的设计稿**推到 Superdesign 画布。
 *
 * 和 sync.mjs 的区别：sync.mjs 抓的是跑起来的真界面（DOM → 自包含 HTML）；
 * 这一份推的是稿子本身（静态 html），所以不用起服务、不用构建。
 *
 *   node .claude/skills/superdesign-sync/push-drafts.mjs               # 只打包 + 列清单
 *   node .claude/skills/superdesign-sync/push-drafts.mjs --push        # 打包 + 推
 *   node .claude/skills/superdesign-sync/push-drafts.mjs --push --only 08-channel,d02-team
 *
 * 打包做两件事：`mock.css` / `desk.css` 内嵌成 `<style>`，`assets/` 里的头像转 data URI。
 * 这样一屏就是一个完整文档，符合 `import-design-draft` 的契约（body 无 class、单根 div、无相对链接）。
 *
 * 状态在 `.superdesign/v6-sync.json`（projectId + 每屏 draftId）：已推过的走 `--into` 出**新版本**，
 * 旧的留在历史里可回退；名字不要改，改名字等于在画布上多一屏。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const DRAFTS = join(ROOT, '.superdesign', 'drafts', 'v6');
const OUT = join(ROOT, '.superdesign', 'tmp', 'v6-packed');
const STATE_FILE = join(ROOT, '.superdesign', 'v6-sync.json');
const PROJECT_FILE = join(ROOT, '.superdesign', 'v6-project.json');
const USER_REQUEST = 'V6 设计稿：窄屏 + 桌面';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
	const at = args.indexOf(name);
	return at === -1 ? fallback : args[at + 1];
};

/* 画布上的顺序 = 总览页（v6/index.html）的分节顺序：先窄屏 25 屏，再桌面 13 屏。
   第三列是画布上的标题，改标题不影响已推的草稿（`--into` 只换内容）。 */
const SCREENS = [
	['10-onboarding', 390, 844, '01 第一次打开：说明它是什么'],
	['11-model-setup', 390, 844, '02 接上模型'],
	['12-empty', 390, 844, '03 刚装好：还没有团队'],
	['01-assistant', 390, 844, '04 助理（默认首屏）'],
	['06-profile', 390, 844, '05 助理的资料'],
	['07-tasks', 390, 844, '06 后台任务'],
	['02-chats', 390, 844, '07 对话列表'],
	['03-chat-group', 390, 844, '08 群聊（团队频道）'],
	['08-channel', 390, 844, '09 频道资料'],
	['26-channel-settings', 390, 844, '10 频道资料：点开共享指令'],
	['04-chat-dm', 390, 844, '11 私聊'],
	['23-person', 390, 844, '12 一个人的资料（含 Token 用量）'],
	['19-longpress', 390, 844, '13 长按一条消息'],
	['05-settings', 390, 844, '14 设置'],
	['24-plugins', 390, 844, '15 插件'],
	['25-tokens', 390, 844, '16 Token 用量'],
	['05-settings-proxy', 390, 844, '17 更新代理（点开）'],
	['16-assistant-light', 390, 844, '18 助理 · 浅色'],
	['17-chats-light', 390, 844, '19 对话 · 浅色'],
	['18-settings-light', 390, 844, '20 设置 · 浅色'],
	['20-unread', 390, 844, '21 未读与回到底部'],
	['15-mention', 390, 844, '22 输入框里打 @'],
	['09-logo', 390, 844, '23 标识（深浅两套）'],
	['13-failure', 390, 844, '24 没答上来'],
	['14-options', 390, 844, '25 等我选'],
	['d07-onboarding', 1440, 900, 'D01 第一次打开（桌面）', 'desktop/d07-onboarding'],
	['d08-model-setup', 1440, 900, 'D02 接上模型（桌面）', 'desktop/d08-model-setup'],
	['d01-assistant', 1440, 900, 'D03 Solo 一张信纸', 'desktop/d01-assistant'],
	['d06-assistant-light', 1440, 900, 'D04 Solo · 浅色', 'desktop/d06-assistant-light'],
	['d02-team', 1440, 900, 'D05 对话合成一屏（团队频道）', 'desktop/d02-team'],
	['d03-dm', 1440, 900, 'D06 对话合成一屏（私聊）', 'desktop/d03-dm'],
	['d10-profile', 1440, 900, 'D07 Solo 右栏 · 资料', 'desktop/d10-profile'],
	['d04-tasks', 1440, 900, 'D08 Solo 右栏 · 后台任务', 'desktop/d04-tasks'],
	['d05-settings', 1440, 900, 'D09 设置是一张弹窗', 'desktop/d05-settings'],
	['d12-settings-proxy', 1440, 900, 'D10 更新代理（点开）', 'desktop/d12-settings-proxy'],
	['d13-plugins', 1440, 900, 'D11 插件（设置里就地换页）', 'desktop/d13-plugins'],
	['d14-tokens', 1440, 900, 'D12 Token 用量（设置里就地换页）', 'desktop/d14-tokens'],
	['d11-narrow', 900, 900, 'D13 同一个文件拉窄', 'desktop/d01-assistant'],
];

const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

function dataUri(file) {
	const mime = MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream';
	return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
}

/** 打成一屏一个完整文档：内嵌样式表、头像转 data URI。 */
function pack(file) {
	const dir = dirname(file);
	let html = readFileSync(file, 'utf8');

	html = html.replace(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"[^>]*\/?>/g, (_, href) => {
		return `<style>\n${readFileSync(resolve(dir, href), 'utf8')}\n</style>`;
	});

	html = html.replace(/(<(?:img|source)[^>]+src=")([^"]+)(")/g, (whole, a, src, c) => {
		if (/^(https?:|data:)/.test(src)) return whole;
		const abs = resolve(dir, src);
		return existsSync(abs) ? a + dataUri(abs) + c : whole;
	});

	html = html.replace(/url\((['"]?)([^'")]+)\1\)/g, (whole, q, src) => {
		if (/^(https?:|data:|#)/.test(src)) return whole;
		const abs = resolve(dir, src);
		return existsSync(abs) ? `url(${dataUri(abs)})` : whole;
	});

	// 稿子里的一屏就是整屏：body 不留边距，画布里不出现滚动条。
	return html.replace('</head>', '\t<style>html,body{margin:0;overflow:hidden}</style>\n</head>');
}

const screens = SCREENS.map(([name, width, height, title, rel]) => ({
	name,
	width,
	height,
	title,
	file: join(DRAFTS, `${rel ?? name}.html`),
}));

const wanted = (() => {
	const only = value('--only', '');
	return only === '' ? null : new Set(only.split(',').map((s) => s.trim()));
})();

mkdirSync(OUT, { recursive: true });
const packed = [];
for (const s of screens) {
	if (wanted !== null && !wanted.has(s.name)) continue;
	const target = join(OUT, `${s.name}.html`);
	writeFileSync(target, pack(s.file));
	packed.push({ ...s, target, bytes: readFileSync(target).length });
}

console.log(packed.map((s) => `${s.name.padEnd(22)} ${String(Math.round(s.bytes / 1024)).padStart(4)} KB  ${s.title}`).join('\n'));

if (!flag('--push')) {
	console.log('\n没有推（加 --push）。产物在 .superdesign/tmp/v6-packed/。');
	process.exit(0);
}

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { projectId: '', drafts: {} };
const projectId = value('--project', state.projectId || (existsSync(PROJECT_FILE) ? JSON.parse(readFileSync(PROJECT_FILE, 'utf8')).projectId : ''));
if (projectId === '') {
	console.log('没有 projectId：先跑 create-project，把 id 写进 .superdesign/v6-project.json（{ "projectId": "…" }）。');
	process.exit(1);
}
state.projectId = projectId;

let ok = 0;
for (const s of packed) {
	const known = state.drafts?.[s.name]?.draftId;
	const argv = known
		? ['import-design-draft', '--into', known, '--html-file', s.target, '--user-request', USER_REQUEST]
		: ['import-design-draft', '--project-id', projectId, '--title', s.title,
			'--width', String(s.width), '--height', String(s.height), '--html-file', s.target, '--user-request', USER_REQUEST];

	const r = spawnSync('npx', ['--yes', '@superdesign/cli@latest', ...argv], { cwd: ROOT, encoding: 'utf8' });
	const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
	const id = /draftId\s+([0-9a-f-]{36})/.exec(out)?.[1];
	if (id === undefined) {
		console.log(`✗ ${s.name}\n${out.split('\n').filter(Boolean).slice(-5).join('\n')}`);
		continue;
	}
	state.drafts ??= {};
	state.drafts[s.name] = { draftId: known ?? id, title: s.title, width: s.width, height: s.height };
	writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
	ok++;
	console.log(`✓ ${s.name}  ${id}${known ? ' (新版本)' : ''}`);
}

console.log(`\n推完：${ok}/${packed.length}`);
