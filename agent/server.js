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
const { RelayHost } = require('./lib/relayhost');
const publicname = require('./lib/publicname');
const { Updater } = require('./lib/updater');
const { Notifier } = require('./lib/notify');
const { Access } = require('./lib/access');
const files = require('./lib/files');
const ai = require('./lib/ai');
const { Manager } = require('./lib/procman');
const { Scheduler, listBackups, backupDir, doBackup, hooks: backupHooks } = require('./lib/scheduler');
const { Cloud } = require('./lib/cloud');
const { TunnelClient } = require('./lib/tunnel');
const { systemJava } = require('./lib/java');
const { openAppWindow } = require('./lib/appwindow');
const { tarBin, isGuiExe, messageBox } = require('./lib/winutil');
const applog = require('./lib/applog');
const modrinth = require('./lib/modrinth');

const BIND = process.env.BIND || (store.config.panel && store.config.panel.lan ? '0.0.0.0' : '127.0.0.1');
const WEB = path.join(__dirname, '..', 'web');
const VERSION = '1.7.0';
// Крючки для оболочки (Electron): системные окна и папки вместо запуска внешних программ.
const hooks = { openExternal: null, openPath: null };
const GUI = isGuiExe(); // установленная версия без окна консоли
let PORT = 0;
let appMode = false;

const sse = new Set();
let quitTimer = null;
let bgAsked = false;
function emit(type, payload) {
  let data = null;
  for (const res of sse) {
    const p = res.principal;
    if (p && !p.admin) {
      // пользователям с ограниченной ролью уходит только то, что относится к их серверам
      const pl = access.event(p, type, payload);
      if (pl !== null) res.write(`event: ${type}\ndata: ${JSON.stringify(pl)}\n\n`);
    } else res.write(data || (data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`));
  }
}

const access = new Access(store);
const mgr = new Manager(emit);
netaccess.setPreferenceSource(() => (store.config.net || {}).preferred || '');
const netwatch = new NetWatch({ mgr, emit, store });
let duckTick = async () => {};
const pub = new PublicAccess({
  mgr,
  store,
  emit: (type, payload) => {
    emit(type, payload);
    if (type === 'net' && payload.type === 'public-ip-changed') {
      duckTick().catch(() => {}); // DuckDNS узнаёт о новом IP сразу
      notifier.onNet(payload);
    }
  },
});
const relayHost = new RelayHost({ store, emit });
const notifier = new Notifier({ store, dataDir: store.paths.data });
const cloud = new Cloud({
  store,
  backupDir,
  listLocal: listBackups,
  onResult: (r, id) => {
    emit('cloud', cloud.view());
    if (!r.ok) notifier.notify('backup', 'Облачный бэкап не загрузился', `${r.name}: ${r.error}`, { serverId: id }, { key: 'cloud' }).catch(() => {});
  },
});
backupHooks.afterBackup = (server, name) => cloud.afterBackup(server, name);
const updater = new Updater({ store, emit: (t, p) => { emit(t, p); if (t === 'update') notifier.onUpdate(p); }, version: VERSION, quit: () => shutdown() });
const sched = new Scheduler(mgr, emit);
const tunnel = new TunnelClient();
const lab = (o) => (o && typeof o === 'object' ? o.ru || o.en : o || '');
// Запоминаем выданный порт: при следующем запуске просим тот же, и адрес не меняется
function rememberPorts() {
  if (tunnel.status !== 'online') return;
  let dirty = false;
  for (const s of store.state.servers) {
    const t = tunnel.tunnels.get('srv-' + s.id);
    if (!s.tunnel || !t || !t.info || t.proto === 'http' || tunnel._via(t) === 'vhost') continue;
    if (!(+s.tunnel.remotePort) && s.tunnel.lastPort !== t.info.port) {
      s.tunnel.lastPort = t.info.port;
      t.remotePort = t.info.port; // совпадает с желаемым: туннель не пересоздаётся
      dirty = true;
    }
  }
  if (dirty) store.saveState();
}
tunnel.on('update', () => {
  rememberPorts();
  notifier.onRelay(tunnel.status, !!store.config.relay.enabled);
  emit('tunnels', tunnelView());
});
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
  const mainRemote = +(s.tunnel && s.tunnel.remotePort) || +(s.tunnel && s.tunnel.lastPort) || 0; // свой порт, иначе прошлый: адрес не меняется между запусками
  return ports.map((p, i) => ({
    ...p,
    idx: i,
    id: i === 0 ? 'srv-' + s.id : `srv-${s.id}-p${i}`,
    on: i === 0 ? true : sel[i] !== undefined ? !!sel[i] : !p.optional,
    remotePort: i === 0 ? mainRemote : p.adjacent && mainRemote ? mainRemote + p.adjacent : 0,
  }));
}

// Имя на общем порту релей читает из первых байт: это умеют Minecraft Java, TLS и HTTP. UDP-игры и остальные TCP-игры так назвать нельзя.
const nameRoutable = (s) => (catalog.games[s.game] || {}).kind === 'minecraft';

// Имя работает как адрес, если домен релея сам указывает на релей (sslip.io, DuckDNS) или хозяин настроил wildcard-DNS
const namesWork = (domain) => !!domain && (/(^|\.)(sslip\.io|nip\.io|duckdns\.org)$/.test(domain) || store.config.relay.wildcard === true);

function desiredTunnels() {
  const out = [];
  for (const s of store.state.servers) {
    if (!s.tunnel || !s.tunnel.enabled) continue;
    for (const p of serverPorts(s)) {
      if (!p.on) continue;
      const main = p.idx === 0;
      const byName = main && p.proto === 'tcp' && nameRoutable(s) && s.tunnel.byName !== false;
      out.push({
        id: p.id,
        proto: p.proto,
        localPort: p.port,
        subdomain: main ? s.tunnel.subdomain || publicname.slug(s.name, 30) : '',
        hint: main && !s.tunnel.subdomain,
        prefer: byName ? 'vhost' : '',
        hosts: byName && s.tunnel.customHost ? [s.tunnel.customHost] : [],
        remotePort: p.remotePort,
      });
    }
  }
  for (const t of store.state.tunnels) {
    if (t.enabled !== false) out.push({ id: t.id, proto: t.proto, localPort: +t.localPort, subdomain: t.subdomain || '', hint: false, prefer: '', hosts: [], remotePort: +t.remotePort || 0 });
  }
  return out;
}

function syncTunnels() {
  const want = new Map(desiredTunnels().map((t) => [t.id, t]));
  for (const id of [...tunnel.tunnels.keys()]) {
    const w = want.get(id);
    const cur = tunnel.tunnels.get(id);
    if (!w || w.proto !== cur.proto || w.localPort !== cur.localPort || w.subdomain !== cur.subdomain || w.remotePort !== cur.remotePort || w.prefer !== cur.prefer || (w.hosts || []).join() !== (cur.hosts || []).join()) tunnel.remove(id);
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
    relay: { wildcard: r.wildcard === true, vhostPort: tunnel.info.vhostPort || 0, domain: tunnel.info.domain || '', names: namesWork(tunnel.info.domain), enabled: !!r.enabled, host: r.host, port: +r.port || 7000, name: r.name, srvName: r.srvName || '', autoDiscover: r.autoDiscover !== false, hasToken: !!r.token, status: tunnel.status, error: tunnel.error || '', latency: tunnel.latency || 0 },
    tunnels: tunnel.list().map((t) => {
      const m = names.get(t.id);
      const e = ext.get(t.id);
      const domain = tunnel.info.domain;
      const label = t.subdomain || (m && m.p.idx === 0 ? publicname.slug(m.s.name, 30) : '');
      // Имя для TCP/UDP-туннеля: метка.домен:порт указывает на релей, а порт выбирает туннель
      const nameUrl = t.info && t.via !== 'vhost' && t.via !== 'http' && label && namesWork(domain) && m && m.p.idx === 0 ? `${label}.${domain}:${t.info.port}` : '';
      return {
        ...t,
        nameUrl,
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
  if (type === 'state') notifier.onServer(payload);
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
require('./routes/admin')({ on, store, mgr, tunnel, notifier, cloud, access, updater, sse, bind: BIND, port: () => PORT });
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

const badRequest = (fn) => {
  try {
    return fn();
  } catch (e) {
    throw Object.assign(new Error(e.message), { status: 400 });
  }
};
const sendIcon = (res, ic) => {
  res.writeHead(200, { 'content-type': ic.mime, 'cache-control': 'private, max-age=86400' });
  fs.createReadStream(ic.file).pipe(res);
};
const publicIpOfServers = () => ((store.state.servers.find((s) => s.publicIp && s.publicIp.enabled) || {}).publicIp || {}).ext || '';
require('./routes/network')({ badRequest, publicIpOfServers, catalog, emit, icons, mgr, netaccess, netname, netwatch, on, pub, publicname, relayHost, store });

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
  if (typeof b.host === 'string') {
    if (b.host.trim() !== r.host) {
      for (const s of store.state.servers) if (s.tunnel) s.tunnel.lastPort = 0; // порты принадлежат прежнему релею
      store.saveState();
    }
    r.host = b.host.trim();
  }
  if (typeof b.wildcard === 'boolean') r.wildcard = b.wildcard;
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
  if (!['tcp', 'udp', 'http', 'vhost'].includes(b.proto)) throw Object.assign(new Error('протокол: tcp, udp, http или vhost'), { status: 400 });
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

require('./routes/minecraft')({ on, mgr, store, files, modrinth, catalog, spawn, tarBin, backupDir });

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
    if (!['tcp', 'udp', 'http', 'vhost'].includes(b.proto)) throw Object.assign(new Error('протокол: tcp, udp, http или vhost'), { status: 400 });
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

function principal(req, url) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') || '';
  return access.who(t);
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
  const who = principal(req, url);
  if (!who) return json(res, 401, { error: 'нужен токен доступа' });
  if (!access.allow(who, req.method, url.pathname)) return json(res, 403, { error: 'недостаточно прав для этого действия' });

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    res.principal = who;
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
      let out = await r.fn({ params, query: url.searchParams, body });
      if (!who.admin && req.method === 'GET' && out) {
        if (url.pathname === '/api/servers') out = access.filterServers(who, out);
        else if (/^\/api\/servers\/[^/]+$/.test(url.pathname)) out = access.redact(out);
        else if (url.pathname === '/api/tunnels') out = access.filterTunnels(who, out);
        else if (url.pathname === '/api/tasks') out = access.filterTasks(who, out);
      }
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
  updater.stop();
  notifier.stop();
  tunnel.stop();
  mgr.shutdown();
  store.flush();
  let relayDone = false;
  relayHost.stop({ permanent: false }).finally(() => (relayDone = true)); // порты на роутере закрываем до выхода
  const t0 = Date.now();
  const iv = setInterval(() => {
    const alive = [...mgr.rt.values()].some((r) => r.child) || !relayDone;
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
  duckTick = publicname.start({ ipSource: publicIpOfServers, emit });
  duckTick().catch(() => {});
  relayHost.autostart();
  updater.start();
  notifier.start();
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
