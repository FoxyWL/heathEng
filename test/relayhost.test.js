'use strict';
// «Стать релеем»: релей Hearth на этом ПК. Поддельный роутер (SSDP + SOAP), настоящий релей-процесс, настоящий клиент туннеля.
const { spawn, spawnSync } = require('child_process');
const assert = require('assert');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
process.env.HEARTH_DISCOVERY_PORT = '17435';
const { TunnelClient } = require(path.join(root, 'agent/lib/tunnel'));
const relaydisc = require(path.join(root, 'agent/lib/relaydisc'));

let n = 0;
const ok = (m) => console.log('  ✓', m, `(${++n})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const router = { ext: '203.0.113.7', web: '203.0.113.7', up: true, maps: new Map() };
const igd = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.url === '/desc.xml') return res.end('<root><device><friendlyName>Fake Router</friendlyName><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl</controlURL></service></serviceList></device></root>');
    if (req.url === '/ip') return res.end(router.web);
    const act = /#(\w+)"/.exec(req.headers.soapaction || '')[1];
    const arg = (k) => (new RegExp(`<${k}>([^<]*)</${k}>`).exec(body) || [])[1];
    if (act === 'GetExternalIPAddress') return res.end(`<s:Envelope><s:Body><u:R><NewExternalIPAddress>${router.ext}</NewExternalIPAddress></u:R></s:Body></s:Envelope>`);
    if (act === 'AddPortMapping') router.maps.set(`${arg('NewExternalPort')}/${arg('NewProtocol')}`, arg('NewInternalClient'));
    if (act === 'DeletePortMapping') router.maps.delete(`${arg('NewExternalPort')}/${arg('NewProtocol')}`);
    res.end('<s:Envelope><s:Body/></s:Envelope>');
  });
});
const ssdp = dgram.createSocket('udp4');
ssdp.on('message', (m, r) => {
  if (router.up && /M-SEARCH/.test(m.toString())) ssdp.send('HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:17430/desc.xml\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n', r.port, r.address);
});

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-rh-'));
let agent;
let out = '';
let token;
const startAgent = async () => {
  out = '';
  agent = spawn('node', [path.join(root, 'main.js')], { env: { ...process.env, DATA_DIR: data, PORT: '17431', NO_BROWSER: '1', HEARTH_NO_OPEN: '1', HEARTH_SSDP_TARGET: '127.0.0.1:17432', HEARTH_IPCHECK_URL: 'http://127.0.0.1:17430/ip', HEARTH_PUBLIC_RENEW_MS: '700', HEARTH_RELAY_AUTO: '0', HEARTH_RELAY_DISCOVERY: '17435', HEARTH_NETWATCH_MS: '60000' }, stdio: ['ignore', 'pipe', 'inherit'] });
  agent.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 80 && !/token=/.test(out); i++) await wait(100);
  token = /token=([0-9a-f]+)/.exec(out)[1];
};
const api = async (m, u, body) => {
  const r = await fetch('http://127.0.0.1:17431' + u, { method: m, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
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
const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(700, () => (s.destroy(), res(false)));
    s.once('connect', () => (s.destroy(), res(true)));
    s.once('error', () => res(false));
  });
// релей этого агента: его дочерние процессы (чужие релеи других тестов не мешают)
const relayPids = () => spawnSync('pgrep', ['-P', String(agent.pid), '-f', 'relay/relay.js']).stdout.toString().trim().split('\n').filter(Boolean).map(Number);
const alive = (pid) => {
  try {
    return !/^\d+ \(.*\) [ZX]/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); // зомби без родителя считаем завершённым
  } catch {
    return false;
  }
};

(async () => {
  await new Promise((r) => igd.listen(17430, '127.0.0.1', r));
  await new Promise((r) => ssdp.bind(17432, '127.0.0.1', r));
  await startAgent();
  const echo = net.createServer((s) => s.on('data', (d) => s.write('echo:' + d)));
  await new Promise((r) => echo.listen(17440, '127.0.0.1', r));
  let fail = null;
  try {
    // настройки
    let r = await api('PUT', '/api/relayhost', { controlPort: 17420, portMin: 17421, portMax: 17424 });
    assert.strictEqual(r.s, 200);
    assert.strictEqual((await api('PUT', '/api/relayhost', { portMin: 17430, portMax: 17425 })).s, 400, 'конец меньше начала');
    assert.strictEqual((await api('PUT', '/api/relayhost', { controlPort: 17422 })).s, 400, 'порт управления внутри диапазона');
    assert.strictEqual((await api('PUT', '/api/relayhost', { portMin: 17421, portMax: 18999 })).s, 400, 'диапазон длиннее 100');
    ok('порты релея: корректный диапазон принят, перевёрнутый, пересекающийся и слишком длинный отклонены');

    // запуск с UPnP
    r = await api('POST', '/api/relayhost/start');
    assert.strictEqual(r.s, 200, JSON.stringify(r.j));
    const v = r.j;
    assert(v.running && v.upnp, JSON.stringify(v));
    assert.strictEqual(v.verdict, 'upnp');
    assert(v.link.startsWith('hearth-relay://203.0.113.7:17420?token='), v.link);
    const maps = [...router.maps.keys()].sort();
    const want = ['17420/TCP', ...[17421, 17422, 17423, 17424].flatMap((p) => [`${p}/TCP`, `${p}/UDP`])].sort();
    assert.deepStrictEqual(maps, want, 'порты на роутере: ' + maps.join());
    assert(await portOpen(17420), 'релей слушает порт управления');
    ok('«Стать релеем»: релей запущен, порты открыты на роутере, ссылка-приглашение с внешним IP');

    // настоящий клиент Hearth подключается по ссылке и открывает туннель
    const parsed = relaydisc.parseLink(v.link);
    const c = new TunnelClient();
    c.configure({ host: '127.0.0.1', port: parsed.port, token: parsed.token, name: 'friend' });
    c.add({ id: 'f1', proto: 'tcp', localPort: 17440 });
    c.start();
    await until(() => c.status === 'online' && c.list()[0].info, 6000, 'друг подключился к релею');
    const rport = c.list()[0].info.port;
    assert(rport >= 17421 && rport <= 17424, 'публичный порт из выданного диапазона: ' + rport);
    const reply = await new Promise((res, rej) => {
      const s = net.connect({ host: '127.0.0.1', port: rport }, () => s.write('hi'));
      s.on('data', (d) => (res(String(d)), s.destroy()));
      s.on('error', rej);
    });
    assert.strictEqual(reply, 'echo:hi');
    ok('друг подключился к релею этого ПК по ссылке и получил публичный порт из диапазона: трафик идёт через релей');
    c.stop();

    // неверный токен
    const bad = new TunnelClient();
    bad.configure({ host: '127.0.0.1', port: 17420, token: 'неверный', name: 'bad' });
    bad.add({ id: 'b1', proto: 'tcp', localPort: 17440 });
    bad.start();
    await wait(1500);
    assert(bad.status !== 'online', 'с неверным токеном подключиться нельзя');
    bad.stop();
    ok('с неверным токеном релей не пускает');

    // другие Hearth в сети находят релей сами
    const found = await relaydisc.discover({ ms: 1200 });
    assert(found.some((f) => f.port === 17420 && f.tokenRequired), 'найден: ' + JSON.stringify(found));
    ok('релей отвечает на автопоиск других Hearth в сети (токен не раскрывается)');

    // смена токена
    const oldLink = v.link;
    r = await api('POST', '/api/relayhost/token');
    assert(r.j.running && r.j.link !== oldLink, 'ссылка сменилась');
    const c2 = new TunnelClient();
    c2.configure({ host: '127.0.0.1', port: 17420, token: relaydisc.parseLink(oldLink).token, name: 'old' });
    c2.add({ id: 'o1', proto: 'tcp', localPort: 17440 });
    c2.start();
    await wait(1500);
    assert(c2.status !== 'online', 'старый токен больше не работает');
    c2.stop();
    const c3 = new TunnelClient();
    c3.configure({ host: '127.0.0.1', port: 17420, token: relaydisc.parseLink(r.j.link).token, name: 'new' });
    c3.add({ id: 'n1', proto: 'tcp', localPort: 17440 });
    c3.start();
    await until(() => c3.status === 'online', 6000, 'новый токен работает');
    c3.stop();
    ok('новый токен: старая ссылка перестаёт работать, новая подключает');

    // релей упал: Hearth поднимает его снова
    const before = relayPids();
    assert(before.length >= 1);
    for (const pid of before) process.kill(pid);
    await until(async () => (await portOpen(17420)), 15000, 'релей перезапущен после падения');
    const after = await until(async () => {
      const x = (await api('GET', '/api/relayhost')).j;
      return x.running && x;
    }, 10000, 'релей снова в состоянии «работает»');
    assert(after.link.includes('203.0.113.7'), JSON.stringify(after));
    ok('релей упал: Hearth запустил его снова сам');

    // смена внешнего IP роутера: ссылка обновляется
    router.ext = router.web = '198.51.100.9';
    const nl = await until(async () => {
      const s = (await api('GET', '/api/relayhost')).j;
      return s.link.includes('198.51.100.9') && s;
    }, 8000, 'ссылка с новым внешним IP');
    assert(nl.link.includes(':17420?token='));
    router.ext = router.web = '203.0.113.7';
    await until(async () => (await api('GET', '/api/relayhost')).j.link.includes('203.0.113.7'), 8000, 'ссылка вернулась');
    ok('внешний IP сменился: ссылка-приглашение обновилась сама');

    // остановка: релей выключен, порты сняты
    r = await api('POST', '/api/relayhost/stop');
    assert(!r.j.running && !r.j.enabled);
    await until(async () => !(await portOpen(17420)), 5000, 'порт закрыт');
    assert.strictEqual(router.maps.size, 0, 'порты сняты с роутера: ' + [...router.maps.keys()].join());
    ok('«Остановить»: релей выключен, порты сняты с роутера');

    // серый адрес: релей для своей сети, порты не открываются
    router.ext = router.web = '100.64.8.8';
    r = await api('POST', '/api/relayhost/start');
    assert(r.j.running && r.j.verdict === 'cgnat' && /серый/.test(r.j.warning), JSON.stringify(r.j));
    assert.strictEqual(router.maps.size, 0, 'при CGNAT порты не открываем');
    assert(!r.j.link.includes('100.64.8.8'), 'ссылка без серого адреса: ' + r.j.link);
    await api('POST', '/api/relayhost/stop');
    ok('серый адрес (CGNAT): предупреждение, порты не открываются зря, ссылка для своей сети');

    // роутера с UPnP нет: ручной проброс
    router.ext = router.web = '203.0.113.7';
    router.up = false;
    r = await api('POST', '/api/relayhost/start');
    assert(r.j.running && r.j.verdict === 'manual' && /17420/.test(r.j.warning) && /17421/.test(r.j.warning), JSON.stringify(r.j));
    assert.strictEqual(router.maps.size, 0);
    ok('роутер без UPnP: релей работает, Hearth называет, какие порты пробросить вручную');
    await api('POST', '/api/relayhost/stop');
    router.up = true;

    // автозапуск и порядок выхода: релей включён, Hearth перезапускается, при выходе порты снимаются
    r = await api('POST', '/api/relayhost/start');
    assert(r.j.running && router.maps.size === 9, 'порты открыты: ' + router.maps.size);
    const kids = relayPids();
    assert(kids.length === 1, 'у агента один релей: ' + kids);
    await api('POST', '/api/quit');
    await until(() => !kids.some(alive) && router.maps.size === 0, 15000, 'при выходе Hearth релей остановлен и порты сняты');
    ok('выход из Hearth: релей остановлен, порты сняты с роутера');
    await wait(500);
    await startAgent();
    r = await until(async () => {
      const s = (await api('GET', '/api/relayhost')).j;
      return s.running && s;
    }, 15000, 'релей включился после перезапуска Hearth');
    assert(r.link.includes('203.0.113.7') && router.maps.size === 9);
    ok('релей был включён: после перезапуска Hearth поднимается сам, порты снова открыты');
  } catch (e) {
    fail = e;
  }
  try {
    await api('POST', '/api/quit');
  } catch {}
  await wait(1500);
  for (const pid of relayPids()) process.kill(pid);
  agent.kill();
  echo.close();
  if (fail) {
    console.log('FAIL', fail.stack || fail);
    process.exit(1);
  }
  console.log(`\nrelayhost: ${n} проверок пройдено`);
  process.exit(0);
})();
