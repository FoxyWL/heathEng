'use strict';
// Роли: владелец делает всё; оператор — только запуск/остановка/консоль своих серверов; зритель — только просмотр. Чужие серверы, файлы, настройки, релей и события скрыты.
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
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-roles-'));
const PORT = 17840;

(async () => {
  let agent;
  let fail = null;
  try {
    let out = '';
    agent = spawn('node', [path.join(root, 'main.js')], { env: { ...process.env, DATA_DIR: data, PORT: String(PORT), NO_BROWSER: '1', HEARTH_NO_OPEN: '1', HEARTH_RELAY_AUTO: '0', HEARTH_NETWATCH_MS: '60000' }, stdio: ['ignore', 'pipe', 'inherit'] });
    agent.stdout.on('data', (d) => (out += d));
    for (let i = 0; i < 80 && !/token=/.test(out); i++) await wait(100);
    const owner = /token=([0-9a-f]+)/.exec(out)[1];
    const call = async (tok, m, u, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${u}`, { method: m, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body && m !== 'GET' ? JSON.stringify(body) : undefined });
      return { s: r.status, j: await r.json().catch(() => ({})) };
    };
    const A = (m, u, b) => call(owner, m, u, b);

    const mk = async (name, port) => (await A('POST', '/api/servers', { game: 'custom', name, settings: { command: `node ${path.join(root, 'test/fake-game.js')} ${port}`, port, protocol: 'tcp', stopCommand: 'stop', rcon: 'ТАЙНЫЙ-ПАРОЛЬ' } })).j;
    const s1 = await mk('Мой', 15851);
    const s2 = await mk('Чужой', 15852);

    // создание пользователей
    assert.strictEqual((await A('POST', '/api/users', { name: '', role: 'viewer' })).s, 400);
    assert.strictEqual((await A('POST', '/api/users', { name: 'x', role: 'god' })).s, 400);
    assert.strictEqual((await A('POST', '/api/users', { name: 'x', role: 'viewer', servers: ['нет'] })).s, 400);
    const op = (await A('POST', '/api/users', { name: 'Оператор', role: 'operator', servers: [s1.id] })).j;
    const vw = (await A('POST', '/api/users', { name: 'Зритель', role: 'viewer', servers: '*' })).j;
    assert(op.token.startsWith('hu-') && vw.token !== op.token);
    const list = JSON.stringify((await A('GET', '/api/users')).j);
    assert(!list.includes(op.token) && !list.includes(vw.token), 'токены в списке не видны');
    const cfg = fs.readFileSync(path.join(data, 'config.json'), 'utf8');
    assert(!cfg.includes(op.token), 'на диске токен только в виде хэша');
    ok('пользователи создаются; токен выдаётся один раз и хранится только хэшем; кривые данные отклоняются');

    // оператор
    const O = (m, u, b) => call(op.token, m, u, b);
    const seen = (await O('GET', '/api/servers')).j;
    assert(seen.length === 1 && seen[0].id === s1.id && seen[0].dir === '' && !JSON.stringify(seen).includes('ТАЙНЫЙ-ПАРОЛЬ'));
    ok('оператор видит только свой сервер, без путей и паролей из настроек');
    assert.strictEqual((await O('GET', `/api/servers/${s2.id}`)).s, 403);
    assert.strictEqual((await O('POST', `/api/servers/${s2.id}/start`)).s, 403);
    assert.strictEqual((await O('GET', `/api/servers/${s2.id}/logs`)).s, 403);
    ok('чужой сервер недоступен: просмотр, логи и запуск — 403');
    assert((await O('POST', `/api/servers/${s1.id}/start`)).s === 200);
    for (let i = 0; i < 50 && (await A('GET', `/api/servers/${s1.id}`)).j.state !== 'running'; i++) await wait(150);
    assert.strictEqual((await A('GET', `/api/servers/${s1.id}`)).j.state, 'running');
    assert((await O('POST', `/api/servers/${s1.id}/command`, { text: 'say привет' })).s === 200);
    assert((await O('POST', `/api/servers/${s1.id}/stop`)).s === 200);
    for (let i = 0; i < 60 && (await A('GET', `/api/servers/${s1.id}`)).j.state !== 'stopped'; i++) await wait(150);
    assert.strictEqual((await A('GET', `/api/servers/${s1.id}`)).j.state, 'stopped');
    ok('оператор запускает, пишет в консоль и останавливает свой сервер');
    for (const [m, u] of [['PUT', `/api/servers/${s1.id}/file?path=a.txt`], ['PATCH', `/api/servers/${s1.id}`], ['DELETE', `/api/servers/${s1.id}`], ['GET', `/api/servers/${s1.id}/files`], ['GET', `/api/servers/${s1.id}/file?path=a`], ['POST', `/api/servers/${s1.id}/upload?path=x`], ['GET', `/api/servers/${s1.id}/download/x`], ['GET', `/api/servers/${s1.id}/backups/x`], ['GET', '/api/relayhost'], ['PUT', '/api/relay'], ['POST', '/api/tunnels'], ['GET', '/api/users'], ['POST', '/api/users'], ['PUT', '/api/cloud'], ['GET', '/api/cloud'], ['PUT', '/api/notify'], ['POST', '/api/update/install'], ['POST', '/api/quit'], ['POST', '/api/ai/explain'], ['PUT', '/api/settings'], ['PUT', '/api/startup'], ['POST', `/api/servers/${s1.id}/reinstall`], ['POST', `/api/servers/${s1.id}/backups/x/restore`], ['GET', '/api/panel']]) {
      const r = await O(m, u, {});
      assert.strictEqual(r.s, 403, `${m} ${u} → ${r.s}`);
    }
    ok('оператору закрыто всё остальное: файлы, загрузка и скачивание, настройки, удаление, релей, туннели, пользователи, облако, обновление, выход');

    // зритель
    const V = (m, u, b) => call(vw.token, m, u, b);
    assert((await V('GET', '/api/servers')).j.length === 2);
    assert((await V('GET', `/api/servers/${s1.id}/logs`)).s === 200);
    for (const [m, u] of [['POST', `/api/servers/${s1.id}/start`], ['POST', `/api/servers/${s1.id}/command`], ['POST', `/api/servers/${s1.id}/backups`], ['POST', `/api/servers/${s1.id}/stop`]]) assert.strictEqual((await V(m, u, {})).s, 403, u);
    ok('зритель видит серверы и логи, но не может ничего запустить, остановить или написать в консоль');

    // события SSE: оператору не приходят чужие серверы и служебные события
    const events = [];
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/events', headers: { authorization: 'Bearer ' + op.token } }, (res) => res.on('data', (d) => events.push(String(d))));
    const ownerEv = [];
    const req2 = http.get({ host: '127.0.0.1', port: PORT, path: '/api/events', headers: { authorization: 'Bearer ' + owner } }, (res) => res.on('data', (d) => ownerEv.push(String(d))));
    await wait(400);
    await A('POST', `/api/servers/${s2.id}/start`);
    await A('POST', `/api/servers/${s1.id}/start`);
    await A('PUT', '/api/relayhost', { vhostPort: 0 });
    await wait(2500);
    const all = events.join('');
    assert(all.includes(s1.id), 'события своего сервера приходят');
    assert(!all.includes(s2.id) && !all.includes('ТАЙНЫЙ-ПАРОЛЬ'), 'чужой сервер и пароль в событиях отсутствуют');
    assert(!/event: (relayhost|net|publicname|update|cloud)/.test(all), 'служебные события скрыты');
    assert(ownerEv.join('').includes(s2.id), 'владелец видит всё');
    ok('поток событий режется по серверам пользователя; служебные события скрыты; владелец видит всё');
    req.destroy();
    req2.destroy();
    await A('POST', `/api/servers/${s1.id}/stop`);
    await A('POST', `/api/servers/${s2.id}/stop`);

    // изменение, повторный токен, удаление
    assert((await A('PATCH', `/api/users/${op.user.id}`, { servers: [s1.id, s2.id] })).s === 200);
    assert((await O('GET', '/api/servers')).j.length === 2);
    const re = (await A('POST', `/api/users/${op.user.id}/token`)).j;
    assert.strictEqual((await O('GET', '/api/servers')).s, 401);
    assert.strictEqual((await call(re.token, 'GET', '/api/servers')).s, 200);
    assert((await A('DELETE', `/api/users/${op.user.id}`)).s === 200);
    assert.strictEqual((await call(re.token, 'GET', '/api/servers')).s, 401);
    assert.strictEqual((await call('hu-wrongtoken', 'GET', '/api/servers')).s, 401);
    ok('смена серверов действует сразу; новый токен гасит старый; удалённый пользователь теряет доступ');

    // владельцу доступно всё, как раньше
    assert((await A('GET', '/api/relayhost')).s === 200 && (await A('GET', '/api/cloud')).s === 200);
    const pn = (await A('PUT', '/api/panel', { lan: true })).j;
    assert(pn.lan === true && pn.restartNeeded === true, JSON.stringify(pn));
    await A('PUT', '/api/panel', { lan: false });
    ok('владелец: полный доступ, как раньше; доступ к панели по сети включается и просит перезапуск');
  } catch (e) {
    fail = e;
  }
  try { agent && agent.kill(); } catch {}
  if (fail) {
    console.error('FAIL', fail.stack || fail);
    process.exit(1);
  }
  console.log(`\nroles: ${n} проверок пройдено`);
  process.exit(0);
})();
