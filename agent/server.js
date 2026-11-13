'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./lib/store');
const catalog = require('./lib/catalog');
const netaccess = require('./lib/netaccess');
const netname = require('./lib/netname');
const startup = require('./lib/startup');
const icons = require('./lib/icons');
const relaydisc = require('./lib/relaydisc');
const { NetWatch } = require('./lib/netwatch');
const { PublicAccess } = require('./lib/publicaccess');
const files = require('./lib/files');
const ai = require('./lib/ai');
const { Manager } = require('./lib/procman');
const { Scheduler, listBackups, backupDir, doBackup } = require('./lib/scheduler');
const { TunnelClient } = require('./lib/tunnel');
const { systemJava } = require('./lib/java');
const { openAppWindow } = require('./lib/appwindow');
const { tarBin, isGuiExe, messageBox } = require('./lib/winutil');
const applog = require('./lib/applog');
const modrinth = require('./lib/modrinth');

const BIND = process.env.BIND || '127.0.0.1';
const WEB = path.join(__dirname, '..', 'web');
const VERSION = '1.4.0';
// Крючки для оболочки (Electron): системные окна и папки вместо запуска внешних программ.
const hooks = { openExternal: null, openPath: null };
const GUI = isGuiExe(); // установленная версия без окна консоли
let PORT = 0;
let appMode = false;

const sse = new Set();
let quitTimer = null;
let bgAsked = false;
function emit(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sse) res.write(data);
}

const mgr = new Manager(emit);
netaccess.setPreferenceSource(() => (store.config.net || {}).preferred || '');
const netwatch = new NetWatch({ mgr, emit, store });
const pub = new PublicAccess({ mgr, store, emit });
const sched = new Scheduler(mgr, emit);
const tunnel = new TunnelClient();
const lab = (o) => (o && typeof o === 'object' ? o.ru || o.en : o || '');
tunnel.on('update', () => emit('tunnels', tunnelView()));
tunnel.on('latency', () => emit('tunnels', tunnelView()));
// Трафик туннелей: накопленные счётчики раз в секунду (интерфейс сам считает скорость)
setInterval(() => {
  if (sse.size && tunnel.tunnels.size) emit('traffic', { ts: Date.now(), t: tunnel.traffic() });
}, 1000).unref();

function relayCfg() {
  const r = store.config.relay;
  return { host: r.host, port: +r.port || 7000, token: r.token, name: r.name || 'hearth' };
}

// Порты, которые сервер открывает наружу (основной и дополнительные, если игре нужно несколько)
function serverPorts(s) {
  const ports = catalog.portsOf(s.game, s.settings);
  const sel = (s.tunnel && s.tunnel.ports) || {};
  const mainRemote = +(s.tunnel && s.tunnel.remotePort) || 0;
  return ports.map((p, i) => ({
    ...p,
    idx: i,
    id: i === 0 ? 'srv-' + s.id : `srv-${s.id}-p${i}`,
    on: i === 0 ? true : sel[i] !== undefined ? !!sel[i] : !p.optional,
    remotePort: i === 0 ? mainRemote : p.adjacent && mainRemote ? mainRemote + p.adjacent : 0,
  }));
}

function desiredTunnels() {
  const out = [];
  for (const s of store.state.servers) {
    if (!s.tunnel || !s.tunnel.enabled) continue;
    for (const p of serverPorts(s)) {
      if (!p.on) continue;
      out.push({ id: p.id, proto: p.proto, localPort: p.port, subdomain: p.idx === 0 ? s.tunnel.subdomain || '' : '', remotePort: p.remotePort });
    }
  }
  for (const t of store.state.tunnels) {
    if (t.enabled !== false) out.push({ id: t.id, proto: t.proto, localPort: +t.localPort, subdomain: t.subdomain || '', remotePort: +t.remotePort || 0 });
  }
  return out;
}

function syncTunnels() {
  const want = new Map(desiredTunnels().map((t) => [t.id, t]));
  for (const id of [...tunnel.tunnels.keys()]) {
    const w = want.get(id);
    const cur = tunnel.tunnels.get(id);
    if (!w || w.proto !== cur.proto || w.localPort !== cur.localPort || w.subdomain !== cur.subdomain || w.remotePort !== cur.remotePort) tunnel.remove(id);
  }
  for (const [id, w] of want) if (!tunnel.tunnels.has(id)) tunnel.add(w);
}

function restartRelay() {
  tunnel.stop();
  tunnel.configure(relayCfg());
  if (store.config.relay.enabled && store.config.relay.host) {
    syncTunnels();
    tunnel.start();
  }
}

let tunRev = 0;

// Автоопределение релея при запуске. Открытый релей подключается сам; релею с токеном нужен токен: предлагаем найденное панели.
async function relayAuto() {
  const r = store.config.relay;
  if (r.host || r.autoDiscover === false || process.env.HEARTH_RELAY_AUTO === '0') return;
  const found = await relaydisc.discover({ extra: r.known || [] }).catch(() => []);
  if (!found.length || store.config.relay.host) return;
  const f = found[0];
  if (found.length === 1 && !f.tokenRequired) {
    Object.assign(r, { host: f.host, port: f.port, srvName: f.name, token: '', enabled: true });
    store.saveConfig();
    restartRelay();
    emit('relay-found', { ...f, connected: true });
  } else emit('relay-found', { ...f, connected: false, count: found.length });
  lastFound = f;
}
let lastFound = null;

// Релей на локальной сети сменил адрес: находим его по имени и обновляем
let relayDown = 0;
setInterval(async () => {
  const r = store.config.relay;
  if (!r.enabled || !r.host || !r.srvName) return (relayDown = 0);
  if (tunnel.status === 'online') return (relayDown = 0);
  if (++relayDown < 3) return;
  relayDown = 0;
  const f = (await relaydisc.discover({ extra: r.known || [] }).catch(() => [])).find((x) => x.name === r.srvName && (x.host !== r.host || x.port !== r.port));
  if (!f) return;
  Object.assign(r, { host: f.host, port: f.port });
  store.saveConfig();
  restartRelay();
  emit('relay-found', { ...f, connected: true, moved: true });
}, +process.env.HEARTH_RELAY_RECHECK_MS || 30000).unref();
function tunnelView() {
  const names = new Map();
  for (const s of store.state.servers) for (const p of serverPorts(s)) names.set(p.id, { s, p });
  const ext = new Map(store.state.tunnels.map((t) => [t.id, t]));
  const r = store.config.relay;
  return {
    rev: ++tunRev,
    relay: { enabled: !!r.enabled, host: r.host, port: +r.port || 7000, name: r.name, srvName: r.srvName || '', autoDiscover: r.autoDiscover !== false, hasToken: !!r.token, status: tunnel.status, error: tunnel.error || '', latency: tunnel.latency || 0 },
    tunnels: tunnel.list().map((t) => {
      const m = names.get(t.id);
      const e = ext.get(t.id);
      return {
        ...t,
        kind: m ? 'server' : 'port',
        serverId: m ? m.s.id : '',
        name: m ? m.s.name + (m.p.idx ? ' · ' + lab(m.p.label) : '') : e ? e.name : t.id,
        game: m ? m.s.game : '',
        enabled: m ? true : e ? e.enabled !== false : true,
      };
    }).concat(
      // Выключенные туннели остаются в списке, чтобы их можно было включить обратно
      store.state.tunnels
        .filter((t) => t.enabled === false && !tunnel.tunnels.has(t.id))
        .map((t) => ({ id: t.id, proto: t.proto, localPort: +t.localPort, subdomain: t.subdomain || '', remotePort: +t.remotePort || 0, info: null, error: '', stats: { rx: 0, tx: 0, conns: 0, total: 0, since: 0 }, events: [], kind: 'port', serverId: '', name: t.name, game: '', enabled: false })),
    ),
  };
}

mgr.emit = (type, payload) => {
  emit(type, payload);
  if (type === 'state' || type === 'removed') setImmediate(syncTunnels);
};

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

function readBody(req, limit = 1 << 20) {
  return new Promise((res, rej) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > limit) {
        req.destroy();
        rej(Object.assign(new Error('тело запроса слишком большое'), { status: 413 }));
      }
    });
    req.on('end', () => {
      try {
        res(b ? JSON.parse(b) : {});
      } catch {
        rej(Object.assign(new Error('неверный JSON'), { status: 400 }));
      }
    });
  });
}

const routes = [];
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

on('GET', '/api/system', async () => ({
  version: VERSION,
  platform: process.platform,
  node: process.version,
  java: await systemJava(),
  lang: store.config.lang,
  dataDir: store.paths.data,
  appMode,
  windows: sse.size,
  running: mgr.runningCount(),
  totalMem: Math.round(require('os').totalmem() / 1048576),
  cores: require('os').cpus().length,
  core: { ok: mgr.core.ok, cores: mgr.core.sys ? mgr.core.sys.cores : 0 },
  ai: { enabled: store.config.ai.enabled, hasKey: !!store.config.ai.apiKey, model: store.config.ai.model },
}));
on('GET', '/api/startup', async () => startup.status());
on('PUT', '/api/startup', async (c) => startup.set(!!(c.body && c.body.enabled)));
on('PUT', '/api/settings', async (c) => {
  const b = c.body;
  if (b.lang === 'ru' || b.lang === 'en') store.config.lang = b.lang;
  if (b.ai) {
    if (typeof b.ai.enabled === 'boolean') store.config.ai.enabled = b.ai.enabled;
    if (typeof b.ai.apiKey === 'string' && b.ai.apiKey.trim()) store.config.ai.apiKey = b.ai.apiKey.trim();
    if (b.ai.clearKey) store.config.ai.apiKey = '';
    if (typeof b.ai.model === 'string' && b.ai.model.trim()) store.config.ai.model = b.ai.model.trim();
  }
  store.saveConfig();
  return { ok: true };
});

on('GET', '/api/capacity', async () => mgr.cap.view());
on('PUT', '/api/capacity', async (c) => {
  mgr.cap.set(c.body || {});
  return mgr.cap.view();
});
on('POST', '/api/capacity/auto', async () => {
  mgr.cap.auto();
  return mgr.cap.view();
});

on('GET', '/api/network', async () => {
  const addresses = netaccess.addresses();
  const primary = addresses.find((a) => a.primary);
  const entries = netaccess.readHosts();
  const hosts = {};
  if (primary) {
    hosts[primary.fqdn] = netaccess.hostsState(primary.fqdn, primary.ip, entries);
    for (const s of store.state.servers) if (s.netName) hosts[s.netName] = netaccess.hostsState(s.netName, primary.ip, entries);
  }
  return { preferred: (store.config.net || {}).preferred || '', hostname: require('os').hostname(), suffix: netname.SUFFIX, addresses, windows: process.platform === 'win32', beta: store.config.beta, hosts, lastIp: (store.config.net || {}).lastIp || '' };
});
// Закрепить адрес основным (например, проводной вместо Wi-Fi) или вернуть автовыбор
on('PUT', '/api/network/preferred', async (c) => {
  const ip = String((c.body && c.body.ip) || '').trim();
  if (ip && !netaccess.addresses('').some((a) => a.ip === ip)) throw Object.assign(new Error('такого адреса у этого ПК нет'), { status: 400 });
  store.config.net.preferred = ip;
  store.saveConfig();
  netwatch.checkIp();
  return { preferred: ip };
});
on('GET', '/api/network/resolve', async (c) => {
  try {
    const ip = netname.nameToIp(c.query.get('name') || '');
    return { ip, fqdn: netname.fqdn(ip) };
  } catch (e) {
    throw Object.assign(new Error(e.message), { status: 400 });
  }
});
on('GET', '/api/servers/:id/reach', async (c) => {
  const s = mgr.rec(c.params.id);
  const state = mgr.view(s).state;
  const r = await netaccess.reach(catalog.portsOf(s.game, s.settings), ['running', 'starting'].includes(state));
  const fw = await netaccess.firewallState(netaccess.firewallRules(s.name, catalog.portsOf(s.game, s.settings)));
  return { state, ...r, firewall: fw };
});
on('POST', '/api/servers/:id/firewall', async (c) => {
  const s = mgr.rec(c.params.id);
  const action = c.body && c.body.action === 'close' ? 'close' : 'open';
  const rules = netaccess.firewallRules(s.name, catalog.portsOf(s.game, s.settings));
  if (!rules.length) throw Object.assign(new Error('у сервера нет портов TCP или UDP'), { status: 400 });
  if (process.platform !== 'win32') {
    return { executed: false, rules: rules.map((r) => r.name), commands: rules.map((r) => `ufw ${action === 'open' ? 'allow' : 'delete allow'} ${r.port}/${r.proto.toLowerCase()}`) };
  }
  const res = await netaccess.elevated(rules.map(action === 'open' ? netaccess.netshAdd : netaccess.netshDel));
  return { ...res, rules: rules.map((r) => r.name) };
});
on('POST', '/api/network/hosts', async (c) => {
  const ip = String((c.body && c.body.ip) || '').trim();
  if (!netname.parseIp(ip) || ip === '0.0.0.0' || ip.startsWith('127.')) throw Object.assign(new Error('нужен IPv4-адрес сервера в сети'), { status: 400 });
  const action = c.body.action === 'remove' ? 'remove' : 'add';
  let name = netname.fqdn(ip);
  if (c.body.name) {
    name = badRequest(() => netname.parseCustom(c.body.name, { anyZone: store.config.beta.anyZone })).host;
  }
  const line = netaccess.hostsLine(ip, name);
  if (process.platform !== 'win32') return { executed: false, commands: [`${action === 'add' ? 'echo' : 'remove:'} ${line} (${netaccess.hostsPath()})`], line, fqdn: name };
  const res = await netaccess.elevated(netaccess.hostsCommands(ip, action, name));
  return { ...res, line, fqdn: name };
});

// Своё имя сервера. Всем: <имя>.hearth[:порт]. Бета (администратор): любая зона, например soskacraft.mc:25570. Пустое имя возвращает автоимя.
const badRequest = (fn) => {
  try {
    return fn();
  } catch (e) {
    throw Object.assign(new Error(e.message), { status: 400 });
  }
};
on('GET', '/api/beta', async () => store.config.beta);
on('PUT', '/api/beta', async (c) => {
  if (c.body && typeof c.body.anyZone === 'boolean') store.config.beta.anyZone = c.body.anyZone;
  store.saveConfig();
  return store.config.beta;
});
on('PUT', '/api/servers/:id/netname', async (c) => {
  const s = mgr.rec(c.params.id);
  const raw = String((c.body && c.body.name) || '').trim();
  if (!raw) {
    delete s.netName;
    store.saveState();
    return mgr.update(s.id, {});
  }
  const { host, port } = badRequest(() => netname.parseCustom(raw, { anyZone: store.config.beta.anyZone }));
  if (mgr.list().some((o) => o.id !== s.id && o.netName === host)) throw Object.assign(new Error(`имя ${host} уже занято другим сервером`), { status: 409 });
  let restart = false;
  if (port !== null) {
    const f = catalog.games[s.game].fields.find((x) => x.key === 'port');
    if (!f) throw Object.assign(new Error('у этой игры порт меняется в разделе «Запуск»: укажите имя без порта'), { status: 400 });
    if (port < (f.min || 1) || port > (f.max || 65535)) throw Object.assign(new Error(`порт для этой игры: ${f.min || 1}–${f.max || 65535}`), { status: 400 });
    const busy = mgr.list().find((o) => o.id !== s.id && catalog.portsOf(o.game, o.settings).some((p) => p.port === port && p.proto === 'tcp'));
    if (busy) throw Object.assign(new Error(`порт ${port} уже занят сервером «${busy.name}»`), { status: 409 });
    if (+s.settings.port !== port) {
      mgr.update(s.id, { settings: { port } });
      restart = ['running', 'starting'].includes(mgr.view(s).state);
    }
  }
  s.netName = host;
  store.saveState();
  return { ...mgr.update(s.id, {}), host, port, restartRequired: restart };
});

// Значки игр: отдают картинку или 404 (тогда панель рисует свою плитку)
const sendIcon = (res, ic) => {
  res.writeHead(200, { 'content-type': ic.mime, 'cache-control': 'private, max-age=86400' });
  fs.createReadStream(ic.file).pipe(res);
};
on('GET', '/api/games/:game/icon', async (c) => ({ __icon: await icons.forGame(c.params.game) }));
on('GET', '/api/servers/:id/icon', async (c) => ({ __icon: await icons.forServer(mgr.rec(c.params.id)) }));
on('PUT', '/api/servers/:id/icon', async (c) => {
  const s = mgr.rec(c.params.id);
  const b = c.body || {};
  if (b.steamApp !== undefined) await icons.setFromSteam(s.id, +b.steamApp);
  else {
    const m = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(String(b.dataUrl || ''));
    if (!m) throw Object.assign(new Error('нужна картинка (dataUrl) или номер игры в Steam'), { status: 400 });
    icons.setCustom(s.id, Buffer.from(m[1], 'base64'));
  }
  s.iconRev = (s.iconRev || 0) + 1;
  store.saveState();
  return mgr.update(s.id, {});
});
on('DELETE', '/api/servers/:id/icon', async (c) => {
  const s = mgr.rec(c.params.id);
  icons.clearCustom(s.id);
  s.iconRev = (s.iconRev || 0) + 1;
  store.saveState();
  return mgr.update(s.id, {});
});
on('GET', '/api/icons/search', async (c) => icons.searchSteam(c.query.get('term')));

// Доступ из интернета напрямую (UPnP): проверка и открытие портов сервера одной кнопкой
on('GET', '/api/public', async () => pub.check());
on('POST', '/api/servers/:id/public', async (c) => {
  const s = mgr.rec(c.params.id);
  if (c.body && c.body.enabled === false) await pub.close(s);
  else await pub.open(s);
  return mgr.update(s.id, {});
});

on('GET', '/api/catalog', async () => catalog.describe());
on('GET', '/api/catalog/:game/versions', async (c) => {
  const g = catalog.games[c.params.game];
  if (!g) throw Object.assign(new Error('неизвестная игра'), { status: 404 });
  return g.versions();
});

on('GET', '/api/servers', async () => mgr.list());
on('POST', '/api/servers', async (c) => mgr.create(c.body));
on('GET', '/api/servers/:id', async (c) => mgr.view(mgr.rec(c.params.id)));
on('PATCH', '/api/servers/:id', async (c) => mgr.update(c.params.id, c.body));
on('DELETE', '/api/servers/:id', async (c) => {
  await pub.close(mgr.rec(c.params.id)).catch(() => {});
  const report = await mgr.remove(c.params.id, c.query.get('files') === '1');
  syncTunnels();
  return { ok: true, ...report };
});
on('POST', '/api/servers/:id/start', async (c) => mgr.start(c.params.id));
on('POST', '/api/servers/:id/stop', async (c) => mgr.stop(c.params.id));
on('POST', '/api/servers/:id/restart', async (c) => mgr.restart(c.params.id));
on('POST', '/api/servers/:id/kill', async (c) => mgr.kill(c.params.id));
on('POST', '/api/servers/:id/reinstall', async (c) => mgr.retryInstall(c.params.id));
on('POST', '/api/servers/:id/command', async (c) => {
  const text = String(c.body.text || '').trim();
  if (!text) throw Object.assign(new Error('пустая команда'), { status: 400 });
  mgr.send(c.params.id, text);
  return { ok: true };
});
on('GET', '/api/servers/:id/logs', async (c) => {
  mgr.rec(c.params.id);
  return mgr.logs(c.params.id, {
    search: c.query.get('search') || '',
    limit: Math.min(+c.query.get('limit') || 500, 3000),
    onlyErrors: c.query.get('errors') === '1',
  });
});

on('DELETE', '/api/servers/:id/logs', async (c) => {
  mgr.clearLogs(c.params.id);
  return { ok: true };
});

const root = (id) => mgr.rec(id).dir;
on('GET', '/api/servers/:id/files', async (c) => ({ path: c.query.get('path') || '', items: files.list(root(c.params.id), c.query.get('path')) }));
on('GET', '/api/servers/:id/file', async (c) => ({ text: files.readText(root(c.params.id), c.query.get('path')) }));
on('PUT', '/api/servers/:id/file', async (c) => {
  files.writeText(root(c.params.id), c.query.get('path'), String(c.body.text ?? ''));
  return { ok: true };
});
on('POST', '/api/servers/:id/mkdir', async (c) => {
  files.mkdir(root(c.params.id), c.body.path);
  return { ok: true };
});
on('POST', '/api/servers/:id/rename', async (c) => {
  files.rename(root(c.params.id), c.body.from, c.body.to);
  return { ok: true };
});
on('DELETE', '/api/servers/:id/file', async (c) => {
  files.remove(root(c.params.id), c.query.get('path'));
  return { ok: true };
});

on('GET', '/api/servers/:id/backups', async (c) => {
  mgr.rec(c.params.id);
  return listBackups(c.params.id);
});
on('POST', '/api/servers/:id/backups', async (c) => ({ name: await doBackup(mgr, mgr.rec(c.params.id), +c.body.keep || 7) }));
on('DELETE', '/api/servers/:id/backups/:name', async (c) => {
  fs.rmSync(path.join(backupDir(mgr.rec(c.params.id).id), path.basename(c.params.name)), { force: true });
  return { ok: true };
});
on('POST', '/api/servers/:id/backups/:name/restore', async (c) => {
  const s = mgr.rec(c.params.id);
  const r = mgr._rt(s.id);
  if (r.child) throw Object.assign(new Error('остановите сервер перед восстановлением'), { status: 409 });
  const file = path.join(backupDir(s.id), path.basename(c.params.name));
  if (!fs.existsSync(file)) throw Object.assign(new Error('бэкап не найден'), { status: 404 });
  await new Promise((res, rej) => {
    const p = spawn(tarBin(), ['-xzf', file, '-C', s.dir], { windowsHide: true });
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res() : rej(new Error('tar завершился с кодом ' + code))));
  });
  mgr._log(s, 'sys', 'Восстановлено из ' + c.params.name);
  return { ok: true };
});

on('GET', '/api/tasks', async () => sched.list());
on('POST', '/api/tasks', async (c) => sched.create(c.body));
on('PATCH', '/api/tasks/:id', async (c) => sched.update(c.params.id, c.body));
on('DELETE', '/api/tasks/:id', async (c) => {
  sched.remove(c.params.id);
  return { ok: true };
});
on('POST', '/api/tasks/:id/run', async (c) => sched.run(c.params.id));

on('GET', '/api/tunnels', async () => tunnelView());
on('PUT', '/api/relay', async (c) => {
  const b = c.body;
  const r = store.config.relay;
  if (typeof b.host === 'string') r.host = b.host.trim();
  if (b.port) r.port = +b.port;
  if (typeof b.name === 'string' && b.name.trim()) r.name = b.name.trim();
  if (typeof b.token === 'string' && b.token.trim()) r.token = b.token.trim();
  if (typeof b.enabled === 'boolean') r.enabled = b.enabled;
  store.saveConfig();
  restartRelay();
  return tunnelView();
});
// Автопоиск релея: на этом ПК, в локальной сети и среди известных адресов
on('GET', '/api/relay/discover', async () => {
  const r = store.config.relay;
  return { found: await relaydisc.discover({ extra: r.known || [] }), configured: !!r.host };
});
// Подключение к найденному релею или по ссылке-приглашению: одно действие вместо трёх полей
on('POST', '/api/relay/connect', async (c) => {
  const b = c.body || {};
  const p = b.link ? badRequest(() => relaydisc.parseLink(b.link)) : badRequest(() => relaydisc.parseLink(`${b.host || ''}${b.port ? ':' + b.port : ''}`));
  const token = String(b.token || p.token || '').trim();
  if (!(await relaydisc.reachable(p.host, p.port))) throw Object.assign(new Error(`релей ${p.host}:${p.port} не отвечает. Проверьте адрес и что порт открыт`), { status: 502 });
  const r = store.config.relay;
  Object.assign(r, { host: p.host, port: p.port, srvName: b.name || p.name || r.srvName });
  const needToken = b.tokenRequired !== false && !token && !p.token;
  if (token) r.token = token;
  else if (b.tokenRequired === false) r.token = '';
  r.enabled = !needToken;
  store.saveConfig();
  restartRelay();
  return { ...tunnelView(), needToken };
});
on('GET', '/api/relay/found', async () => lastFound);
on('PUT', '/api/relay/auto', async (c) => {
  store.config.relay.autoDiscover = !!(c.body && c.body.enabled);
  store.saveConfig();
  return tunnelView();
});
on('POST', '/api/tunnels', async (c) => {
  const b = c.body;
  if (!['tcp', 'udp', 'http'].includes(b.proto)) throw Object.assign(new Error('протокол: tcp, udp или http'), { status: 400 });
  const port = +b.localPort;
  if (!(port > 0 && port < 65536)) throw Object.assign(new Error('неверный локальный порт'), { status: 400 });
  const t = {
    id: store.uid('port'),
    name: String(b.name || `${b.proto.toUpperCase()} :${port}`).slice(0, 60),
    proto: b.proto,
    localPort: port,
    subdomain: String(b.subdomain || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40),
    remotePort: +b.remotePort || 0,
    enabled: true,
  };
  store.state.tunnels.push(t);
  store.saveState();
  syncTunnels();
  return tunnelView();
});
on('DELETE', '/api/tunnels/:id', async (c) => {
  store.state.tunnels = store.state.tunnels.filter((t) => t.id !== c.params.id);
  store.saveState();
  syncTunnels();
  return tunnelView();
});

// ---------- игроки (Minecraft) ----------
const NAME_RE = /^[A-Za-z0-9_.\- ]{1,32}$/;
function readJsonList(dir, name) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
on('GET', '/api/servers/:id/players', async (c) => {
  const s = mgr.rec(c.params.id);
  const r = mgr._rt(s.id);
  const mc = s.game.startsWith('minecraft');
  if (!mc) return { supported: false, online: [], whitelist: [], ops: [], banned: [], running: !!r.child };
  return {
    supported: true,
    running: !!r.child,
    online: r.child ? [...r.players] : [],
    whitelist: readJsonList(s.dir, 'whitelist.json').map((x) => x.name).filter(Boolean),
    ops: readJsonList(s.dir, 'ops.json').map((x) => ({ name: x.name, level: x.level })).filter((x) => x.name),
    banned: readJsonList(s.dir, 'banned-players.json').map((x) => ({ name: x.name, reason: x.reason || '' })).filter((x) => x.name),
  };
});
const PLAYER_CMDS = {
  kick: (n, reason) => `kick ${n}${reason ? ' ' + reason : ''}`,
  ban: (n, reason) => `ban ${n}${reason ? ' ' + reason : ''}`,
  pardon: (n) => `pardon ${n}`,
  op: (n) => `op ${n}`,
  deop: (n) => `deop ${n}`,
  'whitelist-add': (n) => `whitelist add ${n}`,
  'whitelist-remove': (n) => `whitelist remove ${n}`,
};
on('POST', '/api/servers/:id/players/:action', async (c) => {
  const s = mgr.rec(c.params.id);
  if (!s.game.startsWith('minecraft')) throw Object.assign(new Error('управление игроками есть только у Minecraft'), { status: 400 });
  const mk = PLAYER_CMDS[c.params.action];
  if (!mk) throw Object.assign(new Error('неизвестное действие'), { status: 400 });
  const name = String(c.body.name || '').trim();
  if (!NAME_RE.test(name)) throw Object.assign(new Error('некорректный ник'), { status: 400 });
  if (!mgr._rt(s.id).child) throw Object.assign(new Error('сервер не запущен: команды игрокам выполняются на работающем сервере'), { status: 409 });
  const reason = String(c.body.reason || '').replace(/[\r\n]+/g, ' ').slice(0, 120);
  mgr.send(s.id, mk(name, reason));
  return { ok: true };
});

// ---------- плагины / моды ----------
function pluginDir(s) {
  const g = catalog.games[s.game];
  if (!g || !g.plugins) return '';
  if (g.pdir) return g.pdir;
  return { plugins: 'plugins', mods: 'mods', oxide: 'oxide/plugins', addons: 'addons' }[g.plugins] || '';
}
const PLUGIN_EXT = /\.(jar|dll|cs|lua|smx|vdf|zip|so)(\.disabled)?$/i;
on('GET', '/api/servers/:id/plugins', async (c) => {
  const s = mgr.rec(c.params.id);
  const rel = pluginDir(s);
  if (!rel) return { supported: false, dir: '', items: [] };
  const dir = path.join(s.dir, rel);
  let items = [];
  try {
    items = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && PLUGIN_EXT.test(e.name))
      .map((e) => {
        const st = fs.statSync(path.join(dir, e.name));
        return { name: e.name, enabled: !e.name.endsWith('.disabled'), size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {}
  return { supported: true, dir: rel, items, kind: catalog.games[s.game].plugins };
});
on('POST', '/api/servers/:id/plugins/toggle', async (c) => {
  const s = mgr.rec(c.params.id);
  const dir = path.join(s.dir, pluginDir(s) || '__none__');
  const name = path.basename(String(c.body.name || ''));
  const from = path.join(dir, name);
  if (!pluginDir(s) || !fs.existsSync(from)) throw Object.assign(new Error('файл не найден'), { status: 404 });
  const to = name.endsWith('.disabled') ? path.join(dir, name.slice(0, -9)) : from + '.disabled';
  fs.renameSync(from, to);
  if (mgr._rt(s.id).child) mgr.markRestartRequired && mgr.markRestartRequired(s.id);
  return { ok: true, name: path.basename(to) };
});
on('DELETE', '/api/servers/:id/plugins', async (c) => {
  const s = mgr.rec(c.params.id);
  if (!pluginDir(s)) throw Object.assign(new Error('у игры нет плагинов'), { status: 400 });
  const f = path.join(s.dir, pluginDir(s), path.basename(String(c.query.get('name') || '')));
  fs.rmSync(f, { force: true });
  return { ok: true };
});
on('GET', '/api/servers/:id/plugins/search', async (c) => {
  const s = mgr.rec(c.params.id);
  if (!modrinth.supports(s.game)) return { supported: false, hits: [] };
  const hits = await modrinth.search({ game: s.game, version: s.version, q: c.query.get('q') || '' });
  return { supported: true, hits };
});
on('POST', '/api/servers/:id/plugins/install', async (c) => {
  const s = mgr.rec(c.params.id);
  const rel = pluginDir(s);
  if (!rel || !modrinth.supports(s.game)) throw Object.assign(new Error('у этой игры нет онлайн-каталога плагинов'), { status: 400 });
  const r = await modrinth.install({ game: s.game, version: s.version, project: String(c.body.project || ''), destDir: path.join(s.dir, rel) });
  mgr._log(s, 'sys', `Установлен плагин ${r.name} (${r.version}) из Modrinth`);
  if (mgr._rt(s.id).child) mgr.markRestartRequired(s.id);
  return { ok: true, ...r };
});
on('GET', '/api/servers/:id/plugin-dir', async (c) => ({ dir: pluginDir(mgr.rec(c.params.id)) }));

// ---------- мир ----------
function dirSize(d, budget = { n: 20000 }) {
  let total = 0;
  let ents = [];
  try {
    ents = fs.readdirSync(d, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of ents) {
    if (budget.n-- <= 0) return total;
    const p = path.join(d, e.name);
    try {
      total += e.isDirectory() ? dirSize(p, budget) : fs.statSync(p).size;
    } catch {}
  }
  return total;
}
function worldNames(s) {
  let level = 'world';
  try {
    const m = /^level-name=(.*)$/m.exec(fs.readFileSync(path.join(s.dir, 'server.properties'), 'utf8'));
    if (m && m[1].trim()) level = m[1].trim();
  } catch {}
  return { level, dirs: [level, level + '_nether', level + '_the_end'] };
}
on('GET', '/api/servers/:id/world', async (c) => {
  const s = mgr.rec(c.params.id);
  if (!s.game.startsWith('minecraft')) return { supported: false };
  const { level, dirs } = worldNames(s);
  const parts = dirs.map((d) => {
    const full = path.join(s.dir, d);
    const exists = fs.existsSync(full) && fs.statSync(full).isDirectory();
    return { name: d, exists, size: exists ? dirSize(full) : 0, mtime: exists ? fs.statSync(full).mtimeMs : 0 };
  });
  let seed = '';
  try {
    const m = /^level-seed=(.*)$/m.exec(fs.readFileSync(path.join(s.dir, 'server.properties'), 'utf8'));
    seed = m ? m[1] : '';
  } catch {}
  return { supported: true, level, parts, seed, running: !!mgr._rt(s.id).child };
});
on('POST', '/api/servers/:id/world/reset', async (c) => {
  const s = mgr.rec(c.params.id);
  if (!s.game.startsWith('minecraft')) throw Object.assign(new Error('сброс мира есть только у Minecraft'), { status: 400 });
  if (mgr._rt(s.id).child) throw Object.assign(new Error('остановите сервер перед сбросом мира'), { status: 409 });
  const { dirs } = worldNames(s);
  let n = 0;
  for (const d of dirs) {
    const full = path.join(s.dir, d);
    if (full.startsWith(path.resolve(s.dir) + path.sep) && fs.existsSync(full)) {
      fs.rmSync(full, { recursive: true, force: true });
      n++;
    }
  }
  mgr._log(s, 'sys', `Мир сброшен (удалено папок: ${n}). При следующем запуске создастся новый.`);
  return { ok: true, removed: n };
});

// ---------- итоговая командная строка ----------
on('GET', '/api/servers/:id/commandline', async (c) => {
  const s = mgr.rec(c.params.id);
  const g = catalog.games[s.game];
  try {
    const { cmd, args } = await g.command(s, () => {}, true);
    const q = (x) => (/\s/.test(String(x)) ? '"' + x + '"' : String(x));
    return { ok: true, cmd, args, line: [cmd, ...args].map(q).join(' ') };
  } catch (e) {
    return { ok: false, error: e.message, line: '' };
  }
});

on('PATCH', '/api/tunnels/:id', async (c) => {
  const t = store.state.tunnels.find((x) => x.id === c.params.id);
  if (!t) throw Object.assign(new Error('туннель не найден'), { status: 404 });
  const b = c.body;
  if (typeof b.enabled === 'boolean') t.enabled = b.enabled;
  if (typeof b.name === 'string' && b.name.trim()) t.name = b.name.trim().slice(0, 60);
  if (b.localPort !== undefined) {
    const port = +b.localPort;
    if (!(port > 0 && port < 65536)) throw Object.assign(new Error('неверный локальный порт'), { status: 400 });
    t.localPort = port;
  }
  if (b.proto !== undefined) {
    if (!['tcp', 'udp', 'http'].includes(b.proto)) throw Object.assign(new Error('протокол: tcp, udp или http'), { status: 400 });
    t.proto = b.proto;
  }
  if (b.subdomain !== undefined) t.subdomain = String(b.subdomain).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  if (b.remotePort !== undefined) t.remotePort = +b.remotePort || 0;
  store.saveState();
  syncTunnels();
  emit('tunnels', tunnelView());
  return tunnelView();
});

on('POST', '/api/quit', async () => {
  setTimeout(shutdown, 250);
  return { ok: true };
});
on('POST', '/api/open-url', async (c) => {
  const url = String((c.body && c.body.url) || '');
  if (!require('./lib/sources').allowed(url)) throw Object.assign(new Error('эту ссылку открыть нельзя'), { status: 400 });
  if (process.env.HEARTH_NO_OPEN !== '1') {
    if (hooks.openExternal) hooks.openExternal(url);
    else require('./lib/appwindow').openInDefaultBrowser(url);
  }
  return { ok: true, url };
});
on('POST', '/api/servers/:id/open-folder', async (c) => {
  const dir = mgr.rec(c.params.id).dir;
  if (!fs.existsSync(dir)) throw Object.assign(new Error('папка не найдена: ' + dir), { status: 404 });
  if (process.env.HEARTH_NO_OPEN !== '1' && hooks.openPath) hooks.openPath(dir);
  else if (process.env.HEARTH_NO_OPEN !== '1') {
    const cmd = process.platform === 'win32' ? ['explorer.exe', [dir]] : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]];
    try {
      require('child_process').spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    } catch {}
  }
  return { ok: true, dir };
});
on('POST', '/api/ai/explain', async (c) => ({ answer: await ai.explain({ text: c.body.text, question: c.body.question, lang: c.body.lang || store.config.lang }) }));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(WEB, path.normalize(rel).replace(/^([/\\]\.\.)+/, ''));
  if (!file.startsWith(WEB)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

function authorized(req, url) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') || '';
  return t.length > 0 && t === store.config.panelToken;
}

const server = http.createServer(async (req, res) => {
  const hostName = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (BIND === '127.0.0.1' && !['127.0.0.1', 'localhost', '[::1]'].includes(hostName)) {
    res.writeHead(403);
    return res.end('forbidden host');
  }
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  if (url.pathname === '/api/ping') return json(res, 200, { app: 'hearth', version: VERSION });
  if (!authorized(req, url)) return json(res, 401, { error: 'нужен токен доступа' });

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    sse.add(res);
    bgAsked = false;
    clearTimeout(quitTimer);
    const hb = setInterval(() => res.write(': hb\n\n'), 20000);
    req.on('close', () => {
      clearInterval(hb);
      sse.delete(res);
      onWindowGone();
    });
    return;
  }

  const dl = /^\/api\/servers\/([^/]+)\/(backups|download)\/(.+)$/.exec(url.pathname);
  if (dl && req.method === 'GET' && dl[2] === 'download') {
    try {
      const s = mgr.rec(dl[1]);
      const file = files.resolveIn(s.dir, decodeURIComponent(dl[3]));
      const st = fs.statSync(file);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'content-disposition': `attachment; filename="${path.basename(file)}"` });
      return fs.createReadStream(file).pipe(res);
    } catch (e) {
      return json(res, e.status || 404, { error: e.message });
    }
  }
  if (dl && req.method === 'GET' && dl[2] === 'backups') {
    try {
      const s = mgr.rec(dl[1]);
      const file = path.join(backupDir(s.id), path.basename(decodeURIComponent(dl[3])));
      const st = fs.statSync(file);
      res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': st.size, 'content-disposition': `attachment; filename="${path.basename(file)}"` });
      return fs.createReadStream(file).pipe(res);
    } catch (e) {
      return json(res, e.status || 404, { error: e.message });
    }
  }
  const up = /^\/api\/servers\/([^/]+)\/upload$/.exec(url.pathname);
  if (up && req.method === 'POST') {
    try {
      const n = await files.writeStream(mgr.rec(up[1]).dir, url.searchParams.get('path'), req, 500 * 1024 * 1024);
      return json(res, 200, { ok: true, size: n });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message });
    }
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    try {
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const params = {};
      for (const [k, v] of Object.entries(m.groups || {})) params[k] = decodeURIComponent(v);
      const out = await r.fn({ params, query: url.searchParams, body });
      if (out && Object.prototype.hasOwnProperty.call(out, '__icon')) {
        if (!out.__icon) return json(res, 404, { error: 'значка нет' });
        return sendIcon(res, out.__icon);
      }
      return json(res, 200, out === undefined ? { ok: true } : out);
    } catch (e) {
      const code = e.code === 'ENOENT' ? 404 : e.status || 500;
      return json(res, code, { error: e.message });
    }
  }
  json(res, 404, { error: 'нет такого метода' });
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[hearth] остановка серверов…');
  sched.stop();
  tunnel.stop();
  mgr.shutdown();
  store.flush();
  const t0 = Date.now();
  const iv = setInterval(() => {
    const alive = [...mgr.rt.values()].some((r) => r.child);
    if (!alive || Date.now() - t0 > 20000) {
      clearInterval(iv);
      process.exit(0);
    }
  }, 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown); // закрытие окна консоли в Windows

function onWindowGone() {
  if (!(appMode || process.env.HEARTH_AUTOQUIT === '1') || sse.size > 0 || shuttingDown) return;
  clearTimeout(quitTimer);
  quitTimer = setTimeout(() => {
    if (sse.size > 0 || shuttingDown) return;
    if (mgr.runningCount() > 0) {
      console.log('\n  Окно закрыто, но серверы работают — Hearth остаётся в фоне.');
      if (GUI) {
        if (bgAsked) return;
        bgAsked = true;
        const n = mgr.runningCount();
        messageBox(
          `Окно Hearth закрыто, но серверов запущено: ${n}.\n\nДа — оставить Hearth в фоне (серверы продолжат работать, откройте Hearth снова из меню «Пуск», чтобы вернуться).\nНет — корректно остановить серверы и выйти.`,
          'Hearth',
          'YesNo',
          'Question'
        ).then((ans) => {
          if (ans === 'No') shutdown();
        });
      } else {
        console.log('  Запустите Hearth ещё раз, чтобы открыть окно, или закройте это окно консоли, чтобы остановить всё.\n');
      }
    } else {
      console.log('\n  Окно закрыто — выход.');
      shutdown();
    }
  }, +process.env.AUTOQUIT_GRACE_MS || 12000);
}

const lockFile = path.join(store.paths.data, 'agent.json');
const readLock = () => {
  try {
    return JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    return null;
  }
};
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
async function pingHearth(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return (await r.json()).app === 'hearth';
  } catch {
    return false;
  }
}
function listenOn(port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => {
      server.removeListener('listening', onOk);
      reject(e);
    };
    const onOk = () => {
      server.removeListener('error', onErr);
      resolve();
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, BIND);
  });
}

async function bindPort() {
  if (process.env.PORT) {
    await listenOn(+process.env.PORT);
    return;
  }
  const first = +process.env.PORT_START || 7788;
  for (let p = first; p < first + 30; p++) {
    try {
      await listenOn(p);
      return;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
    }
  }
  await listenOn(0);
}

async function start() {
  applog.init(store.paths.data);
  const wantWindow = process.env.NO_BROWSER !== '1' && !process.argv.includes('--startup') && process.env.HEARTH_APP === '1';
  const profile = path.join(store.paths.data, 'app-profile');
  const lock = readLock();
  if (lock && lock.pid !== process.pid && pidAlive(lock.pid) && (await pingHearth(lock.port))) {
    const url = `http://127.0.0.1:${lock.port}/#token=${store.config.panelToken}`;
    if (require('./lib/runtime').electron) return { already: true, url };
    console.log('\n  Hearth уже запущен — открываю его окно.\n');
    if (wantWindow) openAppWindow(url, profile);
    setTimeout(() => process.exit(0), 1200);
    return;
  }
  try {
    await bindPort();
  } catch (e) {
    throw new Error(`не удалось занять порт для панели (${e.code || e.message}). Закройте программы, которые могут его занимать, или задайте переменную PORT`);
  }
  PORT = server.address().port;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: PORT }));
  const url = `http://127.0.0.1:${PORT}/#token=${store.config.panelToken}`;
  console.log(`\n  Hearth ${VERSION}`);
  console.log(`  Панель: ${url}`);
  console.log(`  Данные: ${store.paths.data}\n`);
  if (wantWindow) {
    const r = openAppWindow(url, profile);
    appMode = r.mode === 'app' || (GUI && r.mode === 'browser');
    console.log(appMode ? '  Открыто окно приложения. Закройте его, чтобы выйти.\n' : r.mode === 'browser' ? '  Подходящий браузер не найден, панель открыта во вкладке.\n' + (GUI ? '  Закройте вкладку, чтобы выйти.\n' : '  Чтобы выйти, закройте это окно консоли.\n') : '  Не удалось открыть окно, откройте ссылку выше вручную.\n');
    if (GUI && r.mode === 'none') messageBox('Не удалось открыть окно Hearth. Установите Microsoft Edge или Google Chrome и запустите Hearth снова.\n\nАдрес панели: ' + url, 'Hearth', 'OK', 'Warning').then(() => shutdown());
  }
  sched.start();
  netwatch.start();
  pub.start();
  restartRelay();
  relayAuto();
  if (process.env.AUTOSTART !== '0') {
    for (const sv of store.state.servers) if (sv.autostart) mgr.start(sv.id).catch(() => {});
  }
  return { url, port: PORT, already: false };
}

process.on('exit', () => {
  try {
    const l = readLock();
    if (l && l.pid === process.pid) fs.rmSync(lockFile, { force: true });
  } catch {}
});

module.exports = { start, shutdown, hooks, dataDir: store.paths.data, running: () => mgr.runningCount() };
if (require.main === module) {
  start().catch((e) => {
    console.error('[hearth] ' + e.message);
    process.exit(1);
  });
}
