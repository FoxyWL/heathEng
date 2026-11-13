'use strict';
// Walks through every button and control of the UI in a real browser.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const shots = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-shots-'));
fs.mkdirSync(shots, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-btn-'));
const mcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-mc-'));
const base = 'http://127.0.0.1:17020';
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
    try {
      await page.screenshot({ path: path.join(shots, 'FAIL-' + failed.length + '.png') });
    } catch {}
  }
}
const assert = (c, msg) => {
  if (!c) throw new Error(msg || 'assertion failed');
};

const mock = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'Это тестовый ответ ИИ-помощника' }] }));
  });
});

const relay = spawn('node', [path.join(root, 'relay/relay.js')], {
  env: { ...process.env, RELAY_TOKEN: 'rt', CONTROL_PORT: '17021', HTTP_PORT: '18021', RELAY_DOMAIN: 'tun.test', PUBLIC_HOST: '127.0.0.1', PORT_MIN: '36000', PORT_MAX: '36100', BIND: '127.0.0.1' },
  stdio: 'ignore',
});
const agent = spawn('node', [path.join(root, 'main.js')], {
  env: { ...process.env, DATA_DIR: data, PORT: '17020', NO_BROWSER: '1', HEARTH_NO_OPEN: '1', ANTHROPIC_API_URL: 'http://127.0.0.1:17031', PATH: path.join(__dirname, 'fakebin') + path.delimiter + process.env.PATH },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let out = '';
agent.stdout.on('data', (d) => (out += d));
let agentExited = false;
agent.on('exit', () => (agentExited = true));

let page;
const nativeDialogs = [];
const jsErrors = [];

/* ---------- helpers ---------- */
const dlg = () => page.locator('.modal-back.in .modal');
async function dialogOpen(title) {
  await page.waitForSelector('.modal-back.in .modal', { timeout: 4000 });
  if (title) assert((await dlg().locator('h2').textContent()).includes(title), 'dialog title was: ' + (await dlg().locator('h2').textContent()));
}
async function dialogClosed() {
  await page.waitForFunction(() => !document.querySelector('.modal-back'), null, { timeout: 4000 });
}
const answer = (label) => dlg().locator('.row .btn', { hasText: label }).first().click();
async function toastHas(text, bad) {
  await page.waitForFunction(([t, b]) => [...document.querySelectorAll('.toast')].some((e) => e.textContent.includes(t) && (!b || e.classList.contains('bad'))), [text, !!bad], { timeout: 6000 });
}
const tab = (name) => page.click(`.tab:has-text("${name}")`);
const badge = () => page.locator('.badge').first().textContent();
async function stateIs(text, ms = 9000) {
  await page.waitForFunction((t) => document.querySelector('.badge') && document.querySelector('.badge').textContent === t, text, { timeout: ms });
}
const headerBtn = (label) => page.locator('.head .actions .btn', { hasText: label }).first();
const shot = (n) => page.screenshot({ path: path.join(shots, n + '.png') });

async function main() {
  await new Promise((r) => mock.listen(17031, '127.0.0.1', r));
  for (let i = 0; i < 60 && !/token=/.test(out); i++) await wait(100);
  const token = /token=([0-9a-f]+)/.exec(out)[1];
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 880 }, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on('dialog', (d) => {
    nativeDialogs.push(d.type() + ': ' + d.message());
    d.dismiss();
  });
  page.on('pageerror', (e) => jsErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text()) && jsErrors.push('console: ' + m.text()));

  await page.goto(`${base}/#token=${token}`);
  await page.waitForSelector('.welcome');

  /* ===== welcome + new-server dialog ===== */
  await step('welcome shows 3 steps and animates in', async () => {
    assert((await page.locator('.step').count()) === 3);
    assert((await page.locator('.page.enter').count()) === 1, 'page enter animation class missing');
    const name = await page.$eval('.page.enter', (e) => getComputedStyle(e).animationName);
    assert(name === 'enter', 'animation: ' + name);
  });
  await shot('01-welcome');
  await step('button: "Создать сервер" opens dialog, Esc closes it', async () => {
    await page.click('.welcome .btn.primary');
    await dialogOpen('Новый сервер');
    await page.keyboard.press('Escape');
    await dialogClosed();
  });
  await step('button: rail "Новый сервер" opens dialog, "Отмена" closes it', async () => {
    await page.click('.rail-foot .btn.on-dark');
    await dialogOpen('Новый сервер');
    await answer('Отмена');
    await dialogClosed();
  });
  await step('dialog closes by click on backdrop', async () => {
    await page.click('.rail-foot .btn.on-dark');
    await dialogOpen();
    await page.mouse.click(8, 8);
    await dialogClosed();
  });
  await step('game radios switch the form (Vanilla / Paper / custom)', async () => {
    await page.click('.rail-foot .btn.on-dark');
    await dialogOpen();
    assert((await page.locator('.gcard').count()) >= 20, 'catalog has many games');
    await page.click('.gcard[data-game="minecraft-paper"]');
    assert(await page.locator('.modal .check:has-text("EULA")').isVisible(), 'EULA visible for Paper');
    await page.click('.gcard[data-game="custom"]');
    assert(await page.locator('.modal input[data-key="command"]').isVisible(), 'command field for custom');
    assert(!(await page.locator('.modal .check:has-text("EULA")').isVisible()), 'EULA hidden for custom');
    await page.click('.gcard[data-game="minecraft-vanilla"]');
    await page.check('.modal .check:has-text("уже есть") input');
    assert(await page.locator('.modal input.mono[placeholder*="Games"]').isVisible(), 'folder field after import checkbox');
    await shot('02-modal');
  });
  await step('import without folder shows an error', async () => {
    await page.locator('.modal .row .btn.primary').click();
    await page.waitForSelector('.modal .notice.bad:not(.hidden)');
  });

  /* ===== import a Minecraft server (fake java) ===== */
  await step('create: attach an existing Minecraft folder', async () => {
    await page.fill('.modal input.mono[placeholder*="Games"]', mcDir);
    await page.fill('.modal input[placeholder="Мой сервер"]', 'Мир друзей');
    await page.locator('.modal .row .btn.primary').click();
    await page.waitForSelector('.head h1:has-text("Мир друзей")');
    await stateIs('Остановлен');
    assert((await page.locator('.console-wrap .chip').count()) === 6, 'quick command chips');
    assert(await page.locator('.console-wrap .chip').first().isDisabled(), 'chips disabled while stopped');
  });
  await step('button: Start asks to accept EULA; "Отмена" keeps it stopped', async () => {
    await headerBtn('Запустить').click();
    await dialogOpen('Лицензия Minecraft');
    await answer('Отмена');
    await dialogClosed();
    assert((await badge()) === 'Остановлен');
  });
  await step('button: "Принять и запустить" starts the server', async () => {
    await headerBtn('Запустить').click();
    await dialogOpen('Лицензия Minecraft');
    await answer('Принять и запустить');
    await stateIs('Работает');
    assert(fs.readFileSync(path.join(mcDir, 'eula.txt'), 'utf8').includes('eula=true'), 'eula.txt written');
  });
  await step('header shows players and RAM; chips become enabled', async () => {
    await page.waitForFunction(() => /Игроки\s*1 \/ 10/.test(document.querySelector('.page').textContent), null, { timeout: 6000 });
    await page.waitForFunction(() => /RAM\s*\d/.test(document.querySelector('.page').textContent), null, { timeout: 9000 });
    assert(await page.locator('.chip').first().isEnabled());
  });
  await shot('03-minecraft');
  await step('chip: "Игроки онлайн"', async () => {
    await page.click('.chip:has-text("Игроки онлайн")');
    await page.waitForSelector('.ln:has-text("There are 1 of a max of 20 players online: Steve")');
  });
  await step('chip: "Сохранить мир"', async () => {
    await page.click('.chip:has-text("Сохранить мир")');
    await page.waitForSelector('.ln:has-text("Saved the game")');
  });
  await step('chip: "Сообщение всем…" (dialog + Enter)', async () => {
    await page.click('.chip:has-text("Сообщение всем")');
    await dialogOpen('Сообщение всем');
    assert(await dlg().locator('.row .btn.primary').isDisabled(), 'OK disabled while empty');
    await dlg().locator('input').fill('привет всем');
    await page.keyboard.press('Enter');
    await dialogClosed();
    await page.waitForSelector('.ln:has-text("[Server] привет всем")');
  });
  await step('chips: whitelist / operator dialogs send commands, Cancel sends nothing', async () => {
    await page.click('.chip:has-text("В белый список")');
    await dialogOpen();
    await dlg().locator('input').fill('Alex');
    await answer('Отправить');
    await page.waitForSelector('.ln:has-text("Executed: whitelist add Alex")');
    await page.click('.chip:has-text("Сделать оператором")');
    await dialogOpen();
    await dlg().locator('input').fill('Alex');
    await answer('Отмена');
    await dialogClosed();
    await wait(300);
    assert((await page.locator('.ln:has-text("op Alex")').count()) === 0, 'cancel must not send');
  });
  await step('chip: "Выгнать игрока…" updates the players counter', async () => {
    await page.click('.chip:has-text("Выгнать игрока")');
    await dialogOpen();
    await dlg().locator('input').fill('Steve');
    await answer('Отправить');
    await page.waitForFunction(() => /Игроки\s*0 \/ 10/.test(document.querySelector('.page').textContent), null, { timeout: 5000 });
  });
  await step('button: Stop (graceful, uses "stop" command)', async () => {
    await headerBtn('Остановить').click();
    await stateIs('Остановлен');
  });
  await step('rail lamp is not left in a stale "stopping" state after Stop', async () => {
    await wait(700);
    assert((await page.locator('.srv:has-text("Мир друзей") .lamp.stopped').count()) === 1, 'lamp: ' + (await page.getAttribute('.srv:has-text("Мир друзей") .lamp', 'class')));
    assert(!(await page.locator('.srv:has-text("Мир друзей")').textContent()).includes('👤'), 'stale players counter');
  });
  await step('header and invite never print a stray "null"', async () => {
    const txt = await page.evaluate(() => document.querySelector('.page').innerText);
    assert(!/(^|\n)null(\n|$)/.test(txt), 'found literal null');
  });

  /* ===== custom server ===== */
  await step('create: custom server with its own command', async () => {
    await page.click('.rail-foot .btn.on-dark');
    await dialogOpen();
    await page.click('.gcard[data-game="custom"]');
    await page.fill('.modal input[data-key="command"]', `node ${path.join(root, 'test/fake-game.js')} 15556`);
    await page.fill('.modal input[data-key="port"]', '15556');
    await page.fill('.modal input[placeholder="Мой сервер"]', 'Свой сервер');
    await page.locator('.modal .row .btn.primary').click();
    await page.waitForSelector('.head h1:has-text("Свой сервер")');
    await dialogClosed();
  });
  await step('button: Start -> Работает, RAM pill appears', async () => {
    await headerBtn('Запустить').click();
    await stateIs('Работает');
    await page.waitForFunction(() => /RAM\s*\d/.test(document.querySelector('.page').textContent), null, { timeout: 9000 });
  });
  await step('button: "Папка" opens the folder', async () => {
    await headerBtn('Папка').click();
    await toastHas('Папка открыта');
  });

  /* ===== console tab ===== */
  await step('console: red error line, sending commands, history with arrows', async () => {
    await page.waitForSelector('.ln.err');
    await page.fill('.cmd input', 'hello');
    await page.click('.cmd .btn.primary');
    await page.waitForSelector('.ln:has-text("echo hello")');
    await page.fill('.cmd input', 'second');
    await page.press('.cmd input', 'Enter');
    await page.waitForSelector('.ln:has-text("echo second")');
    await page.press('.cmd input', 'ArrowUp');
    assert((await page.inputValue('.cmd input')) === 'second');
    await page.press('.cmd input', 'ArrowUp');
    assert((await page.inputValue('.cmd input')) === 'hello');
    await page.fill('.cmd input', '');
  });
  await step('console: search marks matches, "только проблемы" filters', async () => {
    await page.fill('.console-bar input[type=search]', 'hello');
    await page.waitForSelector('.log mark');
    await page.fill('.console-bar input[type=search]', '');
    await page.check('.console-bar input[type=checkbox]');
    await wait(200);
    assert((await page.locator('.log .ln:not(.err):not(.warn)').count()) === 0);
    await page.uncheck('.console-bar input[type=checkbox]');
  });
  await step('console: "Копировать" gives feedback', async () => {
    await page.click('.console-bar .btn:has-text("Копировать")');
    await page.waitForSelector('.console-bar .btn.ok');
  });
  await step('console: "Сохранить" downloads the log', async () => {
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('.console-bar .btn:has-text("Сохранить")')]);
    assert(/log\.txt$/.test(d.suggestedFilename()), d.suggestedFilename());
  });
  await step('console: "Очистить" empties the log', async () => {
    await page.click('.console-bar .btn:has-text("Очистить")');
    await page.waitForSelector('.log .ln.sys:has-text("Журнал пуст")');
  });
  await shot('04-console');

  /* ===== settings tab + header buttons ===== */
  await step('settings: stop command + rename + toggles, Save', async () => {
    await tab('Запуск');
    await page.waitForSelector('.form');
    await page.fill('.field:has-text("Команда остановки") input', 'stop');
    await page.click('.savebar .btn.primary');
    await toastHas('Сохранено');
    await tab('Настройки');
    await page.waitForSelector('.form');
    await page.fill('.field:has-text("Название") input >> nth=0', 'Свой сервер 2');
    await page.check('.sect:has-text("Работа сервера") label:has-text("Запускать вместе") input');
    await page.click('.savebar .btn.primary');
    await page.waitForFunction(() => [...document.querySelectorAll('.srv b')].some((b) => b.textContent === 'Свой сервер 2'), null, { timeout: 5000 });
    assert((await page.locator('.srv b', { hasText: 'Свой сервер 2' }).count()) === 1, 'rail renamed');
  });
  await step('settings: restart notice + "Перезапустить сейчас"', async () => {
    assert(await page.locator('.notice:has-text("после перезапуска")').isVisible());
    await page.click('.notice .btn');
    await page.waitForFunction(() => document.querySelector('.badge').textContent !== 'Работает', null, { timeout: 5000 }).catch(() => {});
    await stateIs('Работает', 15000);
    assert(!(await page.locator('.notice:has-text("после перезапуска")').isVisible()), 'notice hidden after restart');
  });
  await step('button: Restart (header)', async () => {
    await headerBtn('Перезапустить').click();
    await wait(400);
    await stateIs('Работает', 15000);
  });
  await step('button: Force kill — Cancel keeps running, confirm kills', async () => {
    await headerBtn('Принудительно').click();
    await dialogOpen('Завершить принудительно');
    await answer('Отмена');
    await dialogClosed();
    assert((await badge()) === 'Работает');
    await headerBtn('Принудительно').click();
    await dialogOpen();
    await answer('Завершить');
    await stateIs('Остановлен', 8000);
  });
  await step('button: Start again after kill, then Stop', async () => {
    await headerBtn('Запустить').click();
    await stateIs('Работает');
    await headerBtn('Остановить').click();
    await stateIs('Остановлен');
  });

  /* ===== files tab ===== */
  await step('files: new file via dialog, edit, Ctrl+S', async () => {
    await tab('Файлы');
    await page.waitForSelector('.flist');
    await page.click('.toolbar .btn:has-text("Файл")');
    await dialogOpen('Новый файл');
    await dlg().locator('input').fill('a.json');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.editor-bar b:has-text("a.json")');
    await page.fill('.code textarea', '{\n  "k": "v",\n  "n": 1\n}');
    await page.waitForSelector('.code pre .tk-p');
    await page.keyboard.press('Control+s');
    await toastHas('Файл сохранён');
  });
  await step('files: "Сохранить" button in the editor', async () => {
    await page.fill('.code textarea', '{ "k": 2 }');
    await page.click('.editor-bar .btn.primary');
    await toastHas('Файл сохранён');
  });
  await step('files: unsaved-changes dialog (cancel, then open anyway)', async () => {
    await page.click('.toolbar .btn:has-text("Файл")');
    await dialogOpen();
    await dlg().locator('input').fill('b.txt');
    await answer('Создать');
    await page.waitForSelector('.editor-bar b:has-text("b.txt")');
    await page.fill('.code textarea', 'draft');
    await page.click('.frow:has-text("a.json")');
    await dialogOpen('Несохранённые');
    await answer('Отмена');
    await dialogClosed();
    assert((await page.textContent('.editor-bar b')) === 'b.txt');
    await page.click('.frow:has-text("a.json")');
    await dialogOpen();
    await answer('Открыть без сохранения');
    await page.waitForSelector('.editor-bar b:has-text("a.json")');
  });
  await step('files: new folder, enter it, breadcrumb back', async () => {
    await page.click('.toolbar .btn:has-text("Папка")');
    await dialogOpen('Новая папка');
    await dlg().locator('input').fill('mods');
    await answer('Создать');
    await page.waitForSelector('.frow:has-text("mods")');
    await page.click('.frow:has-text("mods")');
    await page.waitForSelector('.crumbs button:has-text("mods")');
    assert(await page.locator('.flist:has-text("Папка пуста")').isVisible());
    await page.click('.crumbs button:has-text("/")');
    await page.waitForSelector('.frow:has-text("a.json")');
  });
  await step('files: rename (dialog)', async () => {
    await page.locator('.frow:has-text("b.txt") button[title="Переименовать"]').click();
    await dialogOpen('Переименовать');
    await dlg().locator('input').fill('c.txt');
    await answer('Переименовать');
    await page.waitForSelector('.frow:has-text("c.txt")');
    assert((await page.locator('.frow:has-text("b.txt")').count()) === 0);
  });
  await step('files: upload', async () => {
    await page.setInputFiles('.toolbar input[type=file]', { name: 'up.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded text') });
    await page.waitForSelector('.frow:has-text("up.txt")');
  });
  await step('files: download from the editor', async () => {
    await page.click('.frow:has-text("up.txt")');
    await page.waitForSelector('.editor-bar b:has-text("up.txt")');
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('.editor-bar .btn:has-text("Скачать")')]);
    assert(d.suggestedFilename() === 'up.txt');
  });
  await step('files: delete — Cancel keeps, confirm removes', async () => {
    await page.locator('.frow:has-text("up.txt") button[title="Удалить"]').click();
    await dialogOpen('Удалить');
    await answer('Отмена');
    await dialogClosed();
    assert((await page.locator('.frow:has-text("up.txt")').count()) === 1);
    await page.locator('.frow:has-text("up.txt") button[title="Удалить"]').click();
    await dialogOpen();
    await answer('Удалить');
    await page.waitForFunction(() => ![...document.querySelectorAll('.frow')].some((e) => e.textContent.includes('up.txt')));
  });
  await shot('05-files');

  /* ===== schedule tab ===== */
  await step('schedule: preset fills cron, "Добавить задачу"', async () => {
    await tab('Расписание');
    await page.waitForSelector('button:has-text("Добавить задачу")');
    await page.selectOption('select[aria-label="Шаблон расписания"]', '0 */6 * * *');
    assert((await page.inputValue('label:has-text("Cron") input')) === '0 */6 * * *');
    await page.fill('input[placeholder="Ночной бэкап"]', 'Бэкап каждые 6 ч');
    await page.click('button:has-text("Добавить задачу")');
    await page.waitForSelector('table.t td b:has-text("Бэкап каждые 6 ч")');
    await toastHas('Задача добавлена');
  });
  await step('schedule: invalid cron is rejected with a message', async () => {
    await page.fill('label:has-text("Cron") input', 'abc');
    await page.click('button:has-text("Добавить задачу")');
    await toastHas('cron', true);
  });
  await step('schedule: enable toggle, "Выполнить"', async () => {
    const cb = page.locator('table.t tbody tr').first().locator('input[type=checkbox]');
    await cb.uncheck();
    await page.waitForFunction(() => document.querySelector('table.t tbody tr td:nth-child(4)').textContent.trim() === '—');
    await page.locator('table.t tbody tr').first().locator('input[type=checkbox]').check();
    await page.locator('table.t tbody tr').first().locator('.btn:has-text("Выполнить")').click();
    await toastHas('Задача выполнена');
    await page.waitForSelector('table.t td:has-text("ok:")');
  });
  await step('schedule: "Сделать бэкап сейчас" + download', async () => {
    await page.click('button:has-text("Сделать бэкап сейчас")');
    await toastHas('Бэкап создан');
    const rows = page.locator('table.t').nth(1).locator('tbody tr');
    assert((await rows.count()) >= 1);
    const [d] = await Promise.all([page.waitForEvent('download'), rows.first().locator('.btn:has-text("Скачать")').click()]);
    assert(/\.tar\.gz$/.test(d.suggestedFilename()));
  });
  await step('schedule: restore — Cancel, then confirm restores', async () => {
    const row = () => page.locator('table.t').nth(1).locator('tbody tr').first();
    await row().locator('.btn:has-text("Восстановить")').click();
    await dialogOpen('Восстановить');
    await answer('Отмена');
    await dialogClosed();
    await row().locator('.btn:has-text("Восстановить")').click();
    await dialogOpen();
    await answer('Восстановить');
    await toastHas('Восстановлено');
  });
  await step('schedule: restore is refused while the server runs', async () => {
    await headerBtn('Запустить').click();
    await stateIs('Работает');
    await page.locator('table.t').nth(1).locator('tbody tr').first().locator('.btn:has-text("Восстановить")').click();
    await dialogOpen();
    await answer('Восстановить');
    await toastHas('остановите сервер', true);
    await headerBtn('Остановить').click();
    await stateIs('Остановлен');
  });
  await step('schedule: delete backups (Cancel, then confirm) and the task', async () => {
    const delB = () => page.locator('table.t').nth(1).locator('tbody tr').first().locator('.btn.danger');
    await delB().click();
    await dialogOpen('Удалить бэкап');
    await answer('Отмена');
    await dialogClosed();
    for (let i = 0; i < 5 && (await page.locator('p:has-text("Бэкапов пока нет")').count()) === 0; i++) {
      await delB().click();
      await dialogOpen();
      await answer('Удалить');
      await dialogClosed();
      await wait(250);
    }
    await page.waitForSelector('p:has-text("Бэкапов пока нет")');
    await page.locator('table.t').first().locator('tbody tr').first().locator('.btn.danger').click();
    await dialogOpen('Удалить задачу');
    await answer('Удалить');
    await page.waitForSelector('p:has-text("Задач пока нет")');
  });
  await shot('06-schedule');

  /* ===== tunnels ===== */
  await step('invite: "Настроить туннель" jumps to Tunnels', async () => {
    await page.click('.srv:has-text("Свой сервер 2")');
    await page.click('.invite .btn.flame');
    await page.waitForSelector('.page h1:has-text("Туннели")');
  });
  await step('tunnels: "Сохранить и подключиться" -> connected', async () => {
    await page.click('details:has-text("Ввести адрес вручную") summary');
    await page.fill('input[placeholder="relay.example.com"]', '127.0.0.1');
    await page.fill('input[type=number] >> nth=0', '17021');
    await page.fill('input[type=password]', 'rt');
    await page.check('.form .check input');
    await page.click('.savebar .btn.primary');
    await page.waitForFunction(() => /подключено/.test(document.querySelector('.meta').textContent), null, { timeout: 15000 });
  });
  await step('tunnels: help block opens and copies the relay command', async () => {
    await page.click('details.help:has-text("нет релея") summary');
    assert(await page.locator('details.help .codeblock').isVisible());
    await page.click('details.help .codeblock .btn');
    await page.waitForSelector('details.help .codeblock .btn.ok');
  });
  await step('invite: "Получить адрес" -> address, Copy, "Выключить"', async () => {
    await page.click('.srv:has-text("Свой сервер 2")');
    await page.click('.invite .btn.flame');
    await page.waitForSelector('.invite .addr:not(.dim)', { timeout: 7000 });
    assert(/127\.0\.0\.1:\d+/.test(await page.textContent('.invite .addr')));
    assert((await page.locator('.invite.fresh').count()) === 1, 'glow class on new address');
    await page.click('.invite .btn:has-text("Скопировать")');
    await page.waitForSelector('.invite .btn.ok');
    await shot('07-invite');
    await page.click('.invite .btn:has-text("Выключить")');
    await page.waitForSelector('.invite .btn.flame:has-text("Получить адрес")');
  });
  await step('tunnels: expose a port, copy, delete (✕)', async () => {
    await page.click('.rail-link:has-text("Туннели")');
    await page.fill('.sect input[placeholder="3000"]', '15556');
    await page.fill('.sect input[placeholder="Мой сайт"]', 'Тест');
    await page.click('button:has-text("Открыть порт")');
    await page.waitForSelector('.trow:has-text("Тест")');
    await page.waitForFunction(() => /127\.0\.0\.1:\d+/.test(document.querySelector('.tlist .trow:has(b)').parentElement.textContent), null, { timeout: 6000 });
    await page.click('.trow:has-text("Тест") .trow-main');
    await page.waitForSelector('.tdetail h3:has-text("Тест")');
    await page.locator('.tdetail .btn:has-text("Копировать")').click();
    await page.waitForSelector('.tdetail .btn.ok');
    await shot('08-tunnels');
    await page.locator('.trow:has-text("Тест") .btn.danger').click();
    await page.waitForFunction(() => !document.querySelector('.tlist').textContent.includes('Тест'));
  });

  /* ===== app settings ===== */
  await step('settings: language switch ru -> en -> ru', async () => {
    await page.click('.rail-link:has-text("Настройки")');
    await page.selectOption('select[aria-label="Язык"]', 'en');
    await page.waitForSelector('h1:has-text("Settings")');
    assert((await page.locator('.rail-foot .btn.on-dark').textContent()).includes('New server'));
    await page.selectOption('select[aria-label="Language"]', 'ru');
    await page.waitForSelector('h1:has-text("Настройки")');
  });
  await step('settings: theme dark / light / auto', async () => {
    await page.selectOption('select[aria-label="Тема"]', 'dark');
    assert((await page.getAttribute('html', 'data-theme')) === 'dark');
    const bg = await page.$eval('body', (e) => getComputedStyle(e).backgroundColor);
    assert(bg === 'rgb(15, 28, 31)', 'dark bg ' + bg);
    await shot('09-dark');
    await page.selectOption('select[aria-label="Тема"]', 'light');
    assert((await page.getAttribute('html', 'data-theme')) === 'light');
    await page.selectOption('select[aria-label="Тема"]', 'auto');
    assert((await page.getAttribute('html', 'data-theme')) === null);
  });
  await step('settings: AI assistant — enable + key -> console button -> answer', async () => {
    await page.check('.sect:has-text("ИИ-помощник") .check input');
    await page.fill('input[placeholder="sk-ant-…"]', 'sk-test');
    await page.click('.sect:has-text("ИИ-помощник") .btn.primary');
    await toastHas('Сохранено');
    await page.click('.srv:has-text("Свой сервер 2")');
    await tab('Консоль');
    await page.click('.console-bar .btn:has-text("Объяснить ошибки")');
    await page.waitForSelector('.ai-box:has-text("тестовый ответ")');
  });

  /* ===== remove servers ===== */
  await step('remove imported server: Cancel, then confirm keeps its folder', async () => {
    await page.click('.srv:has-text("Мир друзей")');
    await tab('Настройки');
    await page.click('.btn.danger:has-text("Удалить сервер")');
    await dialogOpen('Убрать сервер');
    await answer('Отмена');
    await dialogClosed();
    await page.click('.btn.danger:has-text("Удалить сервер")');
    await dialogOpen();
    await answer('Убрать из Hearth');
    await toastHas('Сервер удалён');
    assert(fs.existsSync(mcDir), 'imported folder must stay');
  });
  await step('remove custom server: 3-button dialog, "Удалить с файлами"', async () => {
    await page.click('.srv:has-text("Свой сервер 2")');
    await tab('Настройки');
    await page.click('.btn.danger:has-text("Удалить сервер")');
    await dialogOpen('Удалить');
    assert((await dlg().locator('.row .btn').count()) === 3);
    await answer('Отмена');
    await dialogClosed();
    await page.click('.btn.danger:has-text("Удалить сервер")');
    await dialogOpen();
    await answer('Удалить с файлами');
    await page.waitForSelector('.welcome');
    assert((await fs.readdirSync(path.join(data, 'servers'))).length === 0, 'server dir removed');
  });

  /* ===== quit ===== */
  await step('responsive: no horizontal overflow at phone width', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await wait(200);
    assert(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)));
    await page.setViewportSize({ width: 1360, height: 880 });
  });
  await step('reduced motion: dialogs still work', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.click('.rail-foot .btn.on-dark');
    await dialogOpen('Новый сервер');
    await page.keyboard.press('Escape');
    await dialogClosed();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });
  await step('quit: "Выйти из Hearth" — Cancel keeps, confirm stops the agent', async () => {
    await page.click('.rail-foot .btn.quiet >> nth=1');
    await dialogOpen('Выйти');
    await answer('Отмена');
    await dialogClosed();
    assert(!agentExited);
    await page.click('.rail-foot .btn.quiet >> nth=1');
    await dialogOpen();
    await answer('Выйти');
    await page.waitForSelector('.goodbye');
    for (let i = 0; i < 40 && !agentExited; i++) await wait(150);
    assert(agentExited, 'agent still running');
  });

  await step('no native confirm/prompt/alert were used', async () => assert(nativeDialogs.length === 0, nativeDialogs.join(' | ')));
  await step('no JavaScript errors in the page', async () => assert(jsErrors.length === 0, jsErrors.join(' | ')));

  await browser.close();
  relay.kill();
  mock.close();
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(mcDir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${failed.length} failed. Screenshots: ${shots}`);
  if (failed.length) console.log('Failed:\n - ' + failed.join('\n - '));
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => {
  console.error('FATAL', e);
  agent.kill();
  relay.kill();
  process.exit(1);
});
