'use strict';
// Свой домен: релей узнаёт ваши имена (play.example.com), помощник DNS проверяет A и SRV через настоящий DNS-запрос к поддельному DNS-серверу.
const { spawn } = require('child_process');
const assert = require('assert');
const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
let n = 0;
const ok = (m) => console.log('  ✓', m, `(${++n})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { TunnelClient } = require(path.join(root, 'agent/lib/tunnel'));

// --- поддельный DNS ---
const zone = {
  'A play.example.com': [['127.0.0.1']],
  'A wrong.example.com': [['9.9.9.9']],
  'SRV _minecraft._tcp.srv.example.com': [[0, 5, 17801, 'x.127-0-0-1.sslip.io']],
  'SRV _minecraft._tcp.badsrv.example.com': [[0, 5, 25570, 'x.127-0-0-1.sslip.io']],
  'A x.127-0-0-1.sslip.io': [['127.0.0.1']],
};
const nameBuf = (name) => Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
const dnsd = dgram.createSocket('udp4');
dnsd.on('message', (q, r) => {
  let o = 12;
  const labels = [];
  while (q[o]) {
    labels.push(q.toString('latin1', o + 1, o + 1 + q[o]));
    o += q[o] + 1;
  }
  const qtype = q.readUInt16BE(o + 1);
  const name = labels.join('.');
  const t = qtype === 1 ? 'A' : qtype === 33 ? 'SRV' : '?';
  const recs = zone[`${t} ${name}`] || [];
  const answers = recs.map((v) => {
    const rd = t === 'A' ? Buffer.from(v[0].split('.').map(Number)) : Buffer.concat([Buffer.from([0, v[0], 0, v[1], v[2] >> 8, v[2] & 255]), nameBuf(v[3])]);
    const head = Buffer.alloc(10);
    head.writeUInt16BE(qtype, 0);
    head.writeUInt16BE(1, 2);
    head.writeUInt32BE(60, 4);
    head.writeUInt16BE(rd.length, 8);
    return Buffer.concat([Buffer.from([0xc0, 12]), head, rd]);
  });
  const hdr = Buffer.alloc(12);
  q.copy(hdr, 0, 0, 2);
  hdr.writeUInt16BE(0x8180 | (recs.length ? 0 : 3), 2);
  hdr.writeUInt16BE(1, 4);
  hdr.writeUInt16BE(answers.length, 6);
  dnsd.send(Buffer.concat([hdr, q.subarray(12, o + 5), ...answers]), r.port, r.address);
});

const vi = (v) => {
  const o = [];
  do {
    let c = v & 0x7f;
    v >>>= 7;
    if (v) c |= 0x80;
    o.push(c);
  } while (v);
  return Buffer.from(o);
};
const hs = (host) => {
  const hb = Buffer.from(host);
  const body = Buffer.concat([Buffer.from([0]), vi(765), vi(hb.length), hb, Buffer.from([0x63, 0xdd]), vi(2)]);
  return Buffer.concat([vi(body.length), body]);
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

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-dom-'));
const mcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-dommc-'));
const relay = spawn('node', [path.join(root, 'relay/relay.js')], { env: { ...process.env, RELAY_TOKEN: 'dt', CONTROL_PORT: '17800', HTTP_PORT: '0', VHOST_PORT: '17801', RELAY_DOMAIN: '127-0-0-1.sslip.io', PUBLIC_HOST: '127.0.0.1', PORT_MIN: '32500', PORT_MAX: '32520', BIND: '127.0.0.1', DISCOVERY_PORT: '0' }, stdio: 'ignore' });
let agent;
let token;
const startAgent = async () => {
  let out = '';
  agent = spawn('node', [path.join(root, 'main.js')], { env: { ...process.env, DATA_DIR: data, PORT: '17810', NO_BROWSER: '1', HEARTH_NO_OPEN: '1', HEARTH_RELAY_AUTO: '0', HEARTH_NETWATCH_MS: '60000', HEARTH_DNS_SERVER: '127.0.0.1:15353' }, stdio: ['ignore', 'pipe', 'inherit'] });
  agent.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 80 && !/token=/.test(out); i++) await wait(100);
  token = /token=([0-9a-f]+)/.exec(out)[1];
};
const api = async (m, u, body) => {
  const r = await fetch('http://127.0.0.1:17810' + u, { method: m, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
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

(async () => {
  let fail = null;
  try {
    await new Promise((r) => dnsd.bind(15353, '127.0.0.1', r));
    net.createServer((s) => s.on('data', () => s.write('MC-OK'))).listen(15801, '127.0.0.1');
    await wait(800);

    // 1. релей: свои имена клиента маршрутизируются, чужие не отбираются, кривые отклоняются
    const c1 = new TunnelClient();
    c1.configure({ host: '127.0.0.1', port: 17800, token: 'dt', name: 'a' });
    c1.add({ id: 'a1', proto: 'vhost', localPort: 15801, subdomain: 'one', hosts: ['Play.Example.com.'] });
    c1.start();
    const c2 = new TunnelClient();
    c2.configure({ host: '127.0.0.1', port: 17800, token: 'dt', name: 'b' });
    c2.add({ id: 'b1', proto: 'vhost', localPort: 15801, subdomain: 'two', hosts: ['play.example.com'] });
    c2.add({ id: 'b2', proto: 'vhost', localPort: 15801, subdomain: 'three', hosts: ['not a host'] });
    c2.start();
    await wait(1500);
    const l1 = c1.list()[0];
    const l2 = Object.fromEntries(c2.list().map((t) => [t.id, t]));
    assert(l1.info && l1.info.url === 'one.127-0-0-1.sslip.io:17801', JSON.stringify(l1));
    assert.strictEqual(await send(17801, hs('play.example.com')), 'MC-OK');
    assert.strictEqual(await send(17801, hs('one.127-0-0-1.sslip.io')), 'MC-OK');
    ok('Minecraft заходит и по своему имени (play.example.com), и по имени релея');
    assert(/имя занято/.test(l2.b1.error), JSON.stringify(l2.b1));
    assert(/неверное имя/.test(l2.b2.error), JSON.stringify(l2.b2));
    ok('чужое имя занять нельзя; кривое имя отклоняется, оба туннеля не повисают');
    c1.remove('a1');
    await wait(300);
    assert(!(await send(17801, hs('play.example.com'))).startsWith('MC-OK'));
    ok('имя освобождается вместе с туннелем');
    c1.stop();
    c2.stop();

    // 2. агент: проверка DNS
    await startAgent();
    await api('PUT', '/api/relay', { enabled: true, host: '127.0.0.1', port: 17800, token: 'dt', name: 'dom' });
    const mc = (await api('POST', '/api/servers', { game: 'minecraft-paper', importDir: mcDir, name: 'Dom MC', settings: { port: 15801 } })).j;
    await api('PATCH', `/api/servers/${mc.id}`, { tunnel: { enabled: true, customHost: 'Play.Example.com' } });
    await until(async () => ((await api('GET', '/api/tunnels')).j.tunnels.find((t) => t.id === 'srv-' + mc.id) || {}).info, 8000, 'туннель');
    assert.strictEqual((await api('GET', `/api/servers/${mc.id}`)).j.tunnel.customHost, 'play.example.com');
    assert.strictEqual(await send(17801, hs('play.example.com')), 'MC-OK');
    ok('своё имя привязано к серверу и работает через релей агента');

    const bad = await api('PATCH', `/api/servers/${mc.id}`, { tunnel: { customHost: 'не имя' } });
    assert.strictEqual(bad.s, 400);
    ok('кривое имя отклоняется ещё в агенте');

    let r = await api('POST', '/api/domain/check', { host: 'play.example.com', serverId: mc.id });
    assert(r.j.found.a[0] === '127.0.0.1' && r.j.ip === '127.0.0.1', JSON.stringify(r.j));
    assert(!r.j.ok && r.j.problems.some((p) => /SRV/.test(p)), JSON.stringify(r.j.problems));
    assert(r.j.records.some((x) => x.type === 'SRV' && /17801 dom-mc\.127-0-0-1\.sslip\.io$/.test(x.value)), JSON.stringify(r.j.records));
    ok('A-запись верна, но порт релея 17801, а не 25565: помощник требует SRV и даёт готовую запись');

    r = await api('POST', '/api/domain/check', { host: 'srv.example.com', serverId: mc.id });
    assert(r.j.ok && r.j.via === 'srv', JSON.stringify(r.j));
    ok('SRV-запись на порт релея и имя, ведущее на релей: всё работает');

    r = await api('POST', '/api/domain/check', { host: 'badsrv.example.com', serverId: mc.id });
    assert(!r.j.ok && r.j.problems.some((p) => /SRV-запись есть, но не ведёт/.test(p)));
    r = await api('POST', '/api/domain/check', { host: 'wrong.example.com', serverId: mc.id });
    assert(!r.j.ok && r.j.problems.some((p) => /9\.9\.9\.9/.test(p)));
    r = await api('POST', '/api/domain/check', { host: 'nothing.example.com', serverId: mc.id });
    assert(!r.j.ok && r.j.problems.some((p) => /пока нет/.test(p)));
    ok('неверный порт SRV, чужой IP и отсутствие записей объясняются по-человечески');

    r = await api('POST', '/api/domain/check', { host: 'xx', serverId: mc.id });
    assert.strictEqual(r.s, 400);
    ok('мусор вместо имени отклоняется');
  } catch (e) {
    fail = e;
  }
  try { agent && agent.kill(); } catch {}
  relay.kill();
  dnsd.close();
  if (fail) {
    console.error('FAIL', fail.stack || fail);
    process.exit(1);
  }
  console.log(`\ndomain: ${n} проверок пройдено`);
  process.exit(0);
})();
