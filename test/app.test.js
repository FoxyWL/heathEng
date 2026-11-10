'use strict';
// Process-level behaviour: window lifecycle, auto-quit, background mode, real app-mode window.
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const shots = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-shots-'));
fs.mkdirSync(shots, { recursive: true });
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

function startAgent(port, extra = {}, wrap = []) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-app-'));
  const env = { ...process.env, DATA_DIR: data, PORT: String(port), NO_BROWSER: '1', HEARTH_NO_OPEN: '1', AUTOQUIT_GRACE_MS: '1500', ...extra };
  const cmd = wrap.length ? wrap[0] : 'node';
  const args = wrap.length ? [...wrap.slice(1), 'node', path.join(root, 'main.js')] : [path.join(root, 'main.js')];
  const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const h = { p, data, out: '', exited: false, port };
  p.stdout.on('data', (d) => (h.out += d));
  p.stderr.on('data', (d) => (h.out += d));
  p.on('exit', () => (h.exited = true));
  return h;
}
async function ready(h) {
  for (let i = 0; i < 80 && !/token=/.test(h.out); i++) await wait(100);
  h.token = (/token=([0-9a-f]+)/.exec(h.out) || [])[1];
  assert(h.token, 'agent did not start: ' + h.out);
  h.api = async (m, p, body) => {
    const r = await fetch(`http://127.0.0.1:${h.port}${p}`, { method: m, headers: { authorization: 'Bearer ' + h.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return r.json().catch(() => ({}));
  };
  return h;
}
async function exitsWithin(h, ms) {
  for (let i = 0; i < ms / 100 && !h.exited; i++) await wait(100);
  return h.exited;
}
const portFree = (port) =>
  new Promise((res) => {
    const s = net.createServer().once('error', () => res(false)).listen(port, '127.0.0.1', () => s.close(() => res(true)));
  });
const cleanup = (h) => {
  try {
    h.p.kill('SIGKILL');
  } catch {}
  fs.rmSync(h.data, { recursive: true, force: true });
};

async function main() {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });

  await step('closing the window exits Hearth when nothing is running', async () => {
    const h = await ready(startAgent(17040, { HEARTH_AUTOQUIT: '1' }));
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:17040/#token=${h.token}`);
    await page.waitForSelector('.welcome');
    assert((await h.api('GET', '/api/system')).windows === 1, 'one window counted');
    await page.close();
    assert(await exitsWithin(h, 6000), 'agent should exit after the window closed');
    assert(/выход/i.test(h.out), 'exit message');
    assert(!fs.existsSync(path.join(h.data, 'agent.json')), 'lock removed');
    cleanup(h);
  });

  await step('reloading the window does not quit (grace period)', async () => {
    const h = await ready(startAgent(17041, { HEARTH_AUTOQUIT: '1' }));
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:17041/#token=${h.token}`);
    await page.waitForSelector('.welcome');
    await page.reload();
    await page.waitForSelector('.welcome');
    await wait(3000);
    assert(!h.exited, 'agent quit during reload');
    await page.close();
    assert(await exitsWithin(h, 6000));
    cleanup(h);
  });

  await step('closing the window keeps running servers alive in the background', async () => {
    const h = await ready(startAgent(17042, { HEARTH_AUTOQUIT: '1' }));
    const v = await h.api('POST', '/api/servers', { game: 'custom', name: 'bg', settings: { command: `node ${path.join(root, 'test/fake-game.js')} 15601`, port: 15601, stopCommand: 'stop' } });
    await h.api('POST', `/api/servers/${v.id}/start`);
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:17042/#token=${h.token}`);
    await page.waitForSelector('.badge.running');
    await page.close();
    await wait(4000);
    assert(!h.exited, 'agent must stay alive while a server runs');
    assert(/остаётся в фоне/.test(h.out), 'background message');
    assert(!(await portFree(15601)), 'game server still listening');
    const page2 = await browser.newPage();
    await page2.goto(`http://127.0.0.1:17042/#token=${h.token}`);
    await page2.waitForSelector('.badge.running');
    await page2.close();
    await h.api('POST', '/api/quit');
    assert(await exitsWithin(h, 8000), 'agent should exit after /api/quit');
    await wait(300);
    assert(await portFree(15601), 'game server must be stopped on quit');
    cleanup(h);
  });

  await step('second launch reuses the running instance instead of failing', async () => {
    const h = await ready(startAgent(17043, {}));
    const second = startAgent(17043, {});
    second.data = h.data;
    second.p.kill();
    const env = { ...process.env, DATA_DIR: h.data, PORT_START: '17043', NO_BROWSER: '1' };
    const out = execSync(`node ${path.join(root, 'main.js')} 2>&1; echo exit=$?`, { env }).toString();
    assert(/уже запущен/.test(out) && /exit=0/.test(out), out);
    cleanup(h);
  });

  await step('startup problems are explained (not a silent closing window)', async () => {
    const env = { ...process.env, DATA_DIR: '/etc/passwd/x', PORT: '17044', NO_BROWSER: '1' };
    let out = '';
    try {
      execSync(`node ${path.join(root, 'main.js')} 2>&1`, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = String(e.stdout);
    }
    assert(/не смог запуститься/.test(out) && /ENOTDIR/.test(out), out);
    fs.rmSync(path.join(root, 'data'), { recursive: true, force: true });
  });

  await step('real app-mode window: opens, shows the UI, closing it exits Hearth', async () => {
    const xvfb = spawn('Xvfb', [':97', '-screen', '0', '1280x860x24'], { stdio: 'ignore' });
    await wait(1200);
    const h = startAgent(17045, { HEARTH_APP: '1', NO_BROWSER: '0', HEARTH_BROWSER: '/usr/bin/google-chrome', AUTOQUIT_GRACE_MS: '2000', DISPLAY: ':97' });
    try {
      await ready(h);
      let sys = {};
      for (let i = 0; i < 80; i++) {
        sys = await h.api('GET', '/api/system');
        if (sys.windows >= 1) break;
        await wait(250);
      }
      assert(sys.appMode === true, 'appMode flag: ' + JSON.stringify(sys) + '\n' + h.out);
      assert(sys.windows >= 1, 'the window never connected');
      assert(/Открыто окно приложения/.test(h.out), h.out);
      const procs = [];
      for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
        try {
          const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          if (cmd.includes('--app=http://127.0.0.1:17045') && cmd.includes('app-profile')) procs.push(+pid);
        } catch {}
      }
      assert(procs.length >= 1, 'no Chrome process started with --app');
      await wait(1500);
      execSync(`DISPLAY=:97 import -window root ${path.join(shots, '10-app-window.png')}`);
      for (const pid of procs) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
        try {
          const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          if (cmd.includes('app-profile') && cmd.includes('chrome')) process.kill(+pid, 'SIGKILL');
        } catch {}
      }
      assert(await exitsWithin(h, 9000), 'Hearth should exit after its window was closed');
    } finally {
      cleanup(h);
      xvfb.kill('SIGKILL');
    }
  });

  await browser.close();
  console.log(`\n${pass} passed, ${failed.length} failed`);
  if (failed.length) console.log('Failed:\n - ' + failed.join('\n - '));
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
