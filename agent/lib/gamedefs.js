'use strict';
// Данные об играх. Серверы Steam-игр ставятся через SteamCMD; параметры запуска собраны по документации
// разработчиков. Если у игры поменяется формат запуска, правится только соответствующая запись здесь.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const steamcmd = require('./steamcmd');
const { downloadFile } = require('./download');
const { tarBin } = require('./winutil');

const L = (ru, en) => ({ ru, en });
const isWin = process.platform === 'win32';

const f = {
  port: (def, extra) => ({ key: 'port', type: 'number', label: L('Порт', 'Port'), min: 1, max: 65535, default: def, group: 'run', help: L('Локальный порт сервера. Менять нужно, только если он занят.', 'Local server port. Change it only if it is busy.'), ...extra }),
  maxPlayers: (def, max = 1000) => ({ key: 'maxPlayers', type: 'number', label: L('Макс. игроков', 'Max players'), min: 1, max, default: def, help: L('Сколько игроков может быть на сервере одновременно.', 'How many players can be on the server at once.') }),
  hostname: (def) => ({ key: 'hostname', type: 'text', label: L('Название сервера', 'Server name'), default: def }),
  password: () => ({ key: 'password', type: 'text', label: L('Пароль для входа', 'Join password'), default: '', help: L('Пусто — вход без пароля.', 'Empty means no password.') }),
  adminPassword: () => ({ key: 'adminPassword', type: 'text', label: L('Пароль администратора', 'Admin password'), default: 'changeme', help: L('Смените по умолчанию: им управляют сервером.', 'Change the default: it controls the server.') }),
  map: (def) => ({ key: 'map', type: 'text', label: L('Карта', 'Map'), default: def }),
  extraArgs: () => ({ key: 'extraArgs', type: 'text', label: L('Дополнительные параметры запуска', 'Extra launch arguments'), default: '', group: 'run', wide: true, help: L('Добавляются в конец командной строки. Например: -tickrate 128', 'Appended to the command line. Example: -tickrate 128')}),
  branch: () => ({ key: 'branch', type: 'text', label: L('Ветка Steam (beta)', 'Steam branch (beta)'), default: 'public', group: 'run', help: L('public — обычная версия. Название беты вводите, только если оно нужно.', 'public is the normal release. Enter a beta name only if needed.') }),
};

// Игровые ассеты: цвет и монограмма для карточки каталога
const STEAM = [
  { id: 'cs16', name: 'Counter-Strike 1.6', appId: 90, mod: 'cstrike', color: '#c9a227', tags: ['shooter'], ramGB: 0, port: 27015, proto: 'udp', windowed: true,
    exe: { win: 'hlds.exe', linux: 'hlds_run' }, fields: [f.maxPlayers(16, 32), f.map('de_dust2'), f.hostname('Hearth CS 1.6')],
    args: (s) => ['-game', 'cstrike', '+port', s.port, '+maxplayers', s.maxPlayers, '+map', s.map, '+hostname', s.hostname], steamExtra: ['+app_set_config 90 mod cstrike'] },
  { id: 'czero', name: 'Counter-Strike: Condition Zero', appId: 90, mod: 'czero', color: '#6b8e23', tags: ['shooter'], ramGB: 0, port: 27015, proto: 'udp', windowed: true,
    exe: { win: 'hlds.exe', linux: 'hlds_run' }, fields: [f.maxPlayers(16, 32), f.map('de_dust2'), f.hostname('Hearth CZ')],
    args: (s) => ['-game', 'czero', '+port', s.port, '+maxplayers', s.maxPlayers, '+map', s.map, '+hostname', s.hostname], steamExtra: ['+app_set_config 90 mod czero'] },
  { id: 'dod', name: 'Day of Defeat', appId: 90, mod: 'dod', color: '#a33', tags: ['shooter'], ramGB: 0, port: 27015, proto: 'udp', windowed: true,
    exe: { win: 'hlds.exe', linux: 'hlds_run' }, fields: [f.maxPlayers(16, 32), f.map('dod_anzio'), f.hostname('Hearth DoD')],
    args: (s) => ['-game', 'dod', '+port', s.port, '+maxplayers', s.maxPlayers, '+map', s.map, '+hostname', s.hostname], steamExtra: ['+app_set_config 90 mod dod'] },
  { id: 'svencoop', name: 'Sven Co-op', appId: 276060, color: '#4a6fa5', tags: ['shooter', 'coop'], ramGB: 0, port: 27015, proto: 'udp', windowed: true,
    exe: { win: 'svends.exe', linux: 'svends_run' }, fields: [f.maxPlayers(8, 32), f.map('hl_c01_a1')],
    args: (s) => ['+maxplayers', s.maxPlayers, '+map', s.map, '+port', s.port] },
  { id: 'cs2', name: 'Counter-Strike 2', appId: 730, color: '#de9b35', tags: ['shooter'], ramGB: 4, port: 27015, proto: 'udp', plugins: 'addons', pdir: 'game/csgo/addons',
    exe: { win: 'game/bin/win64/cs2.exe', linux: 'game/bin/linuxsteamrt64/cs2' }, fields: [f.maxPlayers(10, 64), f.map('de_dust2'), f.hostname('Hearth CS2'), { key: 'gslt', type: 'text', label: L('Токен GSLT (для интернета)', 'GSLT token (for internet play)'), default: '', help: L('Токен сервера из steamcommunity.com/dev/managegameservers; без него друзья могут не увидеть сервер.', 'Server token from steamcommunity.com/dev/managegameservers.') }],
    args: (s) => ['-dedicated', '-console', '-usercon', '-port', s.port, '-maxplayers', s.maxPlayers, '+map', s.map, '+hostname', s.hostname, ...(s.gslt ? ['+sv_setsteamaccount', s.gslt] : [])] },
  { id: 'tf2', name: 'Team Fortress 2', appId: 232250, color: '#b8553a', tags: ['shooter'], ramGB: 2, port: 27015, proto: 'udp', plugins: 'addons', pdir: 'tf/addons',
    exe: { win: 'srcds.exe', linux: 'srcds_run' }, fields: [f.maxPlayers(24, 100), f.map('cp_badlands'), f.hostname('Hearth TF2')],
    args: (s) => ['-game', 'tf', '-console', '-port', s.port, '+maxplayers', s.maxPlayers, '+map', s.map, '+hostname', s.hostname] },
  { id: 'gmod', name: "Garry's Mod", appId: 4020, color: '#3a8fb7', tags: ['sandbox'], ramGB: 2, port: 27015, proto: 'udp', plugins: 'addons', pdir: 'garrysmod/addons',
    exe: { win: 'srcds.exe', linux: 'srcds_run' }, fields: [f.maxPlayers(16, 128), f.map('gm_construct'), f.hostname("Hearth GMod"), { key: 'gamemode', type: 'text', label: L('Режим игры', 'Game mode'), default: 'sandbox' }],
    args: (s) => ['-game', 'garrysmod', '-console', '-port', s.port, '+maxplayers', s.maxPlayers, '+gamemode', s.gamemode, '+map', s.map, '+hostname', s.hostname] },
  { id: 'l4d2', name: 'Left 4 Dead 2', appId: 222860, color: '#8a2d2d', tags: ['shooter', 'coop'], ramGB: 2, port: 27015, proto: 'udp', plugins: 'addons', pdir: 'left4dead2/addons',
    exe: { win: 'srcds.exe', linux: 'srcds_run' }, fields: [f.map('c1m1_hotel'), f.hostname('Hearth L4D2')],
    args: (s) => ['-game', 'left4dead2', '-console', '-port', s.port, '+map', s.map, '+hostname', s.hostname] },
  { id: 'rust', name: 'Rust', appId: 258550, color: '#b5532a', tags: ['survival', 'shooter'], ramGB: 8, port: 28015, proto: 'udp', plugins: 'oxide',
    exe: { win: 'RustDedicated.exe', linux: 'RustDedicated' }, ready: /Server startup complete/i,
    fields: [f.maxPlayers(50, 500), f.hostname('Hearth Rust'), { key: 'worldSize', type: 'number', label: L('Размер мира', 'World size'), min: 1000, max: 6000, default: 3000 }, { key: 'seed', type: 'number', label: L('Seed мира', 'World seed'), default: 12345 }, { key: 'rconPort', type: 'number', label: L('Порт RCON', 'RCON port'), default: 28016 }, f.adminPassword()],
    args: (s) => ['-batchmode', '-nographics', '+server.port', s.port, '+server.identity', 'hearth', '+server.hostname', s.hostname, '+server.maxplayers', s.maxPlayers, '+server.worldsize', s.worldSize, '+server.seed', s.seed, '+rcon.port', s.rconPort, '+rcon.password', s.adminPassword, '+rcon.web', '1'],
    ports: (s) => [{ label: L('Игра', 'Game'), port: +s.port, proto: 'udp' }] },
  { id: 'ark', name: 'ARK: Survival Evolved', appId: 376030, color: '#3d7a5a', tags: ['survival'], ramGB: 8, port: 7777, proto: 'udp', plugins: 'mods',
    exe: { win: 'ShooterGame/Binaries/Win64/ShooterGameServer.exe', linux: 'ShooterGame/Binaries/Linux/ShooterGameServer' }, ready: /Server has completed startup|Full Startup/i,
    fields: [f.maxPlayers(20, 70), f.hostname('Hearth ARK'), { key: 'queryPort', type: 'number', label: L('Порт запроса (Steam)', 'Query port'), default: 27015 }, f.adminPassword()],
    args: (s) => [`TheIsland?listen?SessionName=${s.hostname}?Port=${s.port}?QueryPort=${s.queryPort}?MaxPlayers=${s.maxPlayers}?ServerAdminPassword=${s.adminPassword}`, '-server', '-log'],
    ports: (s) => [{ label: L('Игра', 'Game'), port: +s.port, proto: 'udp' }, { label: L('Игра +1', 'Game +1'), port: +s.port + 1, proto: 'udp', adjacent: 1 }, { label: L('Steam-запрос', 'Steam query'), port: +s.queryPort, proto: 'udp', optional: true }] },
  { id: 'palworld', name: 'Palworld', appId: 2394010, color: '#4aa3df', tags: ['survival', 'sandbox'], ramGB: 16, port: 8211, proto: 'udp',
    exe: { win: 'PalServer.exe', linux: 'PalServer.sh' }, ready: /Running Palworld dedicated server/i,
    fields: [f.maxPlayers(16, 32), f.hostname('Hearth Palworld'), f.password()],
    args: (s) => [`-port=${s.port}`, `-players=${s.maxPlayers}`, `-servername=${s.hostname}`, ...(s.password ? [`-serverpassword=${s.password}`] : []), '-useperfthreads', '-NoAsyncLoadingThread', '-UseMultithreadForDS'] },
  { id: 'valheim', name: 'Valheim', appId: 896660, color: '#5b7c99', tags: ['survival', 'coop'], ramGB: 4, port: 2456, proto: 'udp',
    exe: { win: 'valheim_server.exe', linux: 'valheim_server.x86_64' }, ready: /Game server connected/i,
    fields: [f.hostname('Hearth Valheim'), { key: 'world', type: 'text', label: L('Название мира', 'World name'), default: 'Hearth' }, { ...f.password(), default: 'hearth1', help: L('Не короче 5 символов и не совпадает с названием сервера.', 'At least 5 characters and different from the server name.') }],
    args: (s) => ['-nographics', '-batchmode', '-name', s.hostname, '-port', s.port, '-world', s.world, '-password', s.password, '-public', '0'],
    ports: (s) => [{ label: L('Игра', 'Game'), port: +s.port, proto: 'udp' }, { label: L('Запрос (порт+1)', 'Query (port+1)'), port: +s.port + 1, proto: 'udp', adjacent: 1 }] },
  { id: '7dtd', name: '7 Days to Die', appId: 294420, color: '#a07a2a', tags: ['survival'], ramGB: 8, port: 26900, proto: 'tcp', plugins: 'mods',
    exe: { win: '7DaysToDieServer.exe', linux: '7DaysToDieServer.x86_64' }, ready: /GameServer.LogOn successful|Server started|StartGame done/i,
    fields: [],
    args: () => ['-configfile=serverconfig.xml', '-logfile', 'output_log.txt', '-quit', '-batchmode', '-nographics', '-dedicated'],
    ports: (s) => [{ label: 'TCP', port: +s.port, proto: 'tcp' }, { label: 'UDP', port: +s.port, proto: 'udp' }] },
  { id: 'zomboid', name: 'Project Zomboid', appId: 380870, color: '#8b6f47', tags: ['survival', 'coop'], ramGB: 4, port: 16261, proto: 'udp', plugins: 'mods',
    exe: { win: 'StartServer64.bat', linux: 'start-server.sh' }, ready: /SERVER STARTED/i, stop: 'quit',
    fields: [f.adminPassword()],
    args: (s) => ['-adminpassword', s.adminPassword, '-servername', 'hearth'],
    ports: (s) => [{ label: L('Игра', 'Game'), port: +s.port, proto: 'udp' }, { label: L('Игра +1', 'Game +1'), port: +s.port + 1, proto: 'udp', adjacent: 1 }] },
  { id: 'vrising', name: 'V Rising', appId: 1829350, color: '#7a1f3d', tags: ['survival'], ramGB: 6, port: 9876, proto: 'udp',
    exe: { win: 'VRisingServer.exe', linux: 'VRisingServer.exe' }, fields: [f.hostname('Hearth V Rising'), f.maxPlayers(40, 60)],
    args: (s) => ['-persistentDataPath', './save-data', '-serverName', s.hostname, '-saveName', 'hearth', '-logFile', './logs/VRisingServer.log'],
    ports: (s) => [{ label: L('Игра', 'Game'), port: +s.port, proto: 'udp' }, { label: L('Запрос +1', 'Query +1'), port: +s.port + 1, proto: 'udp', adjacent: 1 }] },
  { id: 'satisfactory', name: 'Satisfactory', appId: 1690800, color: '#e0883b', tags: ['sandbox', 'coop'], ramGB: 8, port: 7777, proto: 'udp',
    exe: { win: 'FactoryServer.exe', linux: 'FactoryServer.sh' }, fields: [],
    args: (s) => ['-log', '-unattended', `-Port=${s.port}`],
    ports: (s) => [{ label: 'UDP', port: +s.port, proto: 'udp' }, { label: 'TCP', port: +s.port, proto: 'tcp' }] },
  { id: 'unturned', name: 'Unturned', appId: 1110390, color: '#58a33a', tags: ['survival'], ramGB: 2, port: 27015, proto: 'udp',
    exe: { win: 'Unturned.exe', linux: 'Unturned_Headless.x86_64' }, fields: [f.maxPlayers(24, 200)],
    args: (s) => ['-batchmode', '-nographics', '-port', s.port, '+InternetServer/hearth'],
    ports: (s) => [{ label: L('Игра', 'Game'), port: +s.port, proto: 'udp' }, { label: L('Игра +1', 'Game +1'), port: +s.port + 1, proto: 'udp', adjacent: 1 }] },
  { id: 'conan', name: 'Conan Exiles', appId: 443030, color: '#9c5b2a', tags: ['survival'], ramGB: 8, port: 7777, proto: 'udp', plugins: 'mods',
    exe: { win: 'ConanSandboxServer.exe', linux: 'ConanSandboxServer.sh' }, fields: [f.maxPlayers(40, 70), { key: 'queryPort', type: 'number', label: L('Порт запроса', 'Query port'), default: 27015 }],
    args: (s) => ['-log', `-Port=${s.port}`, `-QueryPort=${s.queryPort}`, `-MaxPlayers=${s.maxPlayers}`],
    ports: (s) => [{ label: L('Игра', 'Game'), port: +s.port, proto: 'udp' }, { label: L('Игра +1', 'Game +1'), port: +s.port + 1, proto: 'udp', adjacent: 1 }, { label: L('Запрос', 'Query'), port: +s.queryPort, proto: 'udp', optional: true }] },
];

function splitArgs(text) {
  return ((text || '').match(/"[^"]*"|'[^']*'|\S+/g) || []).map((p) => p.replace(/^["']|["']$/g, ''));
}

function withDefaults(fields, settings) {
  const out = { ...settings };
  for (const fl of fields) if (out[fl.key] === undefined || out[fl.key] === '') if (fl.default !== undefined) out[fl.key] = fl.default;
  return out;
}

function buildSteam(def) {
  const fields = [f.port(def.port), ...(def.fields || []), f.branch(), f.extraArgs()];
  const exeRel = () => (isWin ? def.exe.win : def.exe.linux);
  return {
    kind: 'steam',
    name: def.name,
    appId: def.appId,
    color: def.color,
    tags: def.tags || [],
    ramGB: def.ramGB || 0,
    plugins: def.plugins || '',
    pdir: def.pdir || '',
    windowed: !!def.windowed && isWin,
    fields,
    defaultPort: def.port,
    protocol: def.proto,
    stopCommand: def.stop || '',
    ready: def.ready,
    ports: def.ports || ((s) => [{ label: L('Игра', 'Game'), port: +s.port, proto: def.proto }]),
    commands: def.proto === 'udp' && /srcds|hlds/.test(def.exe.win) ? sourceCommands : [],
    async versions() {
      return { latest: 'latest', versions: ['latest'] };
    },
    async install(server, dir, log) {
      await steamcmd.appUpdate({ appId: def.appId, installDir: dir, branch: server.settings.branch, extra: def.steamExtra, log });
      if (!fs.existsSync(path.join(dir, exeRel()))) log(`Предупреждение: файл ${exeRel()} не найден после установки. Проверьте «Параметры запуска».`);
    },
    applySettings() {},
    readSettings: (dir, s) => s,
    async command(server) {
      const s = withDefaults(fields, server.settings);
      const rel = exeRel();
      const full = path.join(server.dir, rel);
      if (!fs.existsSync(full)) throw new Error(`не найден ${rel}. Сервер ещё не установлен или игра поменяла структуру файлов: проверьте папку сервера.`);
      const args = [...def.args(s).map(String), ...splitArgs(s.extraArgs)];
      if (!isWin && /\.sh$/.test(rel)) return { cmd: 'bash', args: [full, ...args] };
      if (!isWin) try { fs.chmodSync(full, 0o755); } catch {}
      return { cmd: full, args };
    },
  };
}

const sourceCommands = ['status', 'users', 'kick', 'kickid', 'banid', 'banip', 'changelevel', 'map', 'maps *', 'sv_password', 'mp_timelimit', 'mp_friendlyfire', 'say', 'exec', 'rcon_password', 'sv_cheats', 'mp_restartgame', 'quit'];

// ---- Minecraft: сборки на основе Paper API и Purpur / Fabric ----

// ---- Terraria (vanilla) ----
function findFile(root, names) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch {}
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (names.includes(e.name)) return p;
    }
  }
  return '';
}

const terraria = {
  kind: 'download',
  name: 'Terraria',
  color: '#4c9a3d',
 
  tags: ['sandbox', 'coop'],
  ramGB: 1,
  plugins: '',
  fields: [
    f.port(7777),
    f.maxPlayers(8, 255),
    f.password(),
    { key: 'worldName', type: 'text', label: L('Название мира', 'World name'), default: 'Hearth' },
    { key: 'worldSize', type: 'select', label: L('Размер нового мира', 'New world size'), default: '2', options: [['1', L('Маленький', 'Small')], ['2', L('Средний', 'Medium')], ['3', L('Большой', 'Large')]] },
    f.extraArgs(),
  ],
  defaultPort: 7777,
  protocol: 'tcp',
  stopCommand: 'exit',
  ready: /Server started/i,
  ports: (s) => [{ label: 'TCP', port: +s.port, proto: 'tcp' }],
  commands: ['help', 'playing', 'kick', 'ban', 'say', 'save', 'settle', 'time', 'dawn', 'noon', 'dusk', 'midnight', 'exit', 'exit-nosave'],
  async versions() {
    return { latest: '1453', versions: ['1453', '1450', '1449', '1448', '1436'] };
  },
  async install(server, dir, log) {
    const ver = server.version === 'latest' ? '1453' : server.version;
    const archive = path.join(dir, `terraria-server-${ver}.zip`);
    log(`Скачиваю Terraria ${ver}…`);
    await downloadFile(`https://terraria.org/api/download/pc-dedicated-server/terraria-server-${ver}.zip`, archive, (g, t) => log(`Terraria: ${Math.round(g / 1048576)} МБ` + (t ? ` из ${Math.round(t / 1048576)}` : ''), t ? g / t : undefined));
    await new Promise((res, rej) => {
      const p = spawn(tarBin(), ['-xf', archive, '-C', dir], { windowsHide: true });
      p.on('error', rej);
      p.on('close', (c) => (c === 0 ? res() : rej(new Error('не удалось распаковать архив Terraria'))));
    });
    fs.rmSync(archive, { force: true });
    const bin = findFile(dir, isWin ? ['TerrariaServer.exe'] : ['TerrariaServer.bin.x86_64']);
    if (!bin) throw new Error('в архиве не найден TerrariaServer');
    server.settings.exe = path.relative(dir, bin);
  },
  applySettings(dir, s) {
    const cfg = [
      `world=${path.join(dir, 'Worlds', (s.worldName || 'Hearth') + '.wld')}`,
      `autocreate=${s.worldSize || 2}`,
      `worldname=${s.worldName || 'Hearth'}`,
      `maxplayers=${s.maxPlayers || 8}`,
      `port=${s.port || 7777}`,
      `password=${s.password || ''}`,
      'secure=1',
      'language=ru-RU',
    ];
    fs.mkdirSync(path.join(dir, 'Worlds'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'serverconfig.txt'), cfg.join('\n') + '\n');
  },
  readSettings: (dir, s) => s,
  async command(server) {
    const s = withDefaults(this.fields, server.settings);
    const rel = server.settings.exe;
    if (!rel || !fs.existsSync(path.join(server.dir, rel))) throw new Error('не найден TerrariaServer: переустановите сервер');
    const full = path.join(server.dir, rel);
    if (!isWin) try { fs.chmodSync(full, 0o755); } catch {}
    return { cmd: full, args: ['-config', path.join(server.dir, 'serverconfig.txt'), ...splitArgs(s.extraArgs)] };
  },
};

// ---- Любой сервер Steam по AppID ----
const steamCustom = {
  kind: 'steam',
  name: L('Любой сервер Steam (по AppID)', 'Any Steam server (by AppID)'),
  color: '#2a475e',
 
  tags: ['custom'],
  ramGB: 0,
  plugins: '',
  fields: [
    { key: 'appId', type: 'number', label: L('AppID сервера в Steam', 'Server AppID'), min: 1, default: 0, group: 'run', help: L('Номер выделенного сервера игры на steamdb.info или в документации игры.', 'Dedicated server AppID from steamdb.info or the game docs.') },
    { key: 'exe', type: 'text', label: L('Файл запуска (внутри папки сервера)', 'Executable (inside server folder)'), default: '', group: 'run', wide: true },
    { key: 'args', type: 'text', label: L('Параметры запуска', 'Launch arguments'), default: '', group: 'run', wide: true },
    f.port(27015),
    { key: 'protocol', type: 'select', label: L('Протокол порта', 'Port protocol'), default: 'udp', group: 'run', options: [['udp', 'UDP'], ['tcp', 'TCP'], ['http', 'HTTP(S)']] },
    { key: 'morePorts', type: 'text', label: L('Дополнительные порты', 'Extra ports'), default: '', group: 'run', help: L('Например: 27016/udp, 27017/tcp', 'Example: 27016/udp, 27017/tcp') },
    { key: 'stopCommand', type: 'text', label: L('Команда остановки (в консоль)', 'Stop command (to console)'), default: '', group: 'run' },
    f.branch(),
  ],
  defaultPort: 27015,
  protocol: 'udp',
  ports: (s) => portsFromText(s),
  commands: [],
  async versions() {
    return { latest: 'latest', versions: ['latest'] };
  },
  async install(server, dir, log) {
    const id = +server.settings.appId;
    if (!id) throw new Error('укажите AppID сервера в настройках');
    await steamcmd.appUpdate({ appId: id, installDir: dir, branch: server.settings.branch, log });
  },
  applySettings() {},
  readSettings: (dir, s) => s,
  async command(server) {
    const rel = (server.settings.exe || '').trim();
    if (!rel) throw new Error('укажите файл запуска (путь внутри папки сервера)');
    const full = path.isAbsolute(rel) ? rel : path.join(server.dir, rel);
    if (!fs.existsSync(full)) throw new Error('файл запуска не найден: ' + rel);
    const args = splitArgs(server.settings.args);
    if (!isWin && /\.sh$/.test(full)) return { cmd: 'bash', args: [full, ...args] };
    if (!isWin) try { fs.chmodSync(full, 0o755); } catch {}
    return { cmd: full, args };
  },
};

// "27015/udp, 27016/tcp" → [{port, proto}]
function parsePortList(text) {
  const out = [];
  for (const part of String(text || '').split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d{1,5})(?:\/(tcp|udp|http))?$/i.exec(part);
    if (m && +m[1] > 0 && +m[1] < 65536) out.push({ port: +m[1], proto: (m[2] || 'tcp').toLowerCase() });
  }
  return out;
}

function portsFromText(s) {
  const main = { label: L('Основной порт', 'Main port'), port: +s.port || 0, proto: s.protocol || 'tcp' };
  const more = parsePortList(s.morePorts).map((p, i) => ({ label: L('Порт ' + (i + 2), 'Port ' + (i + 2)), ...p }));
  return main.port ? [main, ...more] : more;
}

module.exports = { steamGames: STEAM.map((d) => [d.id, buildSteam(d)]), terraria, steamCustom, parsePortList, portsFromText, splitArgs, findFile, L };
