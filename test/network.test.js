'use strict';
// Имя вместо IP и сетевой доступ: кодек, адреса ПК, проверка, что сервер слушает на адресе в сети, брандмауэр, hosts.
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ipToName, nameToIp, fqdn } = require('../agent/lib/netname');
const na = require('../agent/lib/netaccess');

let n = 0;
const ok = (m) => console.log('  ✓', m, `(${++n})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.join(__dirname, '..');
const PORT = '17160';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-net-'));
const listen = path.join(dir, 'listen.js');
fs.writeFileSync(listen, "const net=require('net');net.createServer((s)=>s.end()).listen(+process.argv[2],process.argv[3],()=>console.log('listening'));setInterval(()=>{},1000);");

(async () => {
  // ---- кодек
  const rnd = () => Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)).join('.');
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const ip = rnd();
    const name = ipToName(ip);
    assert(/^[a-z]+-[a-z]+$/.test(name) && name.length <= 24, name);
    assert.strictEqual(nameToIp(name), ip);
    assert.strictEqual(nameToIp(name + '.hearth'), ip);
    assert.strictEqual(nameToIp(name.toUpperCase() + '.HEARTH'), ip);
    seen.add(name);
  }
  for (const ip of ['0.0.0.0', '255.255.255.255', '192.168.0.1', '10.0.0.1', '127.0.0.1']) assert.strictEqual(nameToIp(ipToName(ip)), ip);
  assert(seen.size > 2990, 'имена почти не повторяются у разных адресов');
  ok('кодек: 3000 случайных адресов туда и обратно, имена короткие и из букв, регистр и суффикс .hearth не мешают');

  let caught = 0;
  let total = 0;
  const alpha = 'bdfghjklmnprstvz';
  for (let i = 0; i < 400; i++) {
    const name = ipToName(rnd());
    const at = Math.floor(Math.random() * name.length);
    if (name[at] === '-') continue;
    const pool = alpha.includes(name[at]) ? alpha : 'aeiou';
    const to = pool[Math.floor(Math.random() * pool.length)];
    if (to === name[at]) continue;
    total++;
    try {
      nameToIp(name.slice(0, at) + to + name.slice(at + 1));
    } catch {
      caught++;
    }
  }
  assert(caught / total > 0.99, `опечатки: поймано ${caught} из ${total}`);
  ok(`опечатки в имени ловятся контрольной суммой (${Math.round((caught / total) * 100)}%)`);

  for (const bad of ['', 'abc', 'kabeno', 'kabeno-zu', 'kabeno-zulifaz', 'qabeno-zuli', 'kaaeno-zuli', 'kabeno zuli']) assert.throws(() => nameToIp(bad), bad);
  assert.throws(() => ipToName('300.1.1.1'));
  assert.throws(() => ipToName('1.2.3'));
  ok('мусорные имена и неверные адреса отклоняются понятной ошибкой');

  // ---- сетевые адреса и правила (без запуска приложения)
  const addrs = na.addresses();
  assert(addrs.every((a) => a.fqdn === fqdn(a.ip) && /^\d+\.\d+\.\d+\.\d+$/.test(a.ip)));
  assert(addrs.filter((a) => a.primary).length <= 1);
  assert.strictEqual(na.kindOf('192.168.1.5'), 'private');
  assert.strictEqual(na.kindOf('10.1.2.3'), 'private');
  assert.strictEqual(na.kindOf('172.20.0.1'), 'private');
  assert.strictEqual(na.kindOf('172.32.0.1'), 'public');
  assert.strictEqual(na.kindOf('100.64.0.1'), 'cgnat');
  assert.strictEqual(na.kindOf('169.254.1.1'), 'linklocal');
  assert.strictEqual(na.kindOf('8.8.8.8'), 'public');
  ok('адреса ПК: тип сети определяется верно (домашняя, CGNAT, link-local, внешняя)');

  const rules = na.firewallRules('My "Evil"; calc & srv', [{ port: 25565, proto: 'tcp' }, { port: 27015, proto: 'udp' }, { port: 80, proto: 'http' }]);
  assert.strictEqual(rules.length, 2, 'HTTP-порты правил не получают');
  for (const r of rules) {
    assert(!/["';&|]/.test(r.name.replace(/^Hearth: /, '').replace(/ \((TCP|UDP) \d+\)$/, '')), 'имя правила очищено: ' + r.name);
    assert(/^netsh advfirewall firewall add rule name="[^"]+" dir=in action=allow protocol=(TCP|UDP) localport=\d+ profile=any$/.test(na.netshAdd(r)), na.netshAdd(r));
  }
  assert(/delete rule name="Hearth: /.test(na.netshDel(rules[0])));
  const script = ['a b', "c 'd'"];
  const enc = /'-EncodedCommand','([^']+)'/.exec(na.elevatedCommand(script))[1];
  assert.strictEqual(Buffer.from(enc, 'base64').toString('utf16le'), script.join('; '));
  assert(/-Verb RunAs/.test(na.elevatedCommand(script)));
  ok('брандмауэр: имя правила очищается от кавычек и служебных знаков, команды netsh и запуск от администратора собираются верно');

  // ---- приложение
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-netdata-'));
  const agent = spawn('node', [path.join(root, 'main.js')], { env: { ...process.env, DATA_DIR: data, PORT, NO_BROWSER: '1', HEARTH_NO_OPEN: '1', HEARTH_STATS_MS: '500' }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  agent.stdout.on('data', (d) => (out += d));
  const api = async (method, p, body) => {
    const token = /token=([0-9a-f]+)/.exec(out)[1];
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
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
    await until(() => /token=/.test(out), 8000, 'запуск');
    const net = (await api('GET', '/api/network')).j;
    assert.strictEqual(net.suffix, 'hearth');
    assert(net.addresses.length >= 1, 'есть адрес в сети');
    const lan = net.addresses.find((a) => a.primary);
    assert(lan && lan.fqdn === fqdn(lan.ip));
    ok(`GET /api/network: ${lan.ip} → ${lan.fqdn}`);

    const rv = (await api('GET', '/api/network/resolve?name=' + encodeURIComponent(lan.fqdn))).j;
    assert.strictEqual(rv.ip, lan.ip);
    assert.strictEqual((await api('GET', '/api/network/resolve?name=nonsense')).s, 400);
    ok('имя расшифровывается обратно в IP, мусор даёт 400');

    const mk = async (name, port, host, proto = 'tcp') => (await api('POST', '/api/servers', { game: 'custom', name, command: `node "${listen}" ${port} ${host}`, settings: { port, protocol: proto } })).j;
    const A = await mk('Open', 17161, '0.0.0.0');
    const B = await mk('Local', 17162, '127.0.0.1');
    const C = await mk('Game UDP', 17163, '0.0.0.0', 'udp');
    const D = await mk('Idle', 17164, '0.0.0.0');
    for (const s of [A, B, C]) assert.strictEqual((await api('POST', `/api/servers/${s.id}/start`)).s, 200);
    await until(async () => (await api('GET', '/api/servers')).j.filter((s) => s.state === 'running').length === 3, 15000, 'три сервера запущены');
    await wait(800);

    const rA = (await api('GET', `/api/servers/${A.id}/reach`)).j;
    assert.strictEqual(rA.ports[0].status, 'ok', JSON.stringify(rA));
    assert.strictEqual(rA.ports[0].loopback, true);
    assert.strictEqual(rA.ports[0].lan, true);
    assert.strictEqual(rA.primary.ip, lan.ip);
    ok('сервер на 0.0.0.0 доступен и по 127.0.0.1, и по адресу ПК в сети');

    const rB = (await api('GET', `/api/servers/${B.id}/reach`)).j;
    assert.strictEqual(rB.ports[0].status, 'loopback-only', JSON.stringify(rB));
    assert.strictEqual(rB.ports[0].loopback, true);
    assert.strictEqual(rB.ports[0].lan, false);
    ok('сервер, слушающий только 127.0.0.1, определяется: друзья его не увидят');

    assert.strictEqual((await api('GET', `/api/servers/${C.id}/reach`)).j.ports[0].status, 'udp');
    assert.strictEqual((await api('GET', `/api/servers/${D.id}/reach`)).j.ports[0].status, 'stopped');
    await api('POST', `/api/servers/${A.id}/kill`);
    await until(async () => (await api('GET', `/api/servers/${A.id}`)).j.state !== 'running', 10000, 'A остановлен');
    assert.strictEqual((await api('GET', `/api/servers/${A.id}/reach`)).j.ports[0].status, 'stopped');
    ok('UDP-порты честно помечены «проверить нельзя», остановленные серверы не проверяются');

    const fw = (await api('POST', `/api/servers/${A.id}/firewall`, { action: 'open' })).j;
    assert.strictEqual(fw.executed, false);
    assert(fw.commands.includes('ufw allow 17161/tcp') && /Hearth: Open \(TCP 17161\)/.test(fw.rules[0]), JSON.stringify(fw));
    assert(/delete allow/.test((await api('POST', `/api/servers/${A.id}/firewall`, { action: 'close' })).j.commands[0]));
    ok('брандмауэр на не-Windows: команды возвращаются для ручного запуска, ничего не выполняется');

    const hs = (await api('POST', '/api/network/hosts', { ip: lan.ip, action: 'add' })).j;
    assert.strictEqual(hs.fqdn, lan.fqdn);
    assert(hs.line.startsWith(lan.ip + ' ' + lan.fqdn));
    for (const bad of ['127.0.0.1', '0.0.0.0', 'abc', '1.2.3']) assert.strictEqual((await api('POST', '/api/network/hosts', { ip: bad })).s, 400, bad);
    ok('hosts: строка собирается верно, loopback и мусор отклоняются');

    // ---- своё имя сервера: всем .hearth, свои зоны только в бете (администратор)
    const SA = (await api('POST', '/api/servers', { game: 'custom', name: 'A', settings: { command: 'node -e 0', port: 15701 } })).j;
    const SB = (await api('POST', '/api/servers', { game: 'custom', name: 'B', settings: { command: 'node -e 0', port: 15702 } })).j;
    assert.strictEqual(SA.netName, '');
    let r = await api('PUT', `/api/servers/${SA.id}/netname`, { name: 'SoskaCraft' });
    assert(r.s === 200 && r.j.host === 'soskacraft.hearth', JSON.stringify(r.j));
    r = await api('PUT', `/api/servers/${SB.id}/netname`, { name: 'soskacraft.hearth' });
    assert.strictEqual(r.s, 409, 'имя занято');
    r = await api('PUT', `/api/servers/${SB.id}/netname`, { name: 'bcraft:15701' });
    assert.strictEqual(r.s, 409, 'порт занят другим сервером');
    ok('своё имя: слово получает .hearth и в нижнем регистре, занятые имя и порт отклоняются');
    await api('PUT', '/api/beta', { anyZone: false });
    r = await api('PUT', `/api/servers/${SB.id}/netname`, { name: 'bcraft.mc' });
    assert(r.s === 400 && /администратор/.test(r.j.error || JSON.stringify(r.j)), JSON.stringify(r.j));
    r = await api('POST', '/api/network/hosts', { ip: lan.ip, action: 'add', name: 'bcraft.mc' });
    assert.strictEqual(r.s, 400, 'hosts тоже не принимает чужую зону');
    ok('обычный пользователь: зона .mc отклонена, и в имени, и в hosts');
    await api('PUT', '/api/beta', { anyZone: true });
    r = await api('PUT', `/api/servers/${SB.id}/netname`, { name: 'bcraft.mc:15720' });
    assert(r.s === 200 && r.j.host === 'bcraft.mc' && r.j.settings.port === 15720 && !r.j.restartRequired, JSON.stringify(r.j));
    assert.strictEqual((await api('GET', '/api/servers')).j.find((x) => x.id === SB.id).ports[0].port, 15720);
    for (const bad of ['bcraft.com', 'a b.mc', '1.2.3.4', 'x.mc:0', 'x.mc:70000', 'x.mc:', 'https://x.mc']) assert.strictEqual((await api('PUT', `/api/servers/${SB.id}/netname`, { name: bad })).s, 400, bad);
    ok('бета (администратор): bcraft.mc:15720 принято, порт сервера сменился, настоящие зоны и мусор отклонены');
    r = await api('POST', '/api/network/hosts', { ip: lan.ip, action: 'add', name: 'bcraft.mc' });
    assert(r.s === 200 && r.j.line === `${lan.ip} bcraft.mc # Hearth`, JSON.stringify(r.j));
    ok('hosts: строка для своего имени собирается с этим именем');
    r = await api('PUT', `/api/servers/${SB.id}/netname`, { name: '' });
    assert(r.s === 200 && r.j.netName === '');
    ok('пустое имя возвращает автоимя');
    await until(() => {
      try {
        const x = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).servers.find((v) => v.id === SA.id);
        return x && x.netName === 'soskacraft.hearth';
      } catch {
        return false;
      }
    }, 5000, 'имя записано в state.json');
    ok('своё имя сохраняется в state.json');
    agent.kill();
    console.log(`\nnetwork: ${n} проверок пройдено`);
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e);
    agent.kill();
    process.exit(1);
  }
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
