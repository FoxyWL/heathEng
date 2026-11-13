'use strict';
// Автоопределение релея: поиск, подключение по найденному и по ссылке, открытый релей подключается сам, переезд релея.
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let n = 0;
const ok = (m) => console.log('  ✓', m, `(${++n})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.join(__dirname, '..');
const procs = [];
const kill = () => procs.forEach((p) => p.kill());
process.on('exit', kill);

const relay = (env) => {
  const p = spawn('node', [path.join(root, 'relay/relay.js')], { env: { ...process.env, PUBLIC_HOST: '127.0.0.1', PORT_MIN: '30100', PORT_MAX: '30199', ...env }, stdio: 'ignore' });
  procs.push(p);
  return p;
};
async function agent(port, env = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-rd-'));
  const p = spawn('node', [path.join(root, 'main.js')], { env: { ...process.env, DATA_DIR: data, PORT: String(port), NO_BROWSER: '1', HEARTH_NO_OPEN: '1', HEARTH_DISCOVERY_PORT: '17301', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  procs.push(p);
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 80 && !/token=/.test(out); i++) await wait(100);
  const token = /token=([0-9a-f]+)/.exec(out)[1];
  const api = async (m, u, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${u}`, { method: m, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
  return { api, p, data };
}
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('таймаут: ' + what);
    await wait(150);
  }
};

(async () => {
  try {
    // 1. релей с токеном, агент без настроек
    relay({ RELAY_TOKEN: 'secret', CONTROL_PORT: '17302', HTTP_PORT: '17303', DISCOVERY_PORT: '17301', RELAY_DOMAIN: 'moveme.test' });
    await wait(700);
    const A = await agent(17310, { HEARTH_RELAY_AUTO: '0', HEARTH_RELAY_RECHECK_MS: '300' });
    const d = (await A.api('GET', '/api/relay/discover')).j;
    assert(d.found.length === 1 && d.found[0].port === 17302 && d.found[0].tokenRequired === true && d.found[0].name === 'moveme.test', JSON.stringify(d));
    assert(!JSON.stringify(d).includes('secret'), 'токен не раскрывается');
    ok('агент находит релей без ввода адреса (порт 17302, нужен токен), токен по сети не передаётся');

    let c = (await A.api('POST', '/api/relay/connect', { host: d.found[0].host, port: d.found[0].port, tokenRequired: true, name: d.found[0].name })).j;
    assert(c.needToken === true && c.relay.enabled === false && c.relay.host === '127.0.0.1');
    ok('найденный релей запомнен, а без токена не подключается: просит только токен');

    c = (await A.api('POST', '/api/relay/connect', { host: '127.0.0.1', port: 17302, token: 'wrong', tokenRequired: true })).j;
    assert(c.needToken === false && c.relay.enabled === true);
    const bad = await until(async () => (await A.api('GET', '/api/tunnels')).j.relay.error, 6000, 'ошибка токена');
    assert(/токен/i.test(bad), bad);
    ok('неверный токен: понятная ошибка релея');

    c = (await A.api('POST', '/api/relay/connect', { link: 'hearth-relay://127.0.0.1:17302?token=secret' })).j;
    await until(async () => (await A.api('GET', '/api/tunnels')).j.relay.status === 'online', 8000, 'релей online по ссылке');
    ok('ссылка-приглашение hearth-relay://хост:порт?token=… подключает одним действием');

    const dead = await A.api('POST', '/api/relay/connect', { host: '127.0.0.1', port: 17999 });
    assert.strictEqual(dead.s, 502);
    assert.strictEqual((await A.api('POST', '/api/relay/connect', { link: 'http://мусор' })).s, 400);
    ok('недоступный релей и мусор вместо адреса отклоняются понятными ошибками');

    // 2. релей переехал на другие порты: агент находит его по имени
    procs[0].kill();
    await wait(400);
    relay({ RELAY_TOKEN: 'secret', CONTROL_PORT: '17312', HTTP_PORT: '17313', DISCOVERY_PORT: '17301', RELAY_DOMAIN: 'moveme.test' });
    const moved = await until(async () => {
      const r = (await A.api('GET', '/api/tunnels')).j.relay;
      return r.port === 17312 && r.status === 'online' ? r : null;
    }, 20000, 'релей найден по имени на новом порту');
    assert(moved.host === '127.0.0.1');
    ok('релей сменил порт: агент нашёл его по имени и переподключился сам');
    A.p.kill();

    // 3. открытый релей: новый агент подключается к нему сам при запуске
    procs.forEach((p) => p.kill());
    await wait(600);
    relay({ RELAY_OPEN: '1', CONTROL_PORT: '17322', HTTP_PORT: '17323', DISCOVERY_PORT: '17301', RELAY_DOMAIN: 'open.test' });
    await wait(700);
    const B = await agent(17311);
    const auto = await until(async () => {
      const r = (await B.api('GET', '/api/tunnels')).j.relay;
      return r.enabled && r.status === 'online' ? r : null;
    }, 12000, 'автоподключение к открытому релею');
    assert(auto.port === 17322 && auto.hasToken === false, JSON.stringify(auto));
    ok('открытый релей в сети подключается автоматически при первом запуске, без единого поля');

    // 4. известные адреса: /.well-known/hearth-relay
    const wk = await (await fetch('http://127.0.0.1:17323/.well-known/hearth-relay')).json();
    assert(wk.hearthRelay === 1 && wk.port === 17322 && wk.tokenRequired === false);
    const C = await agent(17312, { HEARTH_RELAY_AUTO: '0', HEARTH_DISCOVERY_PORT: '17399', HEARTH_RELAYS: '127.0.0.1:17323' });
    const kd = (await C.api('GET', '/api/relay/discover')).j.found;
    assert(kd.length === 1 && kd[0].source === 'known' && kd[0].port === 17322, JSON.stringify(kd));
    ok('релей в интернете находится по адресу сайта (/.well-known/hearth-relay)');

    // 5. отключённое автоопределение
    const D = await agent(17313, { HEARTH_RELAY_AUTO: '1', HEARTH_DISCOVERY_PORT: '17399' });
    await wait(1800);
    assert.strictEqual((await D.api('GET', '/api/tunnels')).j.relay.host, '', 'без релея в сети ничего не настраивается');
    ok('релея в сети нет: настройки остаются пустыми, ошибок нет');
    console.log(`\nrelay-discovery: ${n} проверок пройдено`);
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e);
    process.exit(1);
  }
})();
