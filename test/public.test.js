'use strict';
// Публичный адрес без ручной настройки: UPnP (поддельный роутер с SSDP и SOAP), внешний IP, CGNAT, продление и снятие портов.
const { spawn } = require('child_process');
const assert = require('assert');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

let n = 0;
const ok = (m) => console.log('  ✓', m, `(${++n})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.join(__dirname, '..');

// ---- поддельный роутер
const router = { ext: '203.0.113.7', permanentOnly: false, maps: new Map(), web: '203.0.113.7', log: [] };
const igd = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.url === '/desc.xml') {
      res.writeHead(200, { 'content-type': 'text/xml' });
      return res.end('<root><device><friendlyName>Fake Router</friendlyName><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl</controlURL></service></serviceList></device></root>');
    }
    if (req.url === '/ip') {
      res.writeHead(200);
      return res.end(router.web);
    }
    const act = /#(\w+)"/.exec(req.headers.soapaction || '')[1];
    const arg = (k) => (new RegExp(`<${k}>([^<]*)</${k}>`).exec(body) || [])[1];
    const err = (code, d) => {
      res.writeHead(500, { 'content-type': 'text/xml' });
      res.end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode><errorDescription>${d}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
    };
    router.log.push(act);
    const ok200 = (x = '') => {
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(`<s:Envelope><s:Body>${x}</s:Body></s:Envelope>`);
    };
    if (act === 'GetExternalIPAddress') return ok200(`<u:GetExternalIPAddressResponse><NewExternalIPAddress>${router.ext}</NewExternalIPAddress></u:GetExternalIPAddressResponse>`);
    if (act === 'AddPortMapping') {
      if (router.permanentOnly && arg('NewLeaseDuration') !== '0') return err(725, 'OnlyPermanentLeasesSupported');
      router.maps.set(`${arg('NewExternalPort')}/${arg('NewProtocol')}`, { internal: arg('NewInternalClient'), lease: arg('NewLeaseDuration'), desc: arg('NewPortMappingDescription') });
      return ok200();
    }
    if (act === 'DeletePortMapping') {
      router.maps.delete(`${arg('NewExternalPort')}/${arg('NewProtocol')}`);
      return ok200();
    }
    err(401, 'Invalid Action');
  });
});
const ssdp = dgram.createSocket('udp4');
ssdp.on('message', (m, r) => {
  if (/M-SEARCH/.test(m.toString())) ssdp.send(`HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:17400/desc.xml\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n`, r.port, r.address);
});

(async () => {
  await new Promise((r) => igd.listen(17400, '127.0.0.1', r));
  await new Promise((r) => ssdp.bind(17401, '127.0.0.1', r));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-pub-'));
  const agent = spawn('node', [path.join(root, 'main.js')], { env: { ...process.env, DATA_DIR: data, PORT: '17402', NO_BROWSER: '1', HEARTH_NO_OPEN: '1', HEARTH_SSDP_TARGET: '127.0.0.1:17401', HEARTH_IPCHECK_URL: 'http://127.0.0.1:17400/ip', HEARTH_PUBLIC_RENEW_MS: '400', HEARTH_RELAY_AUTO: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  agent.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 60 && !/token=/.test(out); i++) await wait(100);
  const token = /token=([0-9a-f]+)/.exec(out)[1];
  const api = async (m, u, body) => {
    const r = await fetch('http://127.0.0.1:17402' + u, { method: m, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
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
  try {
    const sv = (await api('POST', '/api/servers', { game: 'custom', name: 'Pub', command: 'node -e 0', settings: { port: 17410 } })).j;

    let c = (await api('GET', '/api/public')).j;
    assert(c.verdict === 'upnp' && c.gateway.name === 'Fake Router' && c.gateway.externalIp === '203.0.113.7' && c.ip === '203.0.113.7', JSON.stringify(c));
    ok('роутер найден по SSDP сам, внешний IP 203.0.113.7: порты можно открыть кнопкой (verdict upnp)');

    const lan = (await api('GET', '/api/network')).j.addresses.find((a) => a.primary);
    let r = await api('POST', `/api/servers/${sv.id}/public`, { enabled: true });
    assert(r.s === 200 && r.j.publicIp.enabled && r.j.publicIp.ext === '203.0.113.7', JSON.stringify(r.j.publicIp));
    const m = router.maps.get('17410/TCP');
    assert(m && m.internal === lan.ip && m.lease === '3600' && /Hearth: Pub/.test(m.desc), JSON.stringify([...router.maps]));
    ok('порт 17410/TCP открыт на роутере на адрес ПК, аренда 1 час, в описании имя сервера');

    router.maps.clear(); // роутер перезагрузился и забыл проброс
    await until(() => router.maps.has('17410/TCP'), 5000, 'проброс восстановлен');
    ok('роутер перезагрузился и забыл порты: Hearth переоткрыл их сам при продлении');

    router.ext = '203.0.113.99';
    router.web = '203.0.113.99';
    await until(async () => (await api('GET', `/api/servers/${sv.id}`)).j.publicIp.ext === '203.0.113.99', 5000, 'внешний IP обновился');
    ok('провайдер сменил внешний IP: адрес сервера обновился сам');

    r = await api('POST', `/api/servers/${sv.id}/public`, { enabled: false });
    assert(r.s === 200 && !r.j.publicIp.enabled && !router.maps.has('17410/TCP'));
    ok('«Закрыть»: порт снят с роутера, сервер снова только в сети');

    router.permanentOnly = true;
    r = await api('POST', `/api/servers/${sv.id}/public`, { enabled: true });
    assert(r.s === 200 && router.maps.get('17410/TCP').lease === '0' && r.j.publicIp.ports[0].lease === 0);
    ok('роутер принимает только бессрочные проброски: Hearth повторил запрос с бессрочной арендой');
    router.permanentOnly = false;

    // удаление сервера снимает проброс
    await api('DELETE', `/api/servers/${sv.id}?files=1`);
    assert(!router.maps.has('17410/TCP'));
    ok('удаление сервера снимает порты с роутера');

    // CGNAT: у роутера «серый» адрес
    const sv2 = (await api('POST', '/api/servers', { game: 'custom', name: 'Gray', command: 'node -e 0', settings: { port: 17411 } })).j;
    router.ext = '100.64.8.1';
    router.web = '198.51.100.20';
    c = (await api('GET', '/api/public')).j;
    assert.strictEqual(c.verdict, 'cgnat');
    r = await api('POST', `/api/servers/${sv2.id}/public`, { enabled: true });
    assert(r.s === 409 && /CGNAT|серый/.test(r.j.error) && /туннель/i.test(r.j.error) && !router.maps.size, JSON.stringify(r.j));
    ok('«серый» адрес (CGNAT) определён, порты не открываются зря, предложен туннель');

    // второй NAT провайдера: адрес роутера белый, но из интернета виден другой
    router.ext = '203.0.113.50';
    router.web = '198.51.100.77';
    assert.strictEqual((await api('GET', '/api/public')).j.verdict, 'cgnat');
    ok('второй NAT у провайдера (адрес у роутера и из интернета разные) определён как CGNAT');

    // роутера нет
    ssdp.close();
    router.web = '203.0.113.7';
    c = (await api('GET', '/api/public')).j;
    assert(c.verdict === 'manual' && c.gateway === null && c.ip === '203.0.113.7', JSON.stringify(c));
    r = await api('POST', `/api/servers/${sv2.id}/public`, { enabled: true });
    assert(r.s === 502 && /UPnP/.test(r.j.error));
    ok('роутер без UPnP: внешний IP известен (verdict manual), понятный совет вместо молчания');
    console.log(`\npublic: ${n} проверок пройдено`);
    agent.kill();
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e);
    agent.kill();
    process.exit(1);
  }
})();
