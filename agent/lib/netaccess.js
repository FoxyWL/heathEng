'use strict';
// Сетевой доступ: адреса этого ПК, проверка, что сервер слушает на них, правила брандмауэра Windows и запись имени в hosts.
const os = require('os');
const net = require('net');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { fqdn, ipToName, SUFFIX } = require('./netname');

const isWin = process.platform === 'win32';

function kindOf(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a === 169 && b === 254) return 'linklocal';
  return 'public';
}

const VIRTUAL = /vethernet|vmware|virtualbox|vbox|docker|wsl|hyper-v|loopback|tailscale|zerotier|vpn|tap-|tun|br-|veth/i;

/** IPv4-адреса этого ПК. Первым идёт тот, которым чаще всего пользуются в домашней сети. */
function addresses() {
  const out = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const kind = kindOf(a.address);
      out.push({ ip: a.address, iface, kind, virtual: VIRTUAL.test(iface), name: ipToName(a.address), fqdn: fqdn(a.address) });
    }
  }
  const rank = (x) => (x.virtual ? 5 : 0) + { private: 0, public: 1, cgnat: 2, linklocal: 3 }[x.kind];
  out.sort((x, y) => rank(x) - rank(y));
  if (out.length) out[0].primary = true;
  return out;
}

function probeTcp(host, port, ms = 900) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Проверка доступа по портам сервера: слушает ли он на этом ПК и на адресе в сети. */
async function reach(ports, running) {
  const addrs = addresses();
  const lan = addrs.find((a) => a.primary) || null;
  const rows = [];
  for (const p of ports) {
    const row = { label: p.label, port: p.port, proto: p.proto, optional: !!p.optional };
    if (p.proto === 'udp') {
      row.status = running ? 'udp' : 'stopped';
    } else if (!running) {
      row.status = 'stopped';
    } else {
      row.loopback = await probeTcp('127.0.0.1', p.port);
      row.lan = lan ? await probeTcp(lan.ip, p.port) : null;
      row.status = !row.loopback ? 'closed' : lan && !row.lan ? 'loopback-only' : 'ok';
    }
    rows.push(row);
  }
  return { primary: lan, ports: rows };
}

const safe = (s) => String(s).replace(/[^\w .-]/g, '').slice(0, 40).trim() || 'server';

/** Правила входящих подключений для портов сервера. */
function firewallRules(serverName, ports) {
  return ports
    .filter((p) => p.proto === 'tcp' || p.proto === 'udp')
    .map((p) => ({ name: `Hearth: ${safe(serverName)} (${p.proto.toUpperCase()} ${p.port})`, proto: p.proto.toUpperCase(), port: p.port }));
}

function netshAdd(r) {
  return `netsh advfirewall firewall add rule name="${r.name}" dir=in action=allow protocol=${r.proto} localport=${r.port} profile=any`;
}
const netshDel = (r) => `netsh advfirewall firewall delete rule name="${r.name}"`;

/** Команда PowerShell, которая запускает скрипт от имени администратора (окно UAC). Скрипт передаётся в base64, поэтому кавычки не ломают вызов. */
function elevatedCommand(commands) {
  const enc = Buffer.from(commands.join('; '), 'utf16le').toString('base64');
  return `Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '-NoProfile','-EncodedCommand','${enc}'`;
}

/** Выполняет команды от имени администратора на Windows. Возвращает сами команды, чтобы их можно было показать. */
function elevated(commands) {
  return new Promise((resolve) => {
    if (!isWin || process.env.HEARTH_NO_OPEN === '1') return resolve({ executed: false, commands });
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', elevatedCommand(commands)], { windowsHide: true, stdio: 'ignore' });
    c.on('error', () => resolve({ executed: false, commands, error: 'не удалось запустить PowerShell' }));
    c.on('close', (code) => resolve({ executed: code === 0, commands, error: code === 0 ? '' : 'запрос прав администратора отклонён или команда не выполнилась' }));
  });
}

const hostsPath = () => process.env.HEARTH_HOSTS_FILE || (isWin ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts');
const hostsLine = (ip, name = fqdn(ip)) => `${ip} ${name} # Hearth`;

function hostsCommands(ip, action, name = fqdn(ip)) {
  const p = hostsPath();
  const drop = `(Get-Content -LiteralPath '${p}') | Where-Object { $_ -notmatch '${name.replace(/\./g, '\\.')}' } | Set-Content -LiteralPath '${p}'`;
  if (action === 'remove') return [drop];
  return [drop, `Add-Content -LiteralPath '${p}' -Value '${hostsLine(ip, name)}'`];
}

/** Строки Hearth в hosts: имя → IP. Читать файл можно без прав администратора. */
function readHosts(file = hostsPath()) {
  const map = new Map();
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return map;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+(\S+)\s*#\s*Hearth\b/.exec(line);
    if (m) map.set(m[2].toLowerCase(), m[1]);
  }
  return map;
}

/** ok: имя ведёт на текущий IP, stale: ведёт на старый, missing: записи нет. */
function hostsState(name, ip, entries = readHosts()) {
  const cur = entries.get(String(name).toLowerCase());
  return !cur ? 'missing' : cur === ip ? 'ok' : 'stale';
}

/** Есть ли правило брандмауэра Windows для порта (чтение прав администратора не требует). Вне Windows состояние неизвестно. */
function firewallState(rules) {
  if (!isWin || !rules.length) return Promise.resolve('unknown');
  const one = (r) => new Promise((resolve) => {
    execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${r.name}`], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err && err.code === 'ENOENT' ? null : !err && /-{10,}/.test(String(out)))); // правило есть: код 0 и вывод с линией-разделителем (не зависит от языка Windows)
  });
  return Promise.all(rules.map(one)).then((r) => (r.includes(null) ? 'unknown' : r.every(Boolean) ? 'present' : 'missing'));
}

module.exports = { readHosts, hostsState, firewallState, addresses, probeTcp, reach, firewallRules, netshAdd, netshDel, elevated, elevatedCommand, hostsCommands, hostsLine, hostsPath, kindOf, SUFFIX };
