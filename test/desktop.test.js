'use strict';
// Оболочка Electron (Linux, Xvfb): окно с панелью, один экземпляр, трей/фон, выход.
// Запускается, если найден Electron: HEARTH_ELECTRON=/путь/к/electron (или /tmp/el-linux).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const EL = [process.env.HEARTH_ELECTRON, '/tmp/el-linux/node_modules/electron/dist/electron', path.join(root, 'node_modules/electron/dist/electron')].find((p) => p && fs.existsSync(p));
if (!EL || process.platform !== 'linux') {
  console.log('SKIP desktop shell tests: Electron for Linux not found (set HEARTH_ELECTRON)');
  process.exit(0);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const failed = [];
async function step(name, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS ' + name);
  } catch (e) {
    failed.push(name);
    console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n')[0]);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m || 'assertion failed');
};

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-desk-'));
const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-deskshots-'));
const PORT = 17910;
const CDP = 17911;
const INSPECT = 17912;
const xvfb = spawn('Xvfb', [':89', '-screen', '0', '1400x900x24'], { stdio: 'ignore' });
const env = { ...process.env, HEARTH_TEST_HOOK: '1', DISPLAY: ':89', DATA_DIR: data, PORT: String(PORT), HEARTH_NO_OPEN: '1', HEARTH_RELAY_AUTO: '0', HEARTH_CORE: 'off' };
delete env.NODE_OPTIONS; // --use-openssl-ca ломает Electron
const launch = (extra = []) => {
  const h = { out: '', exited: false, code: null };
  h.p = spawn(EL, ['--no-sandbox', ...extra, root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  h.p.stdout.on('data', (d) => (h.out += d));
  h.p.stderr.on('data', (d) => (h.out += d));
  h.p.on('exit', (c) => ((h.exited = true), (h.code = c)));
  return h;
};
const exitsWithin = async (h, ms) => {
  for (let i = 0; i < ms / 100 && !h.exited; i++) await wait(100);
  return h.exited;
};
// вычисление в главном процессе Electron через отладчик Node
async function inMain(expr) {
  const list = await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`)).json();
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  return new Promise((resolve) => {
    ws.onmessage = (m) => {
      const j = JSON.parse(m.data);
      if (j.id === 1) {
        ws.close();
        resolve(j.result && j.result.result ? j.result.result.value : undefined);
      }
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(function(){const e=globalThis.__hearthTest.electron;${expr}})()`, returnByValue: true } }));
  });
}

(async () => {
  await wait(800);
  let app = launch([`--remote-debugging-port=${CDP}`, `--inspect=${INSPECT}`]);
  let browser;
  let page;
  await step('app starts and opens its own window with the panel', async () => {
    for (let i = 0; i < 100; i++) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
        const pages = browser.contexts().flatMap((c) => c.pages());
        page = pages.find((p) => p.url().startsWith(`http://127.0.0.1:${PORT}`));
        if (page) break;
      } catch {}
      await wait(200);
    }
    assert(page, 'no panel window: ' + app.out.slice(-400));
    await page.waitForSelector('.rail', { timeout: 15000 });
    assert((await page.title()) === 'Hearth', 'title ' + (await page.title()));
    assert(/Electron/.test(await page.evaluate(() => navigator.userAgent)), 'not an Electron window');
    await page.screenshot({ path: path.join(shots, 'd1-window.png') });
  });
  await step('window is a real app window: size, no menu bar, icon', async () => {
    const r = await inMain("const w=e.BrowserWindow.getAllWindows()[0];return JSON.stringify({n:e.BrowserWindow.getAllWindows().length,b:w.getBounds(),t:w.getTitle(),menu:w.isMenuBarVisible()})");
    const j = JSON.parse(r);
    assert(j.n === 1 && j.t === 'Hearth' && j.b.width >= 900 && j.b.height >= 600, r);
    assert(j.menu === false, 'menu bar must stay hidden: ' + r);
  });
  await step('window is sandboxed: no Node in the page, outside links are not opened inside', async () => {
    assert(await page.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined'), 'Node is exposed to the page');
    const r = await inMain("const w=e.BrowserWindow.getAllWindows()[0];w.webContents.executeJavaScript(\"window.open('https://example.com/')\");return 1");
    await wait(600);
    const pages = browser.contexts().flatMap((c) => c.pages());
    assert(pages.length === 1 && pages[0].url().startsWith('http://127.0.0.1'), 'extra window opened: ' + pages.map((p) => p.url()).join());
    await page.evaluate(() => (location.href = 'https://example.com/'));
    await wait(600);
    assert(page.url().startsWith('http://127.0.0.1'), 'navigated away: ' + page.url());
  });
  await step('second launch does not start another app: exits at once, existing window is shown', async () => {
    const second = launch();
    assert(await exitsWithin(second, 15000), 'second instance kept running');
    assert(app.exited === false, 'first instance died');
    const r = await inMain('return e.BrowserWindow.getAllWindows().length');
    assert(r === 1, 'windows: ' + r);
  });
  await step('closing the window with a running server keeps Hearth in the tray', async () => {
    const token = (/token=([0-9a-f]+)/.exec(app.out) || [])[1];
    assert(token, 'no token');
    const api = async (m, p, b) => (await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json().catch(() => ({}));
    const sv = await api('POST', '/api/servers', { game: 'custom', name: 'Idle', command: 'node -e "setInterval(()=>{},1000)"', settings: { port: 15991 } });
    assert(sv.id, JSON.stringify(sv));
    await api('POST', `/api/servers/${sv.id}/start`);
    for (let i = 0; i < 40; i++) {
      const l = await api('GET', '/api/servers');
      if (Array.isArray(l) && l[0] && l[0].status === 'running') break;
      await wait(250);
    }
    await inMain('e.BrowserWindow.getAllWindows()[0].close()');
    await wait(1500);
    assert(!app.exited, 'Hearth quit while a server was running');
    assert((await inMain('return e.BrowserWindow.getAllWindows().length')) === 0, 'window did not close');
    assert((await fetch(`http://127.0.0.1:${PORT}/api/ping`).then((r) => r.json())).app === 'hearth', 'agent is not answering in the background');
  });
  await step('launching again brings the window back from the tray', async () => {
    const again = launch();
    assert(await exitsWithin(again, 15000), 'second instance kept running');
    await wait(800);
    assert((await inMain('return e.BrowserWindow.getAllWindows().length')) === 1, 'window not restored');
  });
  await step('window size is remembered between launches', async () => {
    await inMain('const w=e.BrowserWindow.getAllWindows()[0];w.setBounds({x:60,y:40,width:1111,height:777});w.close();return 1');
    await wait(800);
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'window.json'), 'utf8'));
    assert(saved.width === 1111 && saved.height === 777, JSON.stringify(saved));
  });
  await step('quit from the app stops the server and exits the process', async () => {
    const token = (/token=([0-9a-f]+)/.exec(app.out) || [])[1];
    await fetch(`http://127.0.0.1:${PORT}/api/quit`, { method: 'POST', headers: { authorization: 'Bearer ' + token } });
    assert(await exitsWithin(app, 25000), 'Hearth did not exit');
    const left = spawnSync('pgrep', ['-f', 'setInterval\\(\\(\\)=>\\{\\},1000\\)']).stdout.toString().trim();
    assert(!left, 'game process is still alive: ' + left);
  });
  await step('closing the window with nothing running quits the app', async () => {
    fs.rmSync(path.join(data, 'agent.json'), { force: true });
    app = launch([`--remote-debugging-port=${CDP}`, `--inspect=${INSPECT}`]);
    for (let i = 0; i < 100 && !/token=/.test(app.out); i++) await wait(150);
    await wait(2500);
    await inMain('e.BrowserWindow.getAllWindows()[0].close()');
    assert(await exitsWithin(app, 25000), 'Hearth stayed in memory with nothing to do');
  });
  await step('--startup starts hidden in the tray (no window)', async () => {
    fs.rmSync(path.join(data, 'agent.json'), { force: true });
    app = launch(['--startup', `--inspect=${INSPECT}`]);
    for (let i = 0; i < 100 && !/token=/.test(app.out); i++) await wait(150);
    await wait(2000);
    assert((await inMain('return e.BrowserWindow.getAllWindows().length')) === 0, 'window opened on --startup');
    assert(!app.exited, 'exited');
    const token = (/token=([0-9a-f]+)/.exec(app.out) || [])[1];
    await fetch(`http://127.0.0.1:${PORT}/api/quit`, { method: 'POST', headers: { authorization: 'Bearer ' + token } });
    assert(await exitsWithin(app, 20000), 'did not exit');
  });
  try {
    if (browser) await browser.close();
  } catch {}
  xvfb.kill();
  console.log(`\n${pass} passed, ${failed.length} failed. Screenshots: ${shots}`);
  process.exit(failed.length ? 1 : 0);
})();
