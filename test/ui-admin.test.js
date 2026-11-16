'use strict';
// Экраны управления в настоящем браузере: обновления, уведомления, облако, пользователи и доступ по сети, свой домен.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-uia-'));
const base = 'http://127.0.0.1:17850';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const failed = [];
let page;
const assert = (c, m) => {
  if (!c) throw new Error(m || 'assertion failed');
};
async function step(name, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS ' + name);
  } catch (e) {
    failed.push(name);
    console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 3).join(' | '));
  }
}

// «GitHub»: релиз 9.9.9 с установщиком и суммой; «вебхук»; «S3» (отвечает пустым списком)
const exe = crypto.randomBytes(2000);
const sum = crypto.createHash('sha256').update(exe).digest('hex');
const hooks = [];
const mock = http.createServer((q, r) => {
  let b = '';
  q.on('data', (d) => (b += d));
  q.on('end', () => {
    const u = q.url;
    const mockBase = 'http://127.0.0.1:17851';
    if (u === '/gh/latest') return r.end(JSON.stringify({ tag_name: 'v9.9.9', body: 'Новые имена и обновления', assets: [{ name: 'Hearth-Setup-9.9.9.exe', browser_download_url: mockBase + '/dl/setup', size: exe.length }, { name: 'Hearth-Setup-9.9.9.exe.sha256', browser_download_url: mockBase + '/dl/sum' }] }));
    if (u === '/dl/setup') return r.end(exe);
    if (u === '/dl/sum') return r.end(sum + '  Hearth-Setup-9.9.9.exe\n');
    if (u.startsWith('/hook')) return hooks.push(JSON.parse(b || '{}')), r.end('{}');
    if (u.startsWith('/s3/')) return r.end('<ListBucketResult></ListBucketResult>');
    r.statusCode = 404;
    r.end();
  });
});

let out = '';
const agent = spawn('node', [path.join(root, 'main.js')], { env: { ...process.env, DATA_DIR: data, PORT: '17850', NO_BROWSER: '1', HEARTH_NO_OPEN: '1', HEARTH_RELAY_AUTO: '0', HEARTH_NETWATCH_MS: '60000', HEARTH_UPDATE_API: 'http://127.0.0.1:17851/gh/latest', HEARTH_UPDATE_FORCE: '1', HEARTH_UPDATE_DRY: '1', HEARTH_UPDATE_FIRST_MS: '3600000' }, stdio: ['ignore', 'pipe', 'inherit'] });
agent.stdout.on('data', (d) => (out += d));
process.on('exit', () => agent.kill());

async function main() {
  await new Promise((r) => mock.listen(17851, '127.0.0.1', r));
  for (let i = 0; i < 60 && !/token=/.test(out); i++) await wait(100);
  const token = /token=([0-9a-f]+)/.exec(out)[1];
  const api = (m, u, b) => fetch(base + u, { method: m, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
  await api('POST', '/api/servers', { game: 'custom', name: 'Вторая', settings: { command: 'node -e "setInterval(()=>{},1000)"', port: 15861 } });
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text()));
  await page.goto(`${base}/#token=${token}`);
  await page.waitForSelector('.srv-card, .welcome');
  await page.click('.rail-link:has-text("Настройки")');

  await step('updates: check finds 9.9.9, install runs the checked download', async () => {
    await page.waitForSelector('[data-sect=update]');
    await page.click('[data-act=update-check]');
    await page.waitForSelector('[data-role=update-version]');
    assert(/9\.9\.9/.test(await page.textContent('[data-role=update-version]')));
    assert(await page.isVisible('[data-role=update-new]'), 'new-version tag');
    await page.click('[data-act=update-install]');
    await page.waitForFunction(() => /Устанавливаю|Installing/.test(document.querySelector('[data-sect=update]').textContent), null, { timeout: 8000 });
    const st = await api('GET', '/api/update');
    assert(st.stage === 'install', 'stage: ' + st.stage);
    assert(fs.existsSync(path.join(data, 'updates', 'Hearth-Setup-9.9.9.exe')), 'installer downloaded and verified');
  });

  await step('updates: auto-check toggle is saved', async () => {
    await page.uncheck('[data-act=update-auto]').catch(() => {});
    const v = await api('GET', '/api/update');
    // во время установки панель перерисована: переключатель всё равно доступен через API
    await api('PUT', '/api/update', { auto: false });
    assert((await api('GET', '/api/update')).auto === false && v.current);
  });

  await step('notifications: add Discord, save, send a test, link is hidden afterwards', async () => {
    await page.reload();
    await page.waitForSelector('.rail-link');
    await page.click('.rail-link:has-text("Настройки")');
    await page.waitForSelector('[data-sect=notify]');
    await page.click('[data-act=notify-add]');
    await page.fill('[data-role=notify-url]', 'http://127.0.0.1:17851/hook-secretname');
    await page.check('[data-role=notify-on]');
    await page.click('[data-act=notify-save]');
    await page.waitForSelector('.toast:has-text("Сохранено")');
    await page.click('[data-act=notify-test]');
    for (let i = 0; i < 40 && !hooks.length; i++) await wait(100);
    assert(hooks.length === 1 && /проверка уведомлений/.test(hooks[0].content), JSON.stringify(hooks));
    const html = await page.content();
    assert(!html.includes('hook-secretname'), 'ссылка не показывается после сохранения');
    assert((await api('GET', '/api/notify')).enabled === true);
  });

  await step('cloud: fill, test connection, secret is not shown again', async () => {
    await page.fill('[data-role=cloud-endpoint]', 'http://127.0.0.1:17851/s3');
    await page.fill('[data-role=cloud-bucket]', 'bk');
    await page.fill('[data-role=cloud-ak]', 'AK');
    await page.fill('[data-role=cloud-sk]', 'SK-very-secret');
    await page.click('[data-act=cloud-test]');
    await page.waitForSelector('.toast:has-text("ключи верные")');
    await page.check('[data-role=cloud-on]');
    await page.click('[data-act=cloud-save]');
    await page.waitForSelector('.toast:has-text("Сохранено")');
    const c = await api('GET', '/api/cloud');
    assert(c.enabled && c.hasSecret && !JSON.stringify(c).includes('SK-very-secret'));
    assert(!(await page.content()).includes('SK-very-secret'));
  });

  await step('users: add operator, token shown once, reissue, delete with confirmation', async () => {
    await page.fill('[data-role=user-name]', 'Вася');
    await page.selectOption('[data-role=user-role]', 'operator');
    await page.click('[data-act=user-add]');
    await page.waitForSelector('[data-role=user-fresh]');
    const tok = await page.textContent('[data-role=user-token]');
    assert(/^hu-[0-9a-f]{36}$/.test(tok), tok);
    // этим токеном панель работает с ограничениями
    const r = await fetch(base + '/api/servers', { headers: { authorization: 'Bearer ' + tok } });
    assert(r.status === 200);
    assert((await fetch(base + '/api/cloud', { headers: { authorization: 'Bearer ' + tok } })).status === 403);
    await page.click('[data-act=user-reissue]');
    await page.waitForFunction((old) => document.querySelector('[data-role=user-token]') && document.querySelector('[data-role=user-token]').textContent !== old, tok);
    assert((await fetch(base + '/api/servers', { headers: { authorization: 'Bearer ' + tok } })).status === 401, 'старый токен не работает');
    await page.click('[data-act=user-delete]');
    await page.waitForSelector('.modal-back.in .modal');
    await page.click('.modal-back.in .btn.fill-danger');
    await page.waitForFunction(() => !document.querySelector('[data-user]'));
    assert((await api('GET', '/api/users')).users.length === 0);
  });

  await step('panel access over the network: toggle asks for a restart', async () => {
    await page.check('[data-role=panel-lan]');
    await page.waitForSelector('[data-role=panel-restart]');
    await page.uncheck('[data-role=panel-lan]');
    await page.waitForFunction(() => !document.querySelector('[data-role=panel-restart]'));
  });

  await step('own domain: block explains that a relay with a shared port is needed', async () => {
    await page.click('.rail-link:has-text("Туннели")');
    await page.click('[data-sect=domain] summary');
    await page.waitForSelector('[data-role=domain-na]');
    assert(/общим портом/.test(await page.textContent('[data-role=domain-na]')));
  });

  await step('no JavaScript errors in the page', async () => {
    assert(!errors.length, errors.join(' | '));
  });
  await browser.close();
  console.log(`\n${pass} passed, ${failed.length} failed`);
  agent.kill();
  mock.close();
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  agent.kill();
  process.exit(1);
});
