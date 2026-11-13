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
fs.writeFileSync(listen, "const net=require('net');net.createServer((s)=>{s.on('error',()=>{});s.end()}).listen(+process.argv[2],process.argv[3],()=>console.log('listening'));setInterval(()=>{},1000);");

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

  // ---- поддержание сети: смена IP, недоступный сервер, hosts
  {
    const { NetWatch } = require('../agent/lib/netwatch');
    const events = [];
    const logs = [];
    let ip = '10.0.0.5';
    let status = 'ok';
    let up = true;
    const server = { id: 's1', name: 'Test', game: 'custom', settings: { port: 17999 } };
    const store = { config: { net: { lastIp: '' } }, state: { servers: [server] }, saveConfig() {} };
    const mgr = { view: () => ({ state: 'running', startedAt: Date.now() - 60000 }), _log: (sv, k, t) => logs.push([k, t]) };
    const w = new NetWatch({ mgr, emit: (t, e) => events.push(e), store, graceMs: 0, addrFn: () => (up ? [{ ip, fqdn: fqdn(ip), primary: true }] : []), reachFn: async () => ({ ports: [{ port: 17999, proto: 'tcp', status }] }) });
    w.checkIp();
    assert.strictEqual(store.config.net.lastIp, '10.0.0.5');
    assert.strictEqual(events.length, 0, 'первая запись IP не событие');
    ip = '10.0.0.77';
    w.checkIp();
    assert(events.length === 1 && events[0].type === 'ip-changed' && events[0].from === '10.0.0.5' && events[0].fqdn === fqdn('10.0.0.77'), JSON.stringify(events));
    assert(logs.some(([k, t]) => k === 'err' && /IP этого ПК изменился/.test(t)), 'в консоль сервера записано предупреждение');
    ok('смена IP: событие ip-changed, предупреждение в консоли запущенного сервера');
    up = false;
    w.checkIp();
    w.checkIp();
    up = true;
    w.checkIp();
    assert.deepStrictEqual(events.slice(1).map((e) => e.type), ['offline', 'online'], 'offline один раз, затем online');
    ok('потеря и возврат сети: по одному событию');
    status = 'loopback-only';
    await w.checkServers();
    await w.checkServers();
    assert(!events.some((e) => e.type === 'unreachable'), 'две проверки ещё не повод');
    await w.checkServers();
    await w.checkServers();
    assert.strictEqual(events.filter((e) => e.type === 'unreachable').length, 1, 'предупреждение приходит один раз');
    status = 'ok';
    await w.checkServers();
    assert.strictEqual(events[events.length - 1].type, 'recovered');
    ok('недоступный в сети сервер: предупреждение после 3 проверок (один раз), затем «снова доступен»');

    const hf = path.join(dir, 'hosts');
    fs.writeFileSync(hf, '127.0.0.1 localhost\n10.0.0.5 old.hearth # Hearth\n10.0.0.77 soska.hearth # Hearth\n10.0.0.9 other.example\n');
    const ent = na.readHosts(hf);
    assert.strictEqual(ent.size, 2, 'берутся только строки Hearth');
    assert.strictEqual(na.hostsState('soska.hearth', '10.0.0.77', ent), 'ok');
    assert.strictEqual(na.hostsState('old.hearth', '10.0.0.77', ent), 'stale');
    assert.strictEqual(na.hostsState('nope.hearth', '10.0.0.77', ent), 'missing');
    assert.strictEqual(na.readHosts(path.join(dir, 'нет-такого')).size, 0);
    const st = require('../agent/lib/startup');
    assert(/^".*" --startup$/.test(st.command()));
    assert.deepStrictEqual(await st.status(), { supported: false, enabled: false });
    ok('hosts: состояния ok / stale / missing, чужие строки не трогаются; автозапуск вне Windows честно «не поддерживается»');
  }

  // ---- приоритеты адресов: проводная сеть, Wi-Fi, виртуальные и VPN в конце, закреплённый адрес первым
  {
    const mk = (ip, iface, virtual = false) => ({ ip, iface, kind: na.kindOf(ip), virtual });
    const list = () => [mk('172.20.0.1', 'vEthernet (WSL)', true), mk('192.168.1.40', 'Wi-Fi'), mk('100.64.3.3', 'Ethernet'), mk('192.168.1.10', 'Ethernet'), mk('10.8.0.2', 'NordLynx VPN', true), mk('169.254.5.5', 'Ethernet 2')];
    let r = na.rankAddresses(list());
    assert.deepStrictEqual(r.map((x) => x.ip), ['192.168.1.10', '100.64.3.3', '169.254.5.5', '192.168.1.40', '172.20.0.1', '10.8.0.2'], r.map((x) => x.ip).join(' '));
    assert(r[0].primary && r.filter((x) => x.primary).length === 1);
    r = na.rankAddresses(list(), '192.168.1.40');
    assert(r[0].ip === '192.168.1.40' && r[0].pinned && r.filter((x) => x.primary).length === 1);
    r = na.rankAddresses(list(), '8.8.8.8');
    assert(r[0].ip === '192.168.1.10' && !r[0].pinned, 'закреплённого адреса уже нет: автовыбор');
    ok('приоритет адресов: проводная сеть → Wi-Fi → виртуальные и VPN; адрес провайдера (CGNAT) ниже домашнего; закреплённый всегда первый');
  }

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

    const pinList = (await api('GET', '/api/network')).j.addresses;
    assert.strictEqual((await api('PUT', '/api/network/preferred', { ip: '8.8.4.4' })).s, 400);
    assert.strictEqual((await api('PUT', '/api/network/preferred', { ip: pinList[0].ip })).j.preferred, pinList[0].ip);
    const pinned = (await api('GET', '/api/network')).j;
    assert(pinned.preferred === pinList[0].ip && pinned.addresses[0].pinned);
    await api('PUT', '/api/network/preferred', { ip: '' });
    assert.strictEqual((await api('GET', '/api/network')).j.preferred, '');
    ok('закрепление адреса основным: чужой адрес отклоняется, сброс возвращает автовыбор');

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
