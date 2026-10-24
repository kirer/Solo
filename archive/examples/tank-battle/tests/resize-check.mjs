/**
 * 自适应缩放检查（Chrome CDP）：验证 canvas 始终按整数倍放大、最小 1x。
 * 需先启动 python3 -m http.server 8123
 * 运行：node tests/resize-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const candidates = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  process.env.CHROME_PATH,
].filter(Boolean);
const chrome = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!chrome) { console.error('未找到浏览器'); process.exit(2); }

const URL = process.env.GAME_URL || 'http://localhost:8123/index.html';
const PORT = 9380;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, '--window-size=1400,1200', '--user-data-dir=/tmp/chrome-tank-resize', 'about:blank'], { stdio: 'ignore' });

let ws; let id = 1; const pending = new Map();
function send(m, p = {}) { const i = id++; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((r) => pending.set(i, r)); }
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error('Chrome 未就绪');
}

try {
  ws = new WebSocket(await connect());
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(2200);

  const read = () => send('Runtime.evaluate', { returnByValue: true, expression: `(() => { const c = document.getElementById('game'); return { w: c.width, h: c.height, scale: window.__tankBattle.renderer.scale }; })()` }).then((r) => r.result.value);

  const cases = [[1400, 1200, 5], [900, 900, 3], [700, 700, 2], [300, 400, 1]];
  let failed = 0;
  for (const [w, h, expect] of cases) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('resize'))` });
    await sleep(500);
    const r = await read();
    const ok = r.scale === expect && r.w === 208 * expect && r.h === 208 * expect;
    console.log(`${ok ? '✓' : '✗'} ${w}x${h} -> scale ${r.scale} (${r.w}x${r.h})，期望 ${expect}x`);
    if (!ok) failed++;
  }
  console.log(failed === 0 ? 'RESIZE OK' : `RESIZE FAILED (${failed})`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  proc.kill('SIGKILL');
}
