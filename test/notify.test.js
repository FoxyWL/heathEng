'use strict';
// Уведомления: Discord, Telegram и вебхук; падение сервера через настоящий агент; пауза между повторами, диск, смена IP, связь с релеем.
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
let n = 0;
const ok = (m) => console.log('  ✓', m, `(${++n})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hits = [];
const hook = http.createServer((q, r) => {
  let b = '';
  q.on('data', (d) => (b += d));
  q.on('end', () => {
    if (q.url.startsWith('/fail')) return (r.statusCode = 500), r.end('no');
    hits.push({ url: q.url, body: JSON.parse(b || '{}') });
    r.end('{}');
  });
});
const base = () => `http://127.0.0.1:${hook.address().port}`;

(async () => {
  let agent;
  let fail = null;
  try {
    await new Promise((r) => hook.listen(0, '127.0.0.1', r));
    process.env.HEARTH_TELEGRAM_API = base() + '/tg';
    process.env.HEARTH_NOTIFY_RELAY_MS = '200';
    const { Notifier } = require('../agent/lib/notify');
    const mk = () => {
      const store = { config: {}, saveConfig() {} };
      return { n: new Notifier({ store, dataDir: os.tmpdir() }), store };
    };

    // --- проверка настроек ---
    let { n: nt } = mk();
    assert.throws(() => nt.set({ targets: [{ type: 'discord', url: 'ftp://x' }] }), /http/);
    assert.throws(() => nt.set({ targets: [{ type: 'telegram', secret: 't' }] }), /chat id/);
    assert.throws(() => nt.set({ targets: [{ type: 'icq', url: 'http://x' }] }), /тип/);
    ok('настройки: кривая ссылка, Telegram без chat id и неизвестный тип отклоняются');

    nt.set({ enabled: true, targets: [{ type: 'discord', url: base() + '/dc/secretsecret1234' }, { type: 'telegram', secret: '123:ABCtoken', chatId: '42' }, { type: 'webhook', url: base() + '/wh' }] });
    const view = JSON.stringify(nt.view());
    assert(!view.includes('secretsecret') && !view.includes('ABCtoken'), 'секреты не отдаются в панель');
    assert(nt.view().targets[0].hint === '1234');
    ok('ссылки и токены скрыты: панель видит только последние 4 символа');

    // --- рассылка и форматы ---
    hits.length = 0;
    assert.strictEqual(await nt.test(), 3);
    const dc = hits.find((h) => h.url.startsWith('/dc/'));
    const tg = hits.find((h) => h.url.startsWith('/tg/bot123:ABCtoken/sendMessage'));
    const wh = hits.find((h) => h.url === '/wh');
    assert(dc && /проверка/.test(dc.body.content) && tg && tg.body.chat_id === '42' && /проверка/.test(tg.body.text) && wh && wh.body.event === 'test' && wh.body.app === 'hearth');
    ok('пробное сообщение дошло в Discord, Telegram (бот и chat id) и вебхук JSON');

    // --- события ---
    hits.length = 0;
    nt.onServer({ id: 's1', name: 'Мир', state: 'running' });
    nt.onServer({ id: 's1', name: 'Мир', state: 'crashed', msg: 'Сервер упал' });
    await wait(150);
    assert(hits.length === 3 && /Мир.*упал/.test(hits[0].body.content || hits[0].body.text || hits[0].body.title), JSON.stringify(hits.map((h) => h.url)));
    nt.onServer({ id: 's1', name: 'Мир', state: 'crashed', msg: 'ещё раз' });
    nt.onServer({ id: 's1', name: 'Мир', state: 'stopped' });
    nt.onServer({ id: 's1', name: 'Мир', state: 'crashed', msg: 'снова' });
    await wait(150);
    assert.strictEqual(hits.length, 3, 'повтор в пределах минуты не шлётся');
    ok('падение сервера: одно сообщение на каждого получателя, повторы в пределах минуты не спамят');

    hits.length = 0;
    nt.onServer({ id: 's1', name: 'Мир', state: 'running' });
    await wait(150);
    assert(hits.length === 3 && /снова работает/.test(hits[0].body.content || hits[0].body.text || hits[0].body.title));
    ok('после падения сообщение «снова работает»');

    hits.length = 0;
    nt.onNet({ type: 'public-ip-changed', to: '198.51.100.9' });
    await wait(150);
    assert(hits.length === 3 && hits.some((h) => /198\.51\.100\.9/.test(JSON.stringify(h.body))));
    ok('смена публичного IP: сообщение с новым адресом');

    hits.length = 0;
    nt.onRelay('reconnecting', true);
    await wait(120);
    assert.strictEqual(hits.length, 0, 'короткий обрыв не тревожит');
    nt.onRelay('online', true);
    await wait(300);
    assert.strictEqual(hits.length, 0, 'восстановились раньше срока: молчим');
    nt.onRelay('reconnecting', true);
    await wait(450);
    assert(hits.length === 3 && /Нет связи с релеем/.test(JSON.stringify(hits[0].body)));
    hits.length = 0;
    nt.onRelay('online', true);
    await wait(150);
    assert(hits.length === 3 && /восстановлена/.test(JSON.stringify(hits[0].body)));
    ok('релей: короткий обрыв молчит, долгий — тревога, потом «восстановлена»');

    hits.length = 0;
    nt.set({ diskGb: 9999999 });
    nt.checkDisk();
    nt.checkDisk();
    await wait(150);
    assert.strictEqual(hits.length, 3, 'диск: одно сообщение, пока не восстановится');
    ok('мало места на диске: одно сообщение, а не поток');

    hits.length = 0;
    nt.onUpdate({ available: { version: '9.9.9', skipped: false } });
    nt.onUpdate({ available: { version: '9.9.9', skipped: false } });
    await wait(150);
    assert.strictEqual(hits.length, 3);
    ok('о новой версии — один раз');

    hits.length = 0;
    nt.set({ events: { crash: false } });
    nt.onServer({ id: 's2', name: 'Тихий', state: 'crashed' });
    nt.set({ enabled: false });
    nt.onNet({ type: 'public-ip-changed', to: '1.1.1.1' });
    await wait(150);
    assert.strictEqual(hits.length, 0);
    ok('выключенный тип события и выключенные уведомления молчат');

    ({ n: nt } = mk());
    nt.set({ enabled: true, targets: [{ type: 'webhook', url: base() + '/fail' }] });
    await assert.rejects(() => nt.test(), /HTTP 500/);
    ok('ошибка получателя в пробной отправке показывается, а не глотается');

    // --- через настоящий агент: падение процесса сервера ---
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-nt-'));
    let out = '';
    agent = spawn('node', [path.join(root, 'main.js')], { env: { ...process.env, DATA_DIR: data, PORT: '17820', NO_BROWSER: '1', HEARTH_NO_OPEN: '1', HEARTH_RELAY_AUTO: '0', HEARTH_NETWATCH_MS: '60000' }, stdio: ['ignore', 'pipe', 'inherit'] });
    agent.stdout.on('data', (d) => (out += d));
    for (let i = 0; i < 80 && !/token=/.test(out); i++) await wait(100);
    const token = /token=([0-9a-f]+)/.exec(out)[1];
    const api = async (m, u, body) => {
      const r = await fetch('http://127.0.0.1:17820' + u, { method: m, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { s: r.status, j: await r.json().catch(() => ({})) };
    };
    assert.strictEqual((await api('POST', '/api/notify/test')).s, 409);
    const put = await api('PUT', '/api/notify', { enabled: true, targets: [{ type: 'webhook', url: base() + '/hook2-longname' }] });
    assert(put.s === 200 && put.j.targets.length === 1 && !JSON.stringify(put.j).includes('/hook2-longname'));
    ok('агент: без получателей проба отклоняется, ссылка не возвращается');
    hits.length = 0;
    const sv = (await api('POST', '/api/servers', { game: 'custom', name: 'Падучий', settings: { command: 'node -e "setTimeout(()=>process.exit(3),400)"', port: 15830, protocol: 'tcp' } })).j;
    await api('POST', `/api/servers/${sv.id}/start`);
    for (let i = 0; i < 40 && !hits.length; i++) await wait(150);
    assert(hits.length === 1 && hits[0].url === '/hook2-longname' && hits[0].body.event === 'crash' && hits[0].body.server === 'Падучий', JSON.stringify(hits));
    ok('агент: процесс сервера упал — вебхук получил событие crash с именем сервера');
  } catch (e) {
    fail = e;
  }
  try { agent && agent.kill(); } catch {}
  hook.close();
  if (fail) {
    console.error('FAIL', fail.stack || fail);
    process.exit(1);
  }
  console.log(`\nnotify: ${n} проверок пройдено`);
  process.exit(0);
})();
