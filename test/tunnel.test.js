'use strict';
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const dgram = require('dgram');
const path = require('path');
const { TunnelClient } = require('../agent/lib/tunnel');

const TOKEN = 'testtoken';
const relay = spawn('node', [path.join(__dirname, '../relay/relay.js')], {
  env: {
    ...process.env,
    RELAY_TOKEN: TOKEN,
    CONTROL_PORT: '17000',
    HTTP_PORT: '18080',
    RELAY_DOMAIN: 'tun.test',
    PUBLIC_HOST: '127.0.0.1',
    PORT_MIN: '31000',
    PORT_MAX: '31200',
    BIND: '127.0.0.1',
  },
  stdio: 'inherit',
});

const results = [];
const ok = (n, c, extra) => {
  results.push(c);
  console.log((c ? 'PASS ' : 'FAIL ') + n + (extra ? ' ' + extra : ''));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await wait(700);
  net.createServer((s) => s.on('data', (d) => s.write('echo:' + d))).listen(15001, '127.0.0.1');
  http.createServer((q, r) => r.end('hello ' + q.headers.host)).listen(15002, '127.0.0.1');
  const udpEcho = dgram.createSocket('udp4');
  udpEcho.on('message', (m, i) => udpEcho.send(Buffer.from('udp:' + m), i.port, i.address));
  udpEcho.bind(15003, '127.0.0.1');

  const c = new TunnelClient();
  c.configure({ host: '127.0.0.1', port: 17000, token: TOKEN, name: 'test' });
  c.add({ id: 't1', proto: 'tcp', localPort: 15001 });
  c.add({ id: 't2', proto: 'http', localPort: 15002, subdomain: 'demo' });
  c.add({ id: 't3', proto: 'udp', localPort: 15003 });
  c.start();
  await wait(1200);
  const list = c.list();
  console.log(JSON.stringify(list.map((t) => t.info)));
  ok('client online', c.status === 'online');
  ok('all tunnels have address', list.every((t) => t.info));

  const tcp = list.find((t) => t.id === 't1').info;
  const reply = await new Promise((res) => {
    const s = net.connect(tcp.port, '127.0.0.1', () => s.write('ping'));
    s.on('data', (d) => {
      res(d.toString());
      s.destroy();
    });
    s.on('error', () => res('err'));
  });
  ok('tcp through tunnel', reply === 'echo:ping', reply);

  const body = await new Promise((res) => {
    http.get({ host: '127.0.0.1', port: 18080, agent: false, headers: { Host: 'demo.tun.test' } }, (r) => {
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => res(b));
    }).on('error', () => res('err'));
  });
  ok('http by subdomain', body === 'hello demo.tun.test', body);

  const nf = await new Promise((res) => {
    http.get({ host: '127.0.0.1', port: 18080, agent: false, headers: { Host: 'nope.tun.test' } }, (r) => {
      r.resume();
      res(r.statusCode);
    });
  });
  ok('unknown subdomain gives 404', nf === 404, String(nf));

  const udp = list.find((t) => t.id === 't3').info;
  const uReply = await new Promise((res) => {
    const s = dgram.createSocket('udp4');
    s.on('message', (m) => {
      res(m.toString());
      s.close();
    });
    s.send(Buffer.from('hi'), udp.port, '127.0.0.1');
    setTimeout(() => res('timeout'), 2000);
  });
  ok('udp through tunnel', uReply === 'udp:hi', uReply);

  relay.kill();
  await wait(300);
  ok('client notices relay drop', c.status !== 'online', c.status);
  c.stop();
  process.exit(results.every(Boolean) ? 0 : 1);
}
main();
