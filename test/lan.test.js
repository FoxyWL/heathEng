'use strict';
// «Виртуальная машина» без гипервизора: второй ПК (друг) — отдельное сетевое пространство имён Linux, соединённое с хозяином кабелем veth.
// Друг подключается к серверу Hearth по имени (через свой hosts), как настоящий игрок в локальной сети.
// Нужны root и iproute2; без них набор пропускается.
const { spawn, spawnSync } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fqdn } = require('../agent/lib/netname');

const sh = (cmd) => spawnSync('sh', ['-c', cmd], { encoding: 'utf8' });
if (process.platform !== 'linux' || process.getuid() !== 0 || sh('command -v ip && command -v unshare').status !== 0) {
  console.log('lan: пропущено (нужны Linux, root и iproute2)');
  process.exit(0);
}

const NS = 'hearthfriend';
const HOST_IF = 'hearthhost';
const FR_IF = 'hearthfrnd';
const HOST_IP = '10.88.0.1';
const NEW_IP = '10.88.0.9';
const FRIEND_IP = '10.88.0.2';
const PORT = '17170';
let n = 0;
const ok = (m) => console.log('  ✓', m, `(${++n})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-lan-'));
const hostsBackup = fs.readFileSync('/etc/hosts', 'utf8');
let agent = null;

function cleanup() {
  try {
    fs.writeFileSync('/etc/hosts', hostsBackup);
  } catch {}
  if (agent) agent.kill();
  sh(`ip link del ${HOST_IF} 2>/dev/null; ip netns del ${NS} 2>/dev/null`);
}
process.on('exit', cleanup);

// банер-сервер: отвечает строкой, по ней друг узнаёт «свой» сервер
const listen = path.join(dir, 'listen.js');
fs.writeFileSync(listen, "const net=require('net');net.createServer((s)=>{s.on('error',()=>{});s.end('HEARTH-OK '+process.argv[2]+'\\n')}).listen(+process.argv[2],process.argv[3],()=>console.log('listening'));setInterval(()=>{},1000);");

// друг: отдельная сеть и свой /etc/hosts (bind-mount), подключается по имени
const friendScript = path.join(dir, 'friend.js');
fs.writeFileSync(friendScript, "const net=require('net');const [h,p]=[process.argv[2],+process.argv[3]];const s=net.connect({host:h,port:p,timeout:2500});let b='';s.on('data',d=>b+=d);s.on('end',()=>{console.log(b.trim());process.exit(0)});s.on('error',e=>{console.log('ERR '+e.code);process.exit(1)});s.on('timeout',()=>{console.log('ERR TIMEOUT');process.exit(1)});");
function friend(hostsLines, name, port) {
  const hf = path.join(dir, 'friend-hosts-' + Date.now());
  fs.writeFileSync(hf, '127.0.0.1 localhost\n' + hostsLines + '\n');
  const r = sh(`ip netns exec ${NS} unshare -m sh -c 'mount --bind ${hf} /etc/hosts && node ${friendScript} ${name} ${port}'`);
  return (r.stdout || '').trim() || (r.stderr || '').trim();
}

(async () => {
  assert.strictEqual(sh(`ip netns add ${NS}`).status, 0, 'сетевое пространство имён создано');
  const net = sh(`ip link add dev ${HOST_IF} type veth peer name ${FR_IF} && ip link set dev ${FR_IF} netns ${NS} && ip addr add ${HOST_IP}/24 dev ${HOST_IF} && ip link set dev ${HOST_IF} up && ip -n ${NS} addr add ${FRIEND_IP}/24 dev ${FR_IF} && ip -n ${NS} link set dev ${FR_IF} up && ip -n ${NS} link set lo up`);
  assert.strictEqual(net.status, 0, 'кабель между ПК: ' + net.stderr);
  assert.strictEqual(sh(`ip netns exec ${NS} nc -z -w2 ${HOST_IP} 22`).status === 0 || /refused/i.test(sh(`ip netns exec ${NS} nc -zv -w2 ${HOST_IP} 22 2>&1`).stdout), true, 'друг видит хозяина по сети');
  ok('второй ПК создан: друг 10.88.0.2 ↔ хозяин 10.88.0.1 по veth');

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-landata-'));
  agent = spawn('node', [path.join(root, 'main.js')], { env: { ...process.env, DATA_DIR: data, PORT, NO_BROWSER: '1', HEARTH_NO_OPEN: '1', HEARTH_STATS_MS: '500', HEARTH_NETWATCH_MS: '400', HEARTH_NETWATCH_GRACE_MS: '0', HEARTH_NET_IGNORE: '^(eth|ens|enp|wlan)' }, stdio: ['ignore', 'pipe', 'inherit'] });
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
  for (let i = 0; i < 60 && !/token=/.test(out); i++) await wait(100);

  // события сети из SSE
  const events = [];
  const ac = new AbortController();
  (async () => {
    const token = /token=([0-9a-f]+)/.exec(out)[1];
    const r = await fetch(`http://127.0.0.1:${PORT}/api/events`, { headers: { authorization: 'Bearer ' + token }, signal: ac.signal });
    let buf = '';
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const m = /event: net\ndata: (.*)/.exec(buf.slice(0, i));
        if (m) events.push(JSON.parse(m[1]));
        buf = buf.slice(i + 2);
      }
    }
  })().catch(() => {});

  try {
    const lan = (await api('GET', '/api/network')).j.addresses.find((a) => a.primary);
    assert.strictEqual(lan.ip, HOST_IP, 'основной адрес хозяина — по кабелю к другу: ' + JSON.stringify(lan));
    assert.strictEqual(lan.fqdn, fqdn(HOST_IP));
    ok(`Hearth выбрал адрес ПК ${lan.ip} → ${lan.fqdn}`);

    const mk = async (name, port, host) => (await api('POST', '/api/servers', { game: 'custom', name, command: `node "${listen}" ${port} ${host}`, settings: { port } })).j;
    const open = await mk('Open', 17181, '0.0.0.0');
    const local = await mk('Local', 17182, '127.0.0.1');
    for (const s of [open, local]) await api('POST', `/api/servers/${s.id}/start`);
    await until(async () => (await api('GET', '/api/servers')).j.filter((s) => s.state === 'running').length === 2, 15000, 'серверы запущены');
    await wait(600);

    // автоимя: друг знает только имя из Hearth
    const autoHosts = `${HOST_IP} ${lan.fqdn} # Hearth`;
    assert.strictEqual(friend(autoHosts, lan.fqdn, 17181), 'HEARTH-OK 17181');
    ok('друг подключается к серверу по автоимени ' + lan.fqdn + ':17181');

    // своё имя
    const r1 = await api('PUT', `/api/servers/${open.id}/netname`, { name: 'SoskaCraft' });
    assert.strictEqual(r1.j.host, 'soskacraft.hearth');
    const r2 = await api('PUT', `/api/servers/${local.id}/netname`, { name: 'Zamok.mc' });
    assert.strictEqual(r2.j.host, 'zamok.mc');
    assert.strictEqual(friend(`${HOST_IP} soskacraft.hearth # Hearth`, 'soskacraft.hearth', 17181), 'HEARTH-OK 17181');
    ok('друг подключается по своему имени soskacraft.hearth:17181');

    // сервер только на 127.0.0.1: друг не заходит, Hearth предупреждает
    assert(/^ERR/.test(friend(`${HOST_IP} zamok.mc # Hearth`, 'zamok.mc', 17182)), 'друг не должен зайти на сервер, слушающий только 127.0.0.1');
    const rl = (await api('GET', `/api/servers/${local.id}/reach`)).j;
    assert.strictEqual(rl.ports[0].status, 'loopback-only');
    await until(() => events.some((e) => e.type === 'unreachable' && e.id === local.id), 8000, 'предупреждение «недоступен в сети»: ' + JSON.stringify(events));
    assert(!events.some((e) => e.type === 'unreachable' && e.id === open.id), 'доступный сервер не ругается');
    ok('сервер только на 127.0.0.1: друг получил отказ, Hearth показал loopback-only и прислал предупреждение');

    // hosts на хозяине: запись Hearth, затем смена IP делает её устаревшей
    fs.appendFileSync('/etc/hosts', `\n${HOST_IP} soskacraft.hearth # Hearth\n${HOST_IP} ${lan.fqdn} # Hearth\n`);
    let nw = (await api('GET', '/api/network')).j;
    assert.strictEqual(nw.hosts['soskacraft.hearth'], 'ok');
    assert.strictEqual(nw.hosts[lan.fqdn], 'ok');
    ok('запись в hosts на этом ПК определяется как актуальная');

    const cmd = sh(`ip addr del ${HOST_IP}/24 dev ${HOST_IF} && ip addr add ${NEW_IP}/24 dev ${HOST_IF}`);
    assert.strictEqual(cmd.status, 0, cmd.stderr);
    const ev = await until(() => events.find((e) => e.type === 'ip-changed'), 8000, 'событие смены IP');
    assert(ev.from === HOST_IP && ev.to === NEW_IP && ev.fqdn === fqdn(NEW_IP), JSON.stringify(ev));
    nw = (await api('GET', '/api/network')).j;
    assert.strictEqual(nw.addresses.find((a) => a.primary).ip, NEW_IP);
    assert.strictEqual(nw.hosts['soskacraft.hearth'], 'stale');
    assert.strictEqual(nw.hosts[fqdn(NEW_IP)], 'missing');
    assert(/^ERR/.test(friend(`${HOST_IP} soskacraft.hearth # Hearth`, 'soskacraft.hearth', 17181)), 'старая запись друга больше не работает');
    ok('IP хозяина сменился: событие ip-changed, имя в hosts помечено устаревшим, старая запись друга перестала работать');

    // починка: Hearth отдаёт строку с новым IP (на Linux команды, не выполняются сами)
    const fix = (await api('POST', '/api/network/hosts', { ip: NEW_IP, action: 'add', name: 'soskacraft.hearth' })).j;
    assert.strictEqual(fix.line, `${NEW_IP} soskacraft.hearth # Hearth`);
    assert.strictEqual(friend(fix.line, 'soskacraft.hearth', 17181), 'HEARTH-OK 17181');
    ok('новая строка для hosts от Hearth возвращает доступ другу по тому же имени');
    console.log(`\nlan: ${n} проверок пройдено`);
    ac.abort();
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e);
    if (process.env.LAN_DEBUG) {
      for (const sv of (await api('GET', '/api/servers')).j || []) console.error(sv.name, sv.state, JSON.stringify(((await api('GET', `/api/servers/${sv.id}/logs`)).j.lines || (await api('GET', `/api/servers/${sv.id}/logs`)).j || []).slice(-6)));
    }
    ac.abort();
    process.exit(1);
  }
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
