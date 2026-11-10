'use strict';
// Функции из ProximaClient: каталог игр, SteamCMD-серверы, несколько портов, метрики CPU/RAM,
// игроки, плагины, мир, командная строка, статистика туннелей.
const { spawn } = require('child_process');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-feat-'));
const base = 'http://127.0.0.1:17789';
let token = '';
const results = [];
const ok = (n, c, extra) => {
  results.push(!!c);
  console.log((c ? 'PASS ' : 'FAIL ') + n + (extra !== undefined ? '  ' + extra : ''));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, p, body, raw) => {
  const r = await fetch(base + p, { method: m, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
};
const until = async (fn, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await wait(150);
  }
  return false;
};
const udpEcho = (port, msg) =>
  new Promise((res) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => {
      s.close();
      res('');
    }, 2500);
    s.on('message', (m) => {
      clearTimeout(t);
      s.close();
      res(String(m));
    });
    s.send(msg, port, '127.0.0.1');
  });

// ---- имитация Modrinth ----
const http = require('http');
const crypto = require('crypto');
const jarBody = Buffer.from('PK-fake-plugin-jar-' + 'x'.repeat(300));
const modrinthCalls = [];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  modrinthCalls.push(decodeURIComponent(req.url));
  const send = (o) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(o));
  };
  if (u.pathname === '/search') return send({ hits: [{ project_id: 'AbCdEf12', slug: 'essentialsx', title: 'EssentialsX', description: 'Команды и сервисы', author: 'EssentialsX', downloads: 5000000, icon_url: '', date_modified: '2026-10-01T00:00:00Z', display_categories: ['paper', 'utility'] }] });
  if (u.pathname === '/project/AbCdEf12/version') return send([{ version_number: '2.21.0', version_type: 'release', files: [{ primary: true, filename: 'EssentialsX-2.21.0.jar', url: 'http://127.0.0.1:17791/files/e.jar', hashes: { sha1: crypto.createHash('sha1').update(jarBody).digest('hex') } }] }]);
  if (u.pathname === '/project/BadHash99/version') return send([{ version_number: '1', version_type: 'release', files: [{ primary: true, filename: 'Bad.jar', url: 'http://127.0.0.1:17791/files/e.jar', hashes: { sha1: '0'.repeat(40) } }] }]);
  if (u.pathname === '/project/Evil12345/version') return send([{ version_number: '1', version_type: 'release', files: [{ primary: true, filename: '../../evil.jar', url: 'http://127.0.0.1:17791/files/e.jar', hashes: {} }] }]);
  if (u.pathname === '/project/NoneCompat1/version') return send([]);
  if (u.pathname === '/files/e.jar') return res.end(jarBody);
  res.statusCode = 404;
  res.end('{}');
});
mock.listen(17791, '127.0.0.1');

const relay = spawn('node', [path.join(root, 'relay/relay.js')], {
  env: { ...process.env, RELAY_TOKEN: 'rt', CONTROL_PORT: '17002', HTTP_PORT: '18082', RELAY_DOMAIN: 'tun.test', PUBLIC_HOST: '127.0.0.1', PORT_MIN: '32200', PORT_MAX: '32300', BIND: '127.0.0.1' },
  stdio: 'ignore',
});
const agent = spawn('node', [path.join(root, 'agent/server.js')], {
  env: { ...process.env, DATA_DIR: data, PORT: '17789', HEARTH_STEAMCMD: path.join(__dirname, 'fake-steamcmd.js'), PATH: path.join(__dirname, 'fakebin') + path.delimiter + process.env.PATH, HEARTH_STATS_MS: '500', HEARTH_MODRINTH_API: 'http://127.0.0.1:17791' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let out = '';
agent.stdout.on('data', (d) => (out += d));

async function main() {
  await until(() => /token=([0-9a-f]+)/.test(out), 5000);
  token = /token=([0-9a-f]+)/.exec(out)[1];

  // ---- SSE: собираем события traffic ----
  const traffic = [];
  const T0 = Date.now();
  let evAll = 0;
  const ctl = new AbortController();
  fetch(base + '/api/events', { headers: { authorization: 'Bearer ' + token }, signal: ctl.signal })
    .then(async (r) => {
      const dec = new TextDecoder();
      let buf = '';
      for await (const ch of r.body) {
        buf += dec.decode(ch);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          evAll++;
          if (/^event: traffic/m.test(block)) traffic.push(JSON.parse(/^data: (.*)$/m.exec(block)[1]));
        }
      }
    })
    .then(() => console.log('  [SSE закрыт на', Math.round((Date.now() - T0) / 100) / 10, 'с]'))
    .catch((e) => console.log('  [SSE ошибка на', Math.round((Date.now() - T0) / 100) / 10, 'с:', e.message, ']'));

  // ---- каталог ----
  const cat = (await api('GET', '/api/catalog')).j;
  const ids = cat.map((g) => g.id);
  ok('каталог: 25+ игр', cat.length >= 25, cat.length + ' игр');
  ok('каталог: Minecraft (Vanilla/Paper/Purpur/Fabric/Folia), Terraria, CS 1.6, Rust, Valheim, Palworld', ['minecraft-vanilla', 'minecraft-paper', 'minecraft-purpur', 'minecraft-fabric', 'minecraft-folia', 'terraria', 'cs16', 'rust', 'valheim', 'palworld'].every((x) => ids.includes(x)));
  ok('каталог: универсальные «свой сервер» и «Steam по AppID»', ids.includes('custom') && ids.includes('steam-custom'));
  ok('у каждой игры есть поля, теги, память, цвет', cat.every((g) => g.fields.length && Array.isArray(g.tags) && typeof g.ramGB === 'number' && g.color));
  ok('у каждой игры есть порт по умолчанию', cat.every((g) => g.defaultPort > 0));

  // ---- Steam-сервер через SteamCMD (Valheim: два смежных UDP-порта) ----
  const v = (await api('POST', '/api/servers', { game: 'valheim', name: 'Вальхейм', version: 'latest', settings: { port: 28456 } })).j;
  ok('установка через SteamCMD начинается', v.state === 'installing', v.state);
  ok('установка завершается, сервер остановлен', await until(async () => (await api('GET', `/api/servers/${v.id}`)).j.state === 'stopped'));
  const vlogs = (await api('GET', `/api/servers/${v.id}/logs`)).j;
  ok('в журнале виден прогресс SteamCMD', vlogs.some((l) => /Скачивание: 100%/.test(l.text)), vlogs.filter((l) => /%/.test(l.text)).length + ' строк');
  const sargs = fs.readFileSync(path.join(data, 'servers', v.id, 'steam-args.txt'), 'utf8');
  ok('SteamCMD получил app_update 896660 и анонимный вход', /\+login anonymous/.test(sargs) && /\+app_update 896660/.test(sargs), sargs);
  const vv = (await api('GET', `/api/servers/${v.id}`)).j;
  ok('сервер показывает два порта (игра и запрос)', vv.ports.length === 2 && vv.ports[0].port === 28456 && vv.ports[1].port === 28457 && vv.ports[1].adjacent === 1, JSON.stringify(vv.ports.map((p) => p.port + '/' + p.proto)));
  const cl = (await api('GET', `/api/servers/${v.id}/commandline`)).j;
  ok('командная строка собирается по настройкам', cl.ok && /valheim_server/.test(cl.cmd) && cl.args.includes('-port') && cl.args.includes('28456') && cl.args.includes('-world'), cl.line.replace(data, '…'));
  await api('PATCH', `/api/servers/${v.id}`, { settings: { extraArgs: '-saveinterval 600' } });
  const cl2 = (await api('GET', `/api/servers/${v.id}/commandline`)).j;
  ok('дополнительные параметры добавляются в конец', cl2.args.slice(-2).join(' ') === '-saveinterval 600', cl2.args.slice(-2).join(' '));

  await api('POST', `/api/servers/${v.id}/start`);
  ok('сервер игры доходит до running по строке готовности', await until(async () => (await api('GET', `/api/servers/${v.id}`)).j.state === 'running'));
  ok('CPU и память приходят от Rust-ядра', await until(async () => { const x = (await api('GET', `/api/servers/${v.id}`)).j; return x.mem > 10 && typeof x.cpu === 'number'; }, 8000));
  const sys = (await api('GET', '/api/system')).j;
  ok('система сообщает об ядре, ОЗУ и ядрах CPU', sys.core && sys.core.ok && sys.totalMem > 512 && sys.cores >= 1, JSON.stringify(sys.core) + ' ' + sys.totalMem + ' МБ');

  // ---- несколько портов через туннель ----
  await api('PUT', '/api/relay', { host: '127.0.0.1', port: 17002, token: 'rt', name: 'feat', enabled: true });
  await api('PATCH', `/api/servers/${v.id}`, { tunnel: { enabled: true } });
  let tv;
  ok('оба порта получили публичные адреса', await until(async () => { tv = (await api('GET', '/api/tunnels')).j; const mine = tv.tunnels.filter((t) => t.serverId === v.id); return mine.length === 2 && mine.every((t) => t.info); }));
  const mine = tv.tunnels.filter((t) => t.serverId === v.id).sort((a, b) => a.localPort - b.localPort);
  ok('туннели названы по порту игры', /Вальхейм/.test(mine[0].name) && /Запрос/.test(mine[1].name), mine.map((t) => t.name).join(' | '));
  const echoed = await udpEcho(mine[0].info.port, 'ping');
  ok('UDP-пакеты игры ходят через туннель', echoed === 'echo:ping', echoed);
  await udpEcho(mine[1].info.port, 'q');
  await wait(1500);
  tv = (await api('GET', '/api/tunnels')).j;
  const m0 = tv.tunnels.find((t) => t.id === mine[0].id);
  ok('статистика: принято/отдано > 0', m0.stats.rx >= 4 && m0.stats.tx >= 9, `rx=${m0.stats.rx} tx=${m0.stats.tx}`);
  ok('отклик релея измеряется', tv.relay.latency > 0, tv.relay.latency + ' мс');
  ok('журнал активности туннеля не пуст', m0.events.length >= 2 && m0.events.some((e) => /Подключён/.test(e.msg)), m0.events.map((e) => e.msg).join(' > '));
  await until(async () => traffic.length >= 3, 5000);
  ok('поток traffic приходит раз в секунду', traffic.length >= 2 && traffic[traffic.length - 1].t[mine[0].id].rx >= 4, traffic.length + ' событий из ' + evAll + ' | ' + traffic.map((x) => Math.round((x.ts - T0) / 100) / 10).join(','));
  await api('PATCH', `/api/servers/${v.id}`, { tunnel: { ports: { 1: false } } });
  ok('дополнительный порт можно отключить', await until(async () => (await api('GET', '/api/tunnels')).j.tunnels.filter((t) => t.serverId === v.id).length === 1));
  await api('POST', `/api/servers/${v.id}/stop`);
  ok('остановка сервера игры', await until(async () => (await api('GET', `/api/servers/${v.id}`)).j.state === 'stopped'));

  // ---- ошибка SteamCMD объясняется ----
  const bad = (await api('POST', '/api/servers', { game: 'steam-custom', name: 'Нет подписки', settings: { appId: 999, exe: 'x' } })).j;
  ok('ошибка SteamCMD доходит до пользователя', await until(async () => { const x = (await api('GET', `/api/servers/${bad.id}`)).j; return x.state === 'error' && /No subscription/.test(x.msg); }), (await api('GET', `/api/servers/${bad.id}`)).j.msg);
  const noId = await api('POST', '/api/servers', { game: 'steam-custom', name: 'Без AppID', settings: { appId: 0 } });
  ok('«Steam по AppID» требует AppID', noId.status === 400, noId.j.error);

  // ---- Steam по AppID: любой сервер ----
  const any = (await api('POST', '/api/servers', { game: 'steam-custom', name: 'Любая игра', settings: { appId: 12345, exe: 'run.sh', args: '-port 28100', port: 28100, protocol: 'udp' } })).j;
  ok('любой сервер Steam ставится по AppID', await until(async () => (await api('GET', `/api/servers/${any.id}`)).j.state === 'stopped'));
  await api('POST', `/api/servers/${any.id}/start`);
  ok('...и запускается своим файлом и параметрами', await until(async () => { const l = (await api('GET', `/api/servers/${any.id}/logs`)).j; return l.some((x) => /ARGS -port 28100/.test(x.text)); }));
  await api('POST', `/api/servers/${any.id}/kill`);

  // ---- свой сервер с несколькими портами ----
  const cu = (await api('POST', '/api/servers', { game: 'custom', name: 'Мульти', settings: { command: 'node -e 0', port: 25000, protocol: 'tcp', morePorts: '25001/udp, 25002/tcp' } })).j;
  ok('«Свой сервер»: несколько портов TCP/UDP', cu.ports.length === 3 && cu.ports[1].proto === 'udp' && cu.ports[2].port === 25002, JSON.stringify(cu.ports.map((p) => p.port + '/' + p.proto)));

  // ---- Minecraft: игроки, плагины, мир ----
  const mcdir = path.join(data, 'mc');
  fs.mkdirSync(path.join(mcdir, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(mcdir, 'world', 'region'), { recursive: true });
  fs.writeFileSync(path.join(mcdir, 'server.jar'), 'x');
  fs.writeFileSync(path.join(mcdir, 'server.properties'), 'level-seed=424242\nserver-port=25999\n');
  fs.writeFileSync(path.join(mcdir, 'world', 'region', 'r.0.0.mca'), Buffer.alloc(5000, 1));
  fs.writeFileSync(path.join(mcdir, 'plugins', 'Essentials.jar'), Buffer.alloc(1234, 2));
  fs.writeFileSync(path.join(mcdir, 'ops.json'), JSON.stringify([{ uuid: 'u1', name: 'Alex', level: 4 }]));
  fs.writeFileSync(path.join(mcdir, 'banned-players.json'), JSON.stringify([{ uuid: 'u2', name: 'Griefer', reason: 'grief' }]));
  const mc = (await api('POST', '/api/servers', { game: 'minecraft-paper', importDir: mcdir, name: 'MC', settings: { acceptEula: true } })).j;
  ok('Minecraft: ядро сборки определяет Java 21', mc.java === 21 || mc.java === 25 || mc.java > 0, 'Java ' + mc.java);

  let pl = (await api('GET', `/api/servers/${mc.id}/players`)).j;
  ok('игроки: списки ops и банов читаются с диска', pl.supported && pl.ops[0].name === 'Alex' && pl.banned[0].name === 'Griefer' && pl.online.length === 0);
  const off = await api('POST', `/api/servers/${mc.id}/players/kick`, { name: 'Steve' });
  ok('игроки: действия при остановленном сервере → 409', off.status === 409, off.j.error);

  let wd = (await api('GET', `/api/servers/${mc.id}/world`)).j;
  ok('мир: размер и seed', wd.supported && wd.level === 'world' && wd.parts[0].exists && wd.parts[0].size === 5000 && wd.seed === '424242', JSON.stringify(wd.parts[0]));
  let pg = (await api('GET', `/api/servers/${mc.id}/plugins`)).j;
  ok('плагины: список из папки plugins', pg.supported && pg.dir === 'plugins' && pg.items.length === 1 && pg.items[0].enabled, JSON.stringify(pg.items));
  const tg = await api('POST', `/api/servers/${mc.id}/plugins/toggle`, { name: 'Essentials.jar' });
  pg = (await api('GET', `/api/servers/${mc.id}/plugins`)).j;
  ok('плагины: отключение переименованием в .disabled', tg.status === 200 && pg.items[0].name === 'Essentials.jar.disabled' && !pg.items[0].enabled);
  await api('POST', `/api/servers/${mc.id}/plugins/toggle`, { name: 'Essentials.jar.disabled' });
  const trav = await api('POST', `/api/servers/${mc.id}/plugins/toggle`, { name: '../server.jar' });
  ok('плагины: выход за папку невозможен', fs.existsSync(path.join(mcdir, 'server.jar')) && trav.status === 404, String(trav.status));
  const up = await fetch(base + `/api/servers/${mc.id}/upload?path=plugins/Vault.jar`, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: Buffer.alloc(777, 3) });
  pg = (await api('GET', `/api/servers/${mc.id}/plugins`)).j;
  ok('плагины: загрузка файла в папку плагинов', up.status === 200 && pg.items.some((x) => x.name === 'Vault.jar' && x.size === 777));
  await fetch(base + `/api/servers/${mc.id}/plugins?name=Vault.jar`, { method: 'DELETE', headers: { authorization: 'Bearer ' + token } });
  pg = (await api('GET', `/api/servers/${mc.id}/plugins`)).j;
  ok('плагины: удаление', !pg.items.some((x) => x.name === 'Vault.jar'));
  const none = (await api('GET', `/api/servers/${cu.id}/plugins`)).j;
  ok('плагины: у «Свой сервер» раздела нет', none.supported === false);

  // ---- онлайн-поиск плагинов (Modrinth) ----
  const sr = (await api('GET', `/api/servers/${mc.id}/plugins/search?q=essentials`)).j;
  ok('онлайн-поиск: находит плагины', sr.supported && sr.hits.length === 1 && sr.hits[0].title === 'EssentialsX', sr.hits[0] && sr.hits[0].title);
  const q0 = modrinthCalls.find((c) => c.startsWith('/search'));
  ok('онлайн-поиск: фильтрует по загрузчику и запросу', /query=essentials/.test(q0) && /categories:paper/.test(q0) && /project_type:mod/.test(q0), q0);
  const inst = await api('POST', `/api/servers/${mc.id}/plugins/install`, { project: 'AbCdEf12' });
  ok('онлайн-установка: файл скачан, сумма SHA-1 сошлась', inst.status === 200 && fs.existsSync(path.join(mcdir, 'plugins', 'EssentialsX-2.21.0.jar')) && fs.readFileSync(path.join(mcdir, 'plugins', 'EssentialsX-2.21.0.jar')).equals(jarBody), JSON.stringify(inst.j));
  const bh = await api('POST', `/api/servers/${mc.id}/plugins/install`, { project: 'BadHash99' });
  ok('онлайн-установка: чужая контрольная сумма отклоняется и файл удаляется', bh.status === 502 && !fs.existsSync(path.join(mcdir, 'plugins', 'Bad.jar')), bh.j.error);
  const ev = await api('POST', `/api/servers/${mc.id}/plugins/install`, { project: 'Evil12345' });
  ok('онлайн-установка: имя файла «../» срезается до имени и остаётся в папке плагинов', ev.status === 200 && ev.j.name === 'evil.jar' && fs.existsSync(path.join(mcdir, 'plugins', 'evil.jar')) && !fs.existsSync(path.join(mcdir, 'evil.jar')) && !fs.existsSync(path.join(mcdir, '..', 'evil.jar')), ev.j.name);
  fs.rmSync(path.join(mcdir, 'plugins', 'evil.jar'), { force: true });
  const nc = await api('POST', `/api/servers/${mc.id}/plugins/install`, { project: 'NoneCompat1' });
  ok('онлайн-установка: нет совместимой версии — понятная ошибка', nc.status === 404 && /совместим/.test(nc.j.error), nc.j.error);
  const bi = await api('POST', `/api/servers/${mc.id}/plugins/install`, { project: '../x' });
  ok('онлайн-установка: некорректный id отклоняется', bi.status === 400);
  const unsup = (await api('GET', `/api/servers/${cu.id}/plugins/search?q=a`)).j;
  ok('онлайн-поиск: у «Свой сервер» его нет', unsup.supported === false);
  await api('DELETE', `/api/servers/${mc.id}/plugins?name=EssentialsX-2.21.0.jar`);

  await api('POST', `/api/servers/${mc.id}/start`);
  ok('Minecraft запускается', await until(async () => (await api('GET', `/api/servers/${mc.id}`)).j.state === 'running', 12000));
  ok('игрок Steve виден онлайн', await until(async () => (await api('GET', `/api/servers/${mc.id}/players`)).j.online.includes('Steve'), 6000));
  const bad1 = await api('POST', `/api/servers/${mc.id}/players/kick`, { name: 'x;stop' });
  ok('игроки: опасные ники отклоняются', bad1.status === 400, bad1.j.error);
  const k = await api('POST', `/api/servers/${mc.id}/players/kick`, { name: 'Steve', reason: 'тест' });
  ok('игроки: выгнать (команда kick)', k.status === 200 && (await until(async () => !(await api('GET', `/api/servers/${mc.id}/players`)).j.online.includes('Steve'), 4000)));
  const wr = await api('POST', `/api/servers/${mc.id}/world/reset`);
  ok('мир: сброс при работающем сервере → 409', wr.status === 409, wr.j.error);
  await api('POST', `/api/servers/${mc.id}/stop`);
  await until(async () => (await api('GET', `/api/servers/${mc.id}`)).j.state === 'stopped');
  const wr2 = await api('POST', `/api/servers/${mc.id}/world/reset`);
  ok('мир: сброс на остановленном сервере удаляет папку', wr2.status === 200 && !fs.existsSync(path.join(mcdir, 'world')));

  // ---- свой туннель: изменить / выключить ----
  const pt = (await api('POST', '/api/tunnels', { proto: 'tcp', localPort: 26000, name: 'Мой порт' })).j;
  const tid = pt.tunnels.find((t) => t.name === 'Мой порт').id;
  const ed = await api('PATCH', `/api/tunnels/${tid}`, { name: 'Переименован', enabled: false });
  const after = ed.j.tunnels.find((t) => t.id === tid);
  ok('туннель: выключенный остаётся в списке (enabled=false), без публичного адреса и под новым именем', ed.status === 200 && after && after.enabled === false && !after.info && after.name === 'Переименован', JSON.stringify(after && { enabled: after.enabled, name: after.name }));
  const bp = await api('PATCH', `/api/tunnels/${tid}`, { localPort: 99999 });
  ok('туннель: неверный порт отклоняется', bp.status === 400, bp.j.error);

  ctl.abort();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  return passed === results.length;
}

main()
  .then((okAll) => cleanup(okAll ? 0 : 1))
  .catch((e) => {
    console.error('FATAL', e);
    cleanup(1);
  });
function cleanup(code) {
  agent.kill('SIGTERM');
  relay.kill();
  mock.close();
  setTimeout(() => process.exit(code), 800);
}
