'use strict';
// Имена для всех игр через агента: Minecraft Java — на общем порту, остальные — имя + стабильный порт; честно: имя только там, где оно возможно.
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
let n = 0;
const ok = (m) => console.log('  ✓', m, `(${++n})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-vh-'));
const mcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-vhmc-'));
const DOM = '127-0-0-1.sslip.io';

const relay = spawn('node', [path.join(root, 'relay/relay.js')], { env: { ...process.env, RELAY_TOKEN: 'vt', CONTROL_PORT: '17700', HTTP_PORT: '0', VHOST_PORT: '17701', RELAY_DOMAIN: DOM, PUBLIC_HOST: '127.0.0.1', PORT_MIN: '32400', PORT_MAX: '32420', BIND: '127.0.0.1', DISCOVERY_PORT: '0' }, stdio: 'ignore' });
let agent;
let token;
const startAgent = async () => {
  let out = '';
  agent = spawn('node', [path.join(root, 'main.js')], { env: { ...process.env, DATA_DIR: data, PORT: '17710', NO_BROWSER: '1', HEARTH_NO_OPEN: '1', HEARTH_RELAY_AUTO: '0', HEARTH_NETWATCH_MS: '60000' }, stdio: ['ignore', 'pipe', 'inherit'] });
  agent.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 80 && !/token=/.test(out); i++) await wait(100);
  token = /token=([0-9a-f]+)/.exec(out)[1];
};
const api = async (m, u, body) => {
  const r = await fetch('http://127.0.0.1:17710' + u, { method: m, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('таймаут: ' + what);
    await wait(150);
  }
};
const varint = (v) => {
  const o = [];
  do {
    let c = v & 0x7f;
    v >>>= 7;
    if (v) c |= 0x80;
    o.push(c);
  } while (v);
  return Buffer.from(o);
};
const handshake = (host) => {
  const h = Buffer.from(host);
  const body = Buffer.concat([Buffer.from([0]), varint(765), varint(h.length), h, Buffer.from([0x63, 0xdd]), varint(2)]);
  return Buffer.concat([varint(body.length), body]);
};
const send = (port, bytes) =>
  new Promise((res) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(bytes));
    let got = '';
    s.on('data', (d) => (got += d));
    s.on('error', () => {});
    s.on('close', () => res(got));
    setTimeout(() => (s.destroy(), res(got)), 800);
  });

(async () => {
  let fail = null;
  try {
    // «игра» на 15700: отвечает тем, что получила; «сервер Minecraft» на 15701
    net.createServer((s) => s.on('data', (d) => s.write('MC:' + d.length))).listen(15701, '127.0.0.1');
    net.createServer((s) => s.on('data', () => s.write('GAME'))).listen(15700, '127.0.0.1');
    await wait(900);
    await startAgent();
    await api('PUT', '/api/relay', { enabled: true, host: '127.0.0.1', port: 17700, token: 'vt', name: 'vh' });
    const mc = (await api('POST', '/api/servers', { game: 'minecraft-paper', importDir: mcDir, name: 'Popka MC', settings: { port: 15701 } })).j;
    const other = (await api('POST', '/api/servers', { game: 'custom', name: 'Other Game', settings: { command: 'node -e "setInterval(()=>{},1000)"', port: 15700, protocol: 'tcp' } })).j;
    assert(mc.id && other.id, 'серверы созданы');
    await api('PATCH', `/api/servers/${mc.id}`, { tunnel: { enabled: true } });
    await api('PATCH', `/api/servers/${other.id}`, { tunnel: { enabled: true } });
    const view = async () => (await api('GET', '/api/tunnels')).j;
    const both = async () => {
      const v = await view();
      const a = v.tunnels.find((t) => t.id === 'srv-' + mc.id);
      const b = v.tunnels.find((t) => t.id === 'srv-' + other.id);
      return a && b && a.info && b.info ? { v, a, b } : null;
    };
    let { v, a, b } = await until(both, 8000, 'оба туннеля получили адрес');
    assert(v.relay.vhostPort === 17701 && v.relay.domain === DOM && v.relay.names === true, JSON.stringify(v.relay));
    ok('агент знает, что релей умеет имена: общий порт, домен, имена работают (sslip.io)');
    assert(a.via === 'vhost' && a.info.url === `popka-mc.${DOM}:17701`, JSON.stringify(a.info));
    ok('Minecraft Java: адрес — имя на общем порту, отдельный порт не выдаётся');
    const reply = await send(17701, Buffer.concat([handshake(`popka-mc.${DOM}`), Buffer.from([1, 0])]));
    assert(reply.startsWith('MC:'), reply);
    ok('подключение по имени доходит до Minecraft-сервера');
    assert(b.via === 'tcp' && b.info.port >= 32400 && b.info.port <= 32420 && b.nameUrl === `other-game.${DOM}:${b.info.port}`, JSON.stringify([b.via, b.info, b.nameUrl]));
    ok('другая игра: имя + её порт (имя в пакете игры не передаётся, порт нужен всегда)');
    assert.strictEqual(await send(b.info.port, 'x'), 'GAME');
    ok('игра по порту релея работает');

    // свой выбор: без имён Minecraft получает обычный порт
    await api('PATCH', `/api/servers/${mc.id}`, { tunnel: { byName: false } });
    const plain = await until(async () => {
      const t = (await view()).tunnels.find((x) => x.id === 'srv-' + mc.id);
      return t && t.info && t.via === 'tcp' ? t : null;
    }, 6000, 'Minecraft без имени');
    assert(plain.info.port >= 32400);
    await api('PATCH', `/api/servers/${mc.id}`, { tunnel: { byName: true } });
    await until(async () => ((await view()).tunnels.find((x) => x.id === 'srv-' + mc.id) || {}).via === 'vhost', 6000, 'имя вернулось');
    ok('имя на общем порту можно выключить и включить обратно');

    // порт запоминается: после перезапуска Hearth адрес тот же
    const firstPort = b.info.port;
    agent.kill();
    await wait(1200);
    await startAgent();
    const again = await until(async () => {
      const t = (await view()).tunnels.find((x) => x.id === 'srv-' + other.id);
      return t && t.info ? t : null;
    }, 8000, 'туннель после перезапуска');
    assert.strictEqual(again.info.port, firstPort, `порт ${again.info.port} ≠ ${firstPort}`);
    ok('после перезапуска Hearth адрес другой игры не меняется (порт запомнен)');

    // «чужой» релей: порт выдан другим релеем, у нового релея порт не помним
    await api('PUT', '/api/relay', { host: '127.0.0.2' }); // здесь релея нет: порт не появится заново
    await wait(500);
    const hostKept = (await api('GET', `/api/servers/${other.id}`)).j.tunnel.lastPort;
    assert.strictEqual(hostKept, 0);
    ok('при смене релея запомненные порты сбрасываются');

    // обычный туннель на любой порт: «TCP по имени»
    const ext = await api('POST', '/api/tunnels', { proto: 'vhost', localPort: 15701, subdomain: 'extra', name: 'Extra' });
    assert(ext.s === 200, JSON.stringify(ext.j));
    const bad = await api('POST', '/api/tunnels', { proto: 'gopher', localPort: 15701 });
    assert.strictEqual(bad.s, 400);
    ok('любой порт можно открыть «TCP по имени»; неизвестный протокол отклоняется');
    const clash = await api('PUT', '/api/relayhost', { vhostPort: 7000 });
    const low = await api('PUT', '/api/relayhost', { vhostPort: 80 });
    const fine = await api('PUT', '/api/relayhost', { vhostPort: 25565 });
    const off = await api('PUT', '/api/relayhost', { vhostPort: 0 });
    assert(clash.s === 400 && low.s === 400 && fine.j.vhostPort === 25565 && off.j.vhostPort === 0, JSON.stringify([clash.s, low.s, fine.j.vhostPort, off.j.vhostPort]));
    ok('общий порт релея на этом ПК: проверка значений, включение и выключение');
  } catch (e) {
    fail = e;
  }
  try { agent && agent.kill(); } catch {}
  relay.kill();
  if (fail) {
    console.error('FAIL', fail.stack || fail);
    process.exit(1);
  }
  console.log(`\nvhost-agent: ${n} проверок пройдено`);
  process.exit(0);
})();
