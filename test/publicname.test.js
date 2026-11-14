'use strict';
// Публичное имя вместо IP: sslip.io (имя из IP) и DuckDNS (поддельный сервис обновления), проверка имени через настоящий DNS-запрос.
const { spawn } = require('child_process');
const assert = require('assert');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
let n = 0;
const ok = (m) => console.log('  ✓', m, `(${++n})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// поддельный роутер (минимум для открытия порта) и поддельный DuckDNS
const router = { ext: '203.0.113.7' };
const duck = { token: '0a1b2c3d-1111-2222-3333-444455556666', sub: 'kelly', ip: '', calls: [], down: false };
const web = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/desc.xml') return res.end('<root><device><friendlyName>Fake</friendlyName><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl</controlURL></service></serviceList></device></root>');
    if (u.pathname === '/ip') return res.end(router.ext);
    if (u.pathname === '/ctl') {
      const act = /#(\w+)"/.exec(req.headers.soapaction || '')[1];
      if (act === 'GetExternalIPAddress') return res.end(`<s:Envelope><s:Body><u:R><NewExternalIPAddress>${router.ext}</NewExternalIPAddress></u:R></s:Body></s:Envelope>`);
      return res.end('<s:Envelope><s:Body/></s:Envelope>');
    }
    if (u.pathname === '/update') {
      duck.calls.push(Object.fromEntries(u.searchParams));
      if (duck.down) return req.socket.destroy();
      if (u.searchParams.get('token') !== duck.token || u.searchParams.get('domains') !== duck.sub) return res.end('KO');
      const ip = u.searchParams.get('ip') || '198.51.100.1';
      const changed = ip !== duck.ip;
      duck.ip = ip;
      return res.end(`OK\n${ip}\n\n${changed ? 'UPDATED' : 'NOCHANGE'}`);
    }
    res.statusCode = 404;
    res.end();
  });
});
const ssdp = dgram.createSocket('udp4');
ssdp.on('message', (m, r) => /M-SEARCH/.test(m.toString()) && ssdp.send('HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:17450/desc.xml\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n', r.port, r.address));

// поддельный DNS: kelly.duckdns.org и всё *.sslip.io с IP в имени
const dnsSrv = dgram.createSocket('udp4');
const dnsAnswer = (q) => {
  let off = 12;
  const labels = [];
  while (q[off]) {
    labels.push(q.slice(off + 1, off + 1 + q[off]).toString());
    off += q[off] + 1;
  }
  const name = labels.join('.');
  let ip = '';
  const m = /(\d+)-(\d+)-(\d+)-(\d+)\.sslip\.io$/.exec(name);
  if (m) ip = m.slice(1, 5).join('.');
  if (name === 'kelly.duckdns.org' && duck.ip) ip = duck.ip;
  const head = Buffer.from(q.slice(0, 12));
  head.writeUInt16BE(0x8180, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(ip ? 1 : 0, 6);
  if (!ip) head.writeUInt16BE(0x8183, 2);
  const question = q.slice(12, off + 5);
  if (!ip) return Buffer.concat([head, question]);
  const ans = Buffer.concat([Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4]), Buffer.from(ip.split('.').map(Number))]);
  return Buffer.concat([head, question, ans]);
};
dnsSrv.on('message', (q, r) => dnsSrv.send(dnsAnswer(q), r.port, r.address));

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-pn-'));
let agent;
let out = '';
let token;
const api = async (m, u, body) => {
  const r = await fetch('http://127.0.0.1:17453' + u, { method: m, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
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
  await new Promise((r) => web.listen(17450, '127.0.0.1', r));
  await new Promise((r) => ssdp.bind(17451, '127.0.0.1', r));
  await new Promise((r) => dnsSrv.bind(17452, '127.0.0.1', r));
  agent = spawn('node', [path.join(root, 'main.js')], { env: { ...process.env, DATA_DIR: data, PORT: '17453', NO_BROWSER: '1', HEARTH_NO_OPEN: '1', HEARTH_SSDP_TARGET: '127.0.0.1:17451', HEARTH_IPCHECK_URL: 'http://127.0.0.1:17450/ip', HEARTH_DUCKDNS_URL: 'http://127.0.0.1:17450', HEARTH_DNS_SERVER: '127.0.0.1:17452', HEARTH_DUCK_MS: '600', HEARTH_PUBLIC_RENEW_MS: '600', HEARTH_RELAY_AUTO: '0', HEARTH_NETWATCH_MS: '60000' }, stdio: ['ignore', 'pipe', 'inherit'] });
  agent.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 80 && !/token=/.test(out); i++) await wait(100);
  token = /token=([0-9a-f]+)/.exec(out)[1];
  let fail = null;
  try {
    const sv = (await api('POST', '/api/servers', { game: 'custom', name: 'Kelly Craft', command: 'node -e 0', settings: { port: 17460 } })).j;
    assert(sv.id);
    assert.strictEqual((await api('POST', `/api/servers/${sv.id}/public`, { enabled: true })).j.publicIp.host, '203.0.113.7', 'без имени: просто IP');
    ok('по умолчанию адрес из интернета — IP без имени');

    // sslip.io
    let r = await api('PUT', '/api/publicname', { mode: 'sslip' });
    assert.strictEqual(r.s, 200);
    let s = (await api('GET', `/api/servers/${sv.id}`)).j;
    assert.strictEqual(s.publicIp.host, 'kelly-craft.203-0-113-7.sslip.io', s.publicIp.host);
    const chk = (await api('POST', '/api/publicname/check', { id: sv.id })).j;
    assert(chk.ok && chk.ips[0] === '203.0.113.7', JSON.stringify(chk));
    ok('sslip.io: имя «kelly-craft.203-0-113-7.sslip.io» собрано из имени сервера и IP, настоящий DNS-запрос возвращает 203.0.113.7');

    // смена IP: имя пересобирается само
    router.ext = '203.0.113.99';
    s = await until(async () => {
      const x = (await api('GET', `/api/servers/${sv.id}`)).j;
      return x.publicIp.host.includes('203-0-113-99') && x;
    }, 10000, 'имя с новым IP');
    ok('внешний IP сменился: имя sslip.io обновилось само');
    router.ext = '203.0.113.7';
    await until(async () => (await api('GET', `/api/servers/${sv.id}`)).j.publicIp.host.includes('203-0-113-7'), 10000, 'вернулось');

    // DuckDNS: плохие данные
    assert.strictEqual((await api('PUT', '/api/publicname', { mode: 'duckdns', duckSub: '', duckToken: duck.token })).s, 400, 'без имени');
    assert.strictEqual((await api('PUT', '/api/publicname', { duckSub: 'kel ly!', duckToken: duck.token })).s, 400, 'мусор в имени');
    assert.strictEqual((await api('PUT', '/api/publicname', { duckSub: 'kelly', duckToken: 'abc' })).s, 400, 'токен не похож на токен');
    ok('DuckDNS: пустое имя, мусор в имени и не-токен отклонены понятной ошибкой');

    // DuckDNS: ошибка сервиса (неверный токен)
    r = await api('PUT', '/api/publicname', { mode: 'duckdns', duckSub: 'kelly.duckdns.org', duckToken: '99999999-aaaa-bbbb-cccc-dddddddddddd' });
    assert.strictEqual(r.j.duck.sub, 'kelly', 'суффикс .duckdns.org обрезан');
    assert.strictEqual(r.j.duck.ok, false);
    assert(/KO/.test(r.j.duck.error), r.j.duck.error);
    s = (await api('GET', `/api/servers/${sv.id}`)).j;
    assert.strictEqual(s.publicIp.host, '203.0.113.7', 'имя не работает: показываем IP, а не мёртвое имя');
    ok('DuckDNS: неверный токен (KO) показан понятно, а друзьям по-прежнему отдаётся рабочий IP');

    // DuckDNS: верный токен
    r = await api('PUT', '/api/publicname', { duckToken: duck.token });
    assert.strictEqual(r.j.duck.ok, true, JSON.stringify(r.j));
    assert.strictEqual(duck.ip, '203.0.113.7', 'в DuckDNS ушёл внешний IP: ' + duck.ip);
    assert(!JSON.stringify(r.j).includes(duck.token), 'токен не показывается в ответе');
    s = (await api('GET', `/api/servers/${sv.id}`)).j;
    assert.strictEqual(s.publicIp.host, 'kelly.duckdns.org');
    const c2 = (await api('POST', '/api/publicname/check', { id: sv.id })).j;
    assert(c2.ok && c2.ips[0] === '203.0.113.7', JSON.stringify(c2));
    ok('DuckDNS: kelly.duckdns.org указывает на внешний IP (проверено DNS-запросом), токен в ответах не светится');

    // смена IP: DuckDNS узнаёт сразу
    router.ext = '203.0.113.50';
    await until(() => duck.ip === '203.0.113.50', 10000, 'DuckDNS получил новый IP');
    ok('внешний IP сменился: Hearth сам отправил его в DuckDNS');
    router.ext = '203.0.113.7';
    await until(() => duck.ip === '203.0.113.7', 10000, 'вернулся');

    // DuckDNS недоступен
    duck.down = true;
    await until(async () => {
      const x = (await api('GET', '/api/publicname')).j;
      return x.duck.ok === false && /недоступен/.test(x.duck.error);
    }, 10000, 'ошибка сети показана');
    s = (await api('GET', `/api/servers/${sv.id}`)).j;
    assert.strictEqual(s.publicIp.host, '203.0.113.7');
    duck.down = false;
    await until(async () => (await api('GET', '/api/publicname')).j.duck.ok === true, 10000, 'восстановилось');
    ok('DuckDNS недоступен: ошибка видна, друзьям отдаётся IP; сервис вернулся — имя снова рабочее');

    // выключили имя — вернулся IP; токен сохранён на диске
    await api('PUT', '/api/publicname', { mode: 'off' });
    s = (await api('GET', `/api/servers/${sv.id}`)).j;
    assert.strictEqual(s.publicIp.host, '203.0.113.7');
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).publicName;
    assert.strictEqual(saved.mode, 'off');
    assert.strictEqual(saved.duckSub, 'kelly');
    ok('имя выключено: снова IP; настройки DuckDNS сохранены');
  } catch (e) {
    fail = e;
  }
  try {
    await api('POST', '/api/quit');
  } catch {}
  await wait(800);
  agent.kill();
  if (fail) {
    console.log('FAIL', fail.stack || fail);
    process.exit(1);
  }
  console.log(`\npublicname: ${n} проверок пройдено`);
  process.exit(0);
})();
