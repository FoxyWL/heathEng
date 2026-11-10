'use strict';
// Интерфейс новых функций в настоящем браузере: обзор, свёрнутая панель, палитра, каталог игр,
// игроки, плагины с онлайн-поиском, мир, параметры запуска, подсказки команд.
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const shots = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-uishots-'));
fs.mkdirSync(shots, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-uif-'));
const mcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-uimc-'));
fs.writeFileSync(path.join(mcDir, 'server.jar'), 'x');
fs.writeFileSync(path.join(mcDir, 'whitelist.json'), JSON.stringify([{ uuid: 'u1', name: 'Alex' }]));
fs.writeFileSync(path.join(mcDir, 'ops.json'), JSON.stringify([{ uuid: 'u2', name: 'Boss', level: 4 }]));
fs.writeFileSync(path.join(mcDir, 'banned-players.json'), JSON.stringify([{ uuid: 'u3', name: 'Griefer', reason: 'grief' }]));
fs.mkdirSync(path.join(mcDir, 'world'));
fs.writeFileSync(path.join(mcDir, 'world', 'level.dat'), 'x'.repeat(2048));
const base = 'http://127.0.0.1:17130';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const jar = Buffer.from('PK-fake-plugin-jar-' + 'x'.repeat(300));
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (o) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(o));
  };
  if (u.pathname === '/search') {
    const q = u.searchParams.get('query') || '';
    if (q === 'nothing') return send({ hits: [] });
    return send({ hits: [{ project_id: 'AbCdEf12', slug: 'essentialsx', title: 'EssentialsX', description: 'Команды и сервисы для сервера', author: 'EssentialsX', downloads: 5000000, icon_url: '', date_modified: '2026-01-01', categories: ['paper', 'utility'] }] });
  }
  if (u.pathname === '/project/AbCdEf12/version') return send([{ version_number: '2.21.0', version_type: 'release', files: [{ primary: true, filename: 'EssentialsX-2.21.0.jar', url: 'http://127.0.0.1:17792/files/e.jar', hashes: { sha1: crypto.createHash('sha1').update(jar).digest('hex') } }] }]);
  if (u.pathname === '/files/e.jar') return res.end(jar);
  res.statusCode = 404;
  res.end('{}');
});

const agent = spawn('node', [path.join(root, 'main.js')], {
  env: { ...process.env, DATA_DIR: data, PORT: '17130', NO_BROWSER: '1', HEARTH_NO_OPEN: '1', HEARTH_MODRINTH_API: 'http://127.0.0.1:17792', HEARTH_STATS_MS: '500', PATH: path.join(__dirname, 'fakebin') + path.delimiter + process.env.PATH },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let out = '';
agent.stdout.on('data', (d) => (out += d));

let pass = 0;
const failed = [];
let page;
async function step(name, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS ' + name);
  } catch (e) {
    failed.push(name);
    console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 3).join(' | '));
    try {
      await page.screenshot({ path: path.join(shots, 'FAIL-' + failed.length + '.png') });
    } catch {}
  }
}
const assert = (c, msg) => {
  if (!c) throw new Error(msg || 'assertion failed');
};
const closed = () => page.waitForFunction(() => !document.querySelector('.modal-back'), null, { timeout: 4000 });
const tab = (n) => page.click(`.tab:has-text("${n}")`);
const shot = (n) => page.screenshot({ path: path.join(shots, n + '.png') });
const stateIs = (t, ms = 9000) => page.waitForFunction((x) => document.querySelector('.badge') && document.querySelector('.badge').textContent === x, t, { timeout: ms });

async function main() {
  await new Promise((r) => mock.listen(17792, '127.0.0.1', r));
  for (let i = 0; i < 60 && !/token=/.test(out); i++) await wait(100);
  const token = /token=([0-9a-f]+)/.exec(out)[1];
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text()));
  await page.goto(`${base}/#token=${token}`);
  await page.waitForSelector('.welcome');

  await step('catalog: 20+ games, search and tag filters', async () => {
    await page.click('.welcome .btn.primary');
    await page.waitForSelector('.modal-back.in .gcard');
    assert((await page.locator('.gcard').count()) >= 20);
    await page.fill('.modal input[type=search]', 'rust');
    assert((await page.locator('.gcard').count()) === 1 && (await page.locator('.gcard').first().textContent()).includes('Rust'));
    await page.fill('.modal input[type=search]', '');
    await page.click('.modal .chip:has-text("Шутеры")');
    const n = await page.locator('.gcard').count();
    assert(n >= 5 && n < 26, 'shooters: ' + n);
    await page.fill('.modal input[type=search]', 'zzzz');
    assert(await page.locator('.gamegrid:has-text("Ничего не найдено")').isVisible());
    await shot('u1-catalog');
  });
  await step('catalog: AppID server shows AppID / exe / ports fields', async () => {
    await page.fill('.modal input[type=search]', '');
    await page.click('.modal .chip:has-text("Все")');
    await page.click('.gcard[data-game="steam-custom"]');
    for (const k of ['appId', 'exe', 'args', 'port', 'morePorts']) assert(await page.locator(`.modal [data-key="${k}"]`).isVisible(), 'missing field ' + k);
  });
  await step('catalog: Steam game shows SteamCMD note, Escape closes', async () => {
    await page.click('.gcard[data-game="cs2"]');
    assert((await page.locator('.cfg small.muted').textContent()).includes('SteamCMD'));
    await page.keyboard.press('Escape');
    await closed();
  });

  await step('create a Paper server from an existing folder', async () => {
    await page.click('.welcome .btn.primary');
    await page.waitForSelector('.modal-back.in .gcard');
    await page.click('.gcard[data-game="minecraft-paper"]');
    await page.check('.modal .check:has-text("уже есть") input');
    await page.fill('.modal input.mono[placeholder*="Games"]', mcDir);
    await page.fill('.modal input[placeholder="Мой сервер"]', 'Paper друзей');
    await page.locator('.modal .row .btn.primary').click();
    await page.waitForSelector('.head h1:has-text("Paper друзей")');
    await closed();
    await stateIs('Остановлен');
    for (const t of ['Консоль', 'Игроки', 'Плагины', 'Мир', 'Запуск', 'Настройки', 'Файлы']) assert(await page.locator(`.tab:has-text("${t}")`).count(), 'tab ' + t);
  });

  await step('overview: card, tiles, search, open server', async () => {
    await page.click('.rail-link:has-text("Обзор")');
    await page.waitForSelector('.srv-card');
    assert((await page.locator('.tile').count()) === 4);
    assert((await page.locator('.srv-card').count()) === 1);
    await page.fill('.head .actions input[type=search]', 'нет такого');
    assert((await page.locator('.srv-card').count()) === 0);
    await page.fill('.head .actions input[type=search]', 'paper');
    assert((await page.locator('.srv-card').count()) === 1);
    await shot('u2-overview');
    await page.click('.srv-card .card-main');
    await page.waitForSelector('.head h1:has-text("Paper друзей")');
  });
  await step('overview: start from the card, live tiles update', async () => {
    await page.click('.rail-link:has-text("Обзор")');
    await page.click('.srv-card .btn.primary');
    await page.waitForSelector('.modal-back.in');
    await page.locator('.modal .row .btn.primary').click();
    await page.waitForFunction(() => document.querySelector('.srv-card.running'), null, { timeout: 12000 });
    await page.waitForFunction(() => /1 \/ 1/.test(document.querySelector('.tile').textContent), null, { timeout: 5000 });
    await page.waitForFunction(() => /RAM\s*\d/.test(document.querySelector('.srv-card').textContent), null, { timeout: 9000 });
    await shot('u3-overview-live');
  });

  await step('live updates do not rebuild unchanged cards (clicks are not lost)', async () => {
    await wait(3000); // let startup transients (mem, players, cpu) settle
    await page.evaluate(() => { document.querySelector('.srv-card').dataset.mark = 'x'; document.querySelector('.srv').dataset.mark = 'x'; });
    await wait(3500);
    assert(await page.locator('.srv-card[data-mark="x"]').count() === 1, 'overview card was rebuilt');
    assert(await page.locator('.srv[data-mark="x"]').count() === 1, 'rail item was rebuilt');
  });
  await step('server page: resource tiles with CPU/RAM/players/uptime', async () => {
    await page.click('.srv-card .card-main');
    await page.waitForSelector('.resources');
    const t = await page.textContent('.resources');
    for (const w of ['CPU', 'RAM', 'Игроки', 'Аптайм']) assert(t.includes(w), 'tile ' + w);
    await page.waitForFunction(() => /Steve/.test(document.querySelector('.resources').textContent), null, { timeout: 6000 });
    await page.evaluate(() => { document.querySelector('.head h1').dataset.mark = 'x'; document.querySelector('.invite').dataset.mark = 'x'; });
    await wait(3500);
    assert(await page.locator('.head h1[data-mark="x"]').count() === 1, 'header was rebuilt without changes');
    assert(await page.locator('.invite[data-mark="x"]').count() === 1, 'invite was rebuilt without changes');
  });

  await step('console: command suggestions (Tab completes, items in Russian)', async () => {
    await page.fill('.cmd input', 'gamemode ');
    await page.fill('.cmd input', 'gamemode s');
    await page.waitForSelector('.sugg:not(.hidden) .sug');
    assert((await page.locator('.sug b').allTextContents()).includes('survival'));
    await page.press('.cmd input', 'Tab');
    assert((await page.inputValue('.cmd input')) === 'gamemode survival');
    await page.fill('.cmd input', 'give @a алм');
    await page.waitForSelector('.sugg:not(.hidden) .sug');
    assert((await page.locator('.sug small').allTextContents()).some((x) => /Алмаз/.test(x)), 'russian item names');
    await page.fill('.cmd input', '');
    await page.keyboard.press('Escape');
  });

  await step('players: online, whitelist, ops, bans from the server files', async () => {
    await tab('Игроки');
    await page.waitForSelector('.person');
    const t = await page.textContent('.players');
    for (const w of ['Steve', 'Alex', 'Boss', 'Griefer', 'grief']) assert(t.includes(w), 'missing ' + w);
    await shot('u4-players');
  });
  await step('players: Kick sends a command and updates the list', async () => {
    await page.locator('.person:has-text("Steve") .btn:has-text("Выгнать")').click();
    await page.waitForSelector('.modal-back.in');
    await page.locator('.modal .row .btn.primary').click();
    await page.waitForFunction(() => !/Steve/.test((document.querySelector('.players .sect') || {}).textContent || 'Steve'), null, { timeout: 6000 });
  });
  await step('players: add to whitelist validates the nickname', async () => {
    await page.locator('.sect:has-text("Белый список") .btn:has-text("Добавить")').click();
    await page.waitForSelector('.modal-back.in');
    await page.fill('.modal input', 'bad name!');
    await page.locator('.modal .row .btn.primary').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.toast.bad')].some((e) => /Ник/.test(e.textContent)));
    await closed();
    await page.locator('.sect:has-text("Белый список") .btn:has-text("Добавить")').click();
    await page.waitForSelector('.modal-back.in');
    await page.fill('.modal input', 'Newbie');
    await page.locator('.modal .row .btn.primary').click();
    await closed();
    await tab('Консоль');
    await page.waitForSelector('.ln:has-text("Executed: whitelist add Newbie")');
  });

  await step('plugins: empty list offers online search', async () => {
    await tab('Плагины');
    await page.waitForSelector('.plugins .empty');
    assert(await page.locator('.empty .btn:has-text("Найти онлайн")').isVisible());
  });
  await step('plugins: online search shows hits, "nothing" shows a message', async () => {
    await page.click('.empty .btn:has-text("Найти онлайн")');
    await page.waitForSelector('.hit');
    assert((await page.textContent('.hit')).includes('EssentialsX'));
    await page.fill('.searchbar input', 'nothing');
    await page.waitForSelector('.hits:has-text("Ничего не найдено")');
    await page.fill('.searchbar input', 'essentials');
    await page.waitForSelector('.hit');
    await shot('u5-plugin-search');
  });
  await step('plugins: install downloads the jar into plugins/ and flags a restart', async () => {
    await page.click('.hit .btn.primary');
    await page.waitForSelector('.hit .btn:has-text("Установлен")');
    assert(fs.existsSync(path.join(mcDir, 'plugins', 'EssentialsX-2.21.0.jar')), 'jar written');
  });
  await step('plugins: installed list, toggle off (.disabled), delete', async () => {
    await page.click('.seg-b[data-mode="installed"]');
    await page.waitForSelector('.pl:has-text("EssentialsX-2.21.0.jar")');
    await page.click('.pl .switch');
    await page.waitForFunction(() => document.querySelector('.pl.off'));
    assert(fs.existsSync(path.join(mcDir, 'plugins', 'EssentialsX-2.21.0.jar.disabled')));
    await page.click('.pl .btn.danger');
    await page.waitForSelector('.modal-back.in');
    await page.locator('.modal .row .btn.fill-danger').click();
    await page.waitForSelector('.plugins .empty');
    assert(!fs.existsSync(path.join(mcDir, 'plugins', 'EssentialsX-2.21.0.jar.disabled')));
  });

  await step('world: parts and size; reset is blocked while running', async () => {
    await tab('Мир');
    await page.waitForSelector('.world .tile');
    assert((await page.textContent('.world')).includes('world'));
    assert(await page.locator('.world .btn.danger').isDisabled(), 'reset disabled while running');
  });
  await step('launch: memory field, final command line, save', async () => {
    await tab('Запуск');
    await page.waitForSelector('.cmdline');
    await page.waitForFunction(() => /java/.test(document.querySelector('.cmdline').textContent), null, { timeout: 5000 });
    assert((await page.textContent('.cmdline')).includes('-Xmx2048M'));
    await page.fill('input[data-key="memory"]', '3072');
    await page.click('.savebar .btn.primary');
    await page.waitForFunction(() => /3072/.test(document.querySelector('.cmdline').textContent), null, { timeout: 5000 });
  });
  await step('stop, then reset the world (confirm), folder is removed', async () => {
    await page.locator('.head .actions .btn:has-text("Остановить")').click();
    await stateIs('Остановлен', 12000);
    await tab('Мир');
    await page.waitForFunction(() => { const b = document.querySelector('.world .btn.danger'); return b && !b.disabled; });
    await page.click('.world .btn.danger');
    await page.waitForSelector('.modal-back.in');
    await page.locator('.modal .row .btn.fill-danger').click();
    await page.waitForFunction(() => /ещё не создан/.test(document.querySelector('.world').textContent), null, { timeout: 5000 });
    assert(!fs.existsSync(path.join(mcDir, 'world')));
  });

  await step('rail: collapse to icons, state persists after reload, expand back', async () => {
    await page.click('.rail-toggle');
    await page.waitForSelector('.app.min');
    await wait(450);
    assert(await page.locator('.rail .gbadge').count() >= 1, 'server badge in the narrow rail');
    assert((await page.locator('.rail').evaluate((e) => e.getBoundingClientRect().width)) < 100);
    await shot('u6-rail-min');
    await page.reload();
    await page.waitForSelector('.app.min');
    await page.keyboard.press('Control+b');
    await page.waitForFunction(() => !document.querySelector('.app.min'));
  });
  await step('palette: Ctrl+K opens, filters, Enter jumps; Ctrl+N opens the catalog', async () => {
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#palette.in');
    await page.keyboard.type('туннел');
    await page.keyboard.press('Enter');
    await page.waitForSelector('h1:has-text("Туннели")');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#palette.in');
    await page.keyboard.type('paper');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.head h1:has-text("Paper друзей")');
    await page.keyboard.press('Control+n');
    await page.waitForSelector('.modal-back.in .gcard');
    await page.keyboard.press('Escape');
    await closed();
  });
  await step('tunnels page: empty state, relay settings, detail appears for a port tunnel', async () => {
    await page.click('.rail-link:has-text("Туннели")');
    await page.waitForSelector('.tlist');
    assert((await page.textContent('.tlist')).includes('Туннелей пока нет'));
    await page.fill('.sect input[placeholder="3000"]', '15999');
    await page.fill('.sect input[placeholder="Мой сайт"]', 'Сайт');
    await page.click('button:has-text("Открыть порт")');
    await page.waitForSelector('.trow:has-text("Сайт")');
    await page.waitForSelector('.tdetail h3:has-text("Сайт")');
    assert(await page.locator('.tdetail .dual').count() === 1, 'traffic chart');
    assert(await page.locator('.tdetail .tile').count() === 5, 'counters');
    await page.click('.trow:has-text("Сайт") .switch');
    await page.waitForSelector('.trow.off');
    await page.click('.trow:has-text("Сайт") .btn.danger');
    await page.waitForFunction(() => !document.querySelector('.tlist').textContent.includes('Сайт'));
    await shot('u7-tunnels');
  });

  // ---------- мощности ПК, гайд, каталоги ----------
  const capApi = () => page.evaluate(async () => {
    const r = await fetch('/api/capacity', { headers: { authorization: 'Bearer ' + localStorage.getItem('hearth.token') } });
    return r.json();
  });
  const opened = [];
  page.on('request', (r) => r.url().endsWith('/api/open-url') && opened.push(JSON.parse(r.postData() || '{}').url));

  await step('capacity: page opens from the rail with 3 presets and "no limits"', async () => {
    await page.click('.rail-link:has-text("Мощности")');
    await page.waitForSelector('.cap .presets');
    assert((await page.locator('.preset').count()) === 4, 'presets: ' + (await page.locator('.preset').count()));
    for (const p of ['25', '50', '100', 'off']) assert(await page.locator(`.preset[data-preset="${p}"]`).isVisible(), 'preset ' + p);
    assert(!/\bnull\b/.test(await page.textContent('.cap')), 'stray "null" text on the capacity page');
    await shot('u8-capacity');
  });
  await step('capacity: presets 25 / 50 / 100% apply the budget', async () => {
    const pc = (await capApi()).pc;
    for (const p of [25, 50, 100]) {
      await page.click(`.preset[data-preset="${p}"]`);
      await page.waitForSelector(`.preset[data-preset="${p}"].on`);
      const b = (await capApi()).budget;
      assert(b.enabled, 'enabled for ' + p);
      assert(b.cpuCores === Math.max(1, Math.round((pc.cores * p) / 100)), `cores for ${p}: ${b.cpuCores}`);
      assert(Math.abs(b.ramMb - pc.totalMb * p / 100) <= 256 || b.ramMb === pc.totalMb, `ram for ${p}: ${b.ramMb}`);
    }
    await page.click('.preset[data-preset="off"]');
    await page.waitForSelector('.cap-mode[data-mode="off"]');
    assert((await capApi()).budget.enabled === false);
  });
  await step('capacity: manual sliders edit the budget and the mode becomes manual', async () => {
    await page.$eval('#cap-ram', (el) => { el.value = '512'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForSelector('.cap-mode[data-mode="manual"]');
    const b = (await capApi()).budget;
    assert(b.enabled && b.ramMb === 512, JSON.stringify(b));
    assert(/512/.test(await page.textContent('.sl:has(#cap-ram) .sl-val')));
    await page.selectOption('.cap-extra select', 'low');
    await page.waitForFunction(() => document.querySelector('.cap-extra select').value === 'low');
    await page.check('.cap-extra input[type=checkbox]');
    await page.waitForFunction(() => document.querySelector('.cap-extra input[type=checkbox]').checked);
    const b2 = (await capApi()).budget;
    assert(b2.priority === 'low' && b2.hardRam === true, JSON.stringify(b2));
  });
  await step('capacity: per-server memory field, split automatically, live usage', async () => {
    await page.click('.preset[data-preset="50"]');
    await page.waitForSelector('.preset[data-preset="50"].on');
    assert((await page.locator('tr[data-server]').count()) >= 1, 'server rows');
    const input = page.locator('tr[data-server] .ram-in').first();
    await input.fill('3072');
    await input.press('Tab');
    await page.waitForFunction(() => document.querySelector('tr[data-server] .ram-in').value === '3072');
    const sv = (await capApi()).servers[0];
    assert(sv.ramMb === 3072, 'server ram ' + sv.ramMb);
    await page.click('[data-act="auto"]');
    await page.waitForSelector('.toast:has-text("распределён")');
    assert((await page.locator('.ring-card').count()) === 3, 'three ring gauges');
    assert(/из/.test(await page.textContent('.rings')), 'usage text');
    assert((await page.locator('.alloc-seg').count()) >= 1, 'allocation bar has segments');
    assert((await page.locator('tr[data-server] .lamp').count()) >= 1);
    await shot('u8-capacity-servers');
    await page.evaluate(() => window.scrollTo(0, 0));
  });
  await step('guide: opens from a button, walks all steps, action opens the catalog, Escape closes', async () => {
    await page.click('.cap [data-act="guide"]');
    await page.waitForSelector('.modal.guide');
    assert(/^1\./.test(await page.textContent('.guide-body h2')));
    for (let i = 0; i < 5; i++) {
      await page.click('[data-guide="next"]');
      assert(!/\bnull\b/.test(await page.textContent('.guide-body')), 'stray "null" in guide step ' + (i + 2));
    }
    assert(/^6\./.test(await page.textContent('.guide-body h2')));
    assert((await page.textContent('[data-guide="next"]')).trim() === 'Готово');
    await page.click('[data-guide="prev"]');
    assert(/^5\./.test(await page.textContent('.guide-body h2')));
    await page.click('.guide-dots .dot >> nth=0');
    await shot('u8-guide');
    await page.click('.guide-act');
    await page.waitForSelector('.modal-back.in .gcard');
    assert(await page.evaluate(() => localStorage.getItem('hearth.guide')) === 'done');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.modal-back'));
  });
  await step('catalogs: Minecraft has "Open Modrinth" and a Catalogs list (Hangar, Spigot)', async () => {
    await page.click('.srv >> nth=0');
    await page.waitForSelector('.tabs');
    await tab('Плагины');
    await page.waitForSelector('[data-mode="online"]');
    await page.click('[data-mode="online"]');
    await page.waitForSelector('[data-source="modrinth-open"]');
    await page.click('[data-source="modrinth-open"]');
    await page.waitForFunction(() => true);
    await wait(300);
    assert(opened.includes('https://modrinth.com/plugins'), 'opened: ' + opened.join(','));
    await page.click('[data-mode="catalogs"]');
    await page.waitForSelector('.src[data-source="hangar"]');
    assert((await page.locator('.src').count()) >= 3);
    assert(await page.locator('.src.primary[data-source="modrinth"]').isVisible());
    await shot('u8-catalogs');
  });
  await step('catalogs: a game without a plugin folder gets a Catalogs tab (Valheim → Thunderstore)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-uival-'));
    await page.evaluate(async (d) => {
      await fetch('/api/servers', { method: 'POST', headers: { authorization: 'Bearer ' + localStorage.getItem('hearth.token'), 'content-type': 'application/json' }, body: JSON.stringify({ game: 'valheim', name: 'Val', importDir: d }) });
    }, dir);
    await page.waitForSelector('.srv:has-text("Val")');
    await page.click('.srv:has-text("Val")');
    await page.waitForSelector('.tab[data-tab="catalogs"]');
    await page.click('.tab[data-tab="catalogs"]');
    await page.waitForSelector('.src[data-source="thunderstore"]');
    await page.click('.src[data-source="thunderstore"]');
    await wait(300);
    assert(opened.includes('https://thunderstore.io/c/valheim/'), 'opened: ' + opened.join(','));
  });
  await step('palette: "Мощности: отдать 25%" applies the preset, "Гайд" opens the guide', async () => {
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#palette.in');
    await page.fill('#palette input', 'отдать 25');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("25%")');
    const pc = (await capApi()).pc;
    assert((await capApi()).budget.cpuCores === Math.max(1, Math.round(pc.cores * 0.25)));
    await page.waitForFunction(() => !document.querySelector('#palette'));
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#palette.in');
    await page.fill('#palette input', 'гайд');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.modal.guide');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#guide'));
  });
  await step('network: page lists addresses with .hearth names, decoder round-trips, bad name shows an error', async () => {
    await page.click('.rail-link:has-text("Сеть")');
    await page.waitForSelector('.addr-card');
    assert(!/\bnull\b/.test(await page.textContent('.net')), 'stray "null" on the network page');
    const ip = await page.getAttribute('.addr-card.primary', 'data-ip');
    const fq = (await page.textContent('.addr-card.primary .ac-name .mono')).trim();
    assert(/^[a-z]+-[a-z]+\.hearth$/.test(fq), fq);
    await page.fill('.name-tool input', fq);
    await page.waitForSelector('[data-resolved]');
    assert((await page.getAttribute('[data-resolved]', 'data-resolved')) === ip);
    await page.fill('.name-tool input', 'xxxxxx-xxxxxx.hearth');
    await page.waitForSelector('.decoded .tone-bad');
    await shot('u9-network');
  });
  await step('network: server access check, firewall and hosts buttons answer', async () => {
    await page.waitForSelector('.net-srv [data-act=check]');
    await page.click('.net-srv [data-act=check]');
    await page.waitForSelector('.port[data-status]');
    assert(!/\[object/.test(await page.textContent('.net-srv')), 'port label rendered as [object Object]');
    await page.click('.net-srv [data-act=fw-open]');
    await page.click('.modal button:has-text("Продолжить")');
    await page.waitForSelector('.toast');
    await page.click('[data-act=hosts-add]');
    await page.click('.modal button:has-text("Продолжить")');
    await page.waitForSelector('.toast:has-text("вручную")');
  });
  await step('network: own name (.hearth for everyone), other zones only for the admin beta', async () => {
    await page.click('.rail-link:has-text("Сеть")');
    await page.waitForSelector('.net-srv [data-role=netname]');
    const first = page.locator('.net-srv').first();
    await first.locator('[data-role=netname]').fill('SoskaCraft');
    await first.locator('[data-act=name-save]').click();
    await page.waitForSelector('.toast:has-text("soskacraft.hearth")');
    await page.waitForSelector('.net-srv [data-act=name-hosts]');
    assert((await page.locator('.net-srv').first().locator('[data-role=netname]').inputValue()) === 'soskacraft.hearth');
    await page.uncheck('[data-role=beta-zone]');
    await page.waitForFunction(() => !document.querySelector('.badge.beta'));
    await page.locator('.net-srv').first().locator('[data-role=netname]').fill('soskacraft.mc');
    await page.locator('.net-srv').first().locator('[data-act=name-save]').click();
    await page.waitForSelector('.toast:has-text("администратор")');
    await page.check('[data-role=beta-zone]');
    await page.waitForSelector('.badge.beta');
    await page.locator('.net-srv').first().locator('[data-role=netname]').fill('soskacraft.mc');
    await page.locator('.net-srv').first().locator('[data-act=name-save]').click();
    await page.waitForSelector('.toast:has-text("soskacraft.mc")');
    await shot('u9-network-name');
  });
  await step('server page: "В вашей сети" row shows name:port', async () => {
    await page.click('.rail-link:has-text("Обзор")');
    await page.click('.srv-card .card-main');
    await page.waitForSelector('.invite.lan .addr');
    assert((await page.textContent('.invite.lan .addr')).trim() === 'soskacraft.mc:25565');
  });
  await step('no JavaScript errors in the page', async () => assert(errors.length === 0, errors.join(' | ')));
  await browser.close();
}

main()
  .catch((e) => {
    console.log('FATAL', e.stack || e.message);
    failed.push('fatal');
  })
  .finally(() => {
    agent.kill();
    mock.close();
    console.log(`\n${pass} passed, ${failed.length} failed. Screenshots: ${shots}`);
    if (failed.length) console.log('Failed:\n - ' + failed.join('\n - '));
    process.exit(failed.length ? 1 : 0);
  });
