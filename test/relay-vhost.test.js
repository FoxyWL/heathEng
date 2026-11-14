'use strict';
// Общий порт с именами: Minecraft Java, TLS (SNI), HTTP; неизвестное имя; клиент выбирает vhost сам
const { spawn } = require('child_process');
const net = require('net');
const tls = require('tls');
const path = require('path');
const { TunnelClient } = require('../agent/lib/tunnel');

const relay = spawn('node', [path.join(__dirname, '../relay/relay.js')], {
  env: { ...process.env, RELAY_TOKEN: 'tk', CONTROL_PORT: '17100', HTTP_PORT: '0', VHOST_PORT: '17101', RELAY_DOMAIN: '127-0-0-1.sslip.io', PUBLIC_HOST: '127.0.0.1', PORT_MIN: '32000', PORT_MAX: '32100', BIND: '127.0.0.1', DISCOVERY_PORT: '0' },
  stdio: 'inherit',
});
const res = [];
const ok = (n, c, x) => (res.push(!!c), console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const vi = (n) => {
  const o = [];
  do {
    let c = n & 0x7f;
    n >>>= 7;
    if (n) c |= 0x80;
    o.push(c);
  } while (n);
  return Buffer.from(o);
};
const str = (s) => Buffer.concat([vi(Buffer.byteLength(s)), Buffer.from(s)]);
const pkt = (id, body) => {
  const inner = Buffer.concat([vi(id), body]);
  return Buffer.concat([vi(inner.length), inner]);
};
const handshake = (host, next, port = 25565) => pkt(0, Buffer.concat([vi(765), str(host), Buffer.from([port >> 8, port & 255]), vi(next)]));

function talk(port, send, { until = 600, tlsName } = {}) {
  return new Promise((r) => {
    const chunks = [];
    const s = tlsName ? tls.connect({ port, host: '127.0.0.1', servername: tlsName, rejectUnauthorized: false }) : net.connect(port, '127.0.0.1');
    s.on(tlsName ? 'secureConnect' : 'connect', () => send(s));
    s.on('data', (d) => chunks.push(d));
    s.on('error', () => {});
    s.on('close', () => r(Buffer.concat(chunks)));
    setTimeout(() => (s.destroy(), r(Buffer.concat(chunks))), until);
  });
}

async function main() {
  await wait(800);
  // «Игровой сервер»: отвечает, какое рукопожатие получил
  const seen = [];
  net.createServer((s) => s.on('data', (d) => (seen.push(d), s.write('GAME:' + d.length)))).listen(15101, '127.0.0.1');
  // «Сайт»: TLS на стороне хозяина (релей TLS не расшифровывает)
  const { execSync } = require('child_process');
  let tlsOk = true;
  let cert;
  try {
    const dir = require('fs').mkdtempSync(require('os').tmpdir() + '/vh-');
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/k.pem -out ${dir}/c.pem -days 1 -subj /CN=x 2>/dev/null`);
    cert = { key: require('fs').readFileSync(dir + '/k.pem'), cert: require('fs').readFileSync(dir + '/c.pem') };
  } catch {
    tlsOk = false;
  }
  if (tlsOk) tls.createServer(cert, (s) => (s.on('data', () => s.end('SECURE-HELLO')), s.on('error', () => {}))).listen(15102, '127.0.0.1');

  const c = new TunnelClient();
  c.configure({ host: '127.0.0.1', port: 17100, token: 'tk', name: 't' });
  c.add({ id: 'mc', proto: 'tcp', prefer: 'vhost', localPort: 15101, subdomain: 'popka' });
  c.add({ id: 'mc2', proto: 'tcp', prefer: 'vhost', localPort: 15101, subdomain: 'popka', hint: true }); // имя занято своим же клиентом: тот же клиент перезаписывает
  c.add({ id: 'web', proto: 'vhost', localPort: tlsOk ? 15102 : 15101, subdomain: 'shop' });
  c.add({ id: 'site', proto: 'vhost', localPort: 15101, subdomain: 'site' });
  c.add({ id: 'raw', proto: 'tcp', localPort: 15101 }); // игра без имён: обычный порт
  c.start();
  await wait(1200);
  const L = Object.fromEntries(c.list().map((t) => [t.id, t]));
  ok('relay told its domain and vhost port', c.info.vhostPort === 17101 && c.info.domain === '127-0-0-1.sslip.io', JSON.stringify(c.info));
  ok('mc via vhost', L.mc.via === 'vhost' && L.mc.info && L.mc.info.url === 'popka.127-0-0-1.sslip.io:17101', JSON.stringify(L.mc.info));
  ok('plain tcp keeps its own port', L.raw.via === 'tcp' && L.raw.info && L.raw.info.port >= 32000 && L.raw.info.port <= 32100);

  // Minecraft: рукопожатие с нашим именем доходит до игры без изменений
  seen.length = 0;
  const hs = handshake('popka.127-0-0-1.sslip.io', 2);
  const a = await talk(17101, (s) => s.write(Buffer.concat([hs, pkt(0, str('Steve'))])));
  ok('mc login routed by name', a.toString().startsWith('GAME:') && seen[0] && seen[0].subarray(0, hs.length).equals(hs));
  const forge = await talk(17101, (s) => s.write(handshake('popka.127-0-0-1.sslip.io\0FML\0', 2)));
  ok('forge marker after NUL ignored', forge.toString().startsWith('GAME:'));
  const caps = await talk(17101, (s) => s.write(handshake('POPKA.127-0-0-1.SSLIP.IO.', 2)));
  ok('case and trailing dot ignored', caps.toString().startsWith('GAME:'));
  const split = await talk(17101, (s) => {
    s.write(hs.subarray(0, 5));
    setTimeout(() => s.write(hs.subarray(5)), 150);
  });
  ok('handshake split in two packets', split.toString().startsWith('GAME:'));

  // неизвестное имя: список серверов Minecraft получает понятное сообщение, вход — отключение с текстом
  const st = await talk(17101, (s) => s.write(Buffer.concat([handshake('nobody.127-0-0-1.sslip.io', 1), pkt(0, Buffer.alloc(0))])));
  ok('unknown name in server list says so', st.toString('utf8').includes('не найден') && st.toString().includes('"description"'));
  const ping = await talk(17101, (s) => s.write(Buffer.concat([handshake('nobody.127-0-0-1.sslip.io', 1), pkt(0, Buffer.alloc(0)), Buffer.from([9, 1, 0, 0, 0, 0, 0, 0, 0, 7])])));
  ok('ping echoed for unknown name', ping.subarray(ping.length - 10).equals(Buffer.from([9, 1, 0, 0, 0, 0, 0, 0, 0, 7])));
  const dis = await talk(17101, (s) => s.write(Buffer.concat([handshake('nobody.127-0-0-1.sslip.io', 2), pkt(0, str('Steve'))])));
  ok('unknown name on login is disconnected with text', dis.toString('utf8').includes('не найден'));
  const wrong = await talk(17101, (s) => s.write(handshake('other.example.org', 2)));
  ok('foreign hostname is not routed', wrong.toString('utf8').includes('не найден') && !wrong.toString().startsWith('GAME:'));

  // мусор и тишина не вешают порт
  const junk = await talk(17101, (s) => s.write(Buffer.from([0xff, 0xfe, 0x00, 0x01])), { until: 500 });
  ok('garbage closed', junk.length === 0);

  // HTTP по Host
  const http = await talk(17101, (s) => s.write('GET / HTTP/1.1\r\nHost: site.127-0-0-1.sslip.io\r\n\r\n'));
  ok('http routed by Host', http.toString().startsWith('GAME:'));
  const http404 = await talk(17101, (s) => s.write('GET / HTTP/1.1\r\nHost: nope.127-0-0-1.sslip.io\r\n\r\n'));
  ok('http unknown host → 404', http404.toString().includes('404'));
  const disc = await talk(17101, (s) => s.write('GET /.well-known/hearth-relay HTTP/1.1\r\nHost: x\r\n\r\n'));
  ok('shared port answers relay discovery', disc.toString().includes('"vhostPort":17101'));

  // TLS: SNI читается, расшифровки нет — сертификат остаётся у хозяина
  if (tlsOk) {
    const sec = await talk(17101, (s) => s.write('hi'), { tlsName: 'shop.127-0-0-1.sslip.io' });
    ok('TLS routed by SNI, end-to-end', sec.toString().includes('SECURE-HELLO'));
    const nosni = await talk(17101, (s) => s.write('hi'), { tlsName: 'nothing.127-0-0-1.sslip.io', until: 800 });
    ok('TLS unknown name is just closed', nosni.length === 0);
  }

  // клиент отключился — имя освобождается
  c.remove('mc');
  c.remove('mc2');
  await wait(300);
  const gone = await talk(17101, (s) => s.write(handshake('popka.127-0-0-1.sslip.io', 2)));
  ok('name released after tunnel removed', gone.toString('utf8').includes('не найден'));

  // релей без общего порта: клиент остаётся на обычном TCP
  c.stop();
  relay.kill();
  await wait(300);
  const r2 = spawn('node', [path.join(__dirname, '../relay/relay.js')], { env: { ...process.env, RELAY_TOKEN: 'tk', CONTROL_PORT: '17102', HTTP_PORT: '0', RELAY_DOMAIN: 'x.test', PUBLIC_HOST: '127.0.0.1', PORT_MIN: '32200', PORT_MAX: '32300', BIND: '127.0.0.1', DISCOVERY_PORT: '0' }, stdio: 'inherit' });
  await wait(800);
  const c2 = new TunnelClient();
  c2.configure({ host: '127.0.0.1', port: 17102, token: 'tk', name: 't2' });
  c2.add({ id: 'mc', proto: 'tcp', prefer: 'vhost', localPort: 15101, subdomain: 'popka' });
  c2.add({ id: 'w', proto: 'vhost', localPort: 15101, subdomain: 'w' });
  c2.start();
  await wait(1000);
  const M = Object.fromEntries(c2.list().map((t) => [t.id, t]));
  ok('no vhost on relay: server falls back to plain tcp', M.mc.via === 'tcp' && M.mc.info && M.mc.info.port >= 32200);
  ok('explicit vhost without support gives a clear error', /общего порта/.test(M.w.error));
  c2.stop();
  r2.kill();
  const bad = res.filter((x) => !x).length;
  console.log(`\n${res.length - bad}/${res.length} passed`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => (console.error(e), relay.kill(), process.exit(1)));
