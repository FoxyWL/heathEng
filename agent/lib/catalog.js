'use strict';
const fs = require('fs');
const path = require('path');
const { getJson, downloadFile } = require('./download');
const { ensureJava, requiredMajor } = require('./java');
const gd = require('./gamedefs');

const L = (ru, en) => ({ ru, en });

const mcFields = [
  { key: 'memory', type: 'number', label: L('Память, МБ', 'Memory, MB'), min: 512, max: 65536, step: 256, default: 2048, group: 'run', help: L('Сколько памяти получит сервер. 2–4 ГБ хватает на 5–10 игроков.', 'How much memory the server gets. 2–4 GB is enough for 5–10 players.') },
  { key: 'port', type: 'number', label: L('Порт', 'Port'), min: 1024, max: 65535, default: 25565, group: 'run', help: L('Локальный порт сервера. Менять нужно, только если он занят.', 'Local server port. Change it only if it is busy.') },
  { key: 'motd', type: 'text', label: L('Описание сервера', 'Server description'), default: 'A Hearth server', prop: 'motd' },
  { key: 'maxPlayers', type: 'number', label: L('Макс. игроков', 'Max players'), min: 1, max: 1000, default: 10, prop: 'max-players', help: L('Сколько игроков может быть на сервере одновременно.', 'How many players can be on the server at once.') },
  {
    key: 'difficulty', type: 'select', label: L('Сложность', 'Difficulty'), default: 'normal', prop: 'difficulty',
    options: [['peaceful', L('Мирная', 'Peaceful')], ['easy', L('Лёгкая', 'Easy')], ['normal', L('Нормальная', 'Normal')], ['hard', L('Сложная', 'Hard')]],
  },
  {
    key: 'gamemode', type: 'select', label: L('Режим игры', 'Game mode'), default: 'survival', prop: 'gamemode',
    options: [['survival', L('Выживание', 'Survival')], ['creative', L('Творчество', 'Creative')], ['adventure', L('Приключение', 'Adventure')], ['spectator', L('Наблюдатель', 'Spectator')]],
  },
  { key: 'pvp', type: 'bool', label: L('PvP между игроками', 'Player vs player'), default: true, prop: 'pvp' },
  { key: 'hardcore', type: 'bool', label: L('Хардкор', 'Hardcore'), default: false, prop: 'hardcore' },
  { key: 'whitelist', type: 'bool', label: L('Только по белому списку', 'Whitelist only'), default: false, prop: 'white-list', help: L('Заходить смогут только игроки из белого списка (команда whitelist add).', 'Only whitelisted players can join (whitelist add command).') },
  { key: 'onlineMode', type: 'bool', label: L('Проверять лицензию (online-mode)', 'Verify accounts (online-mode)'), default: true, prop: 'online-mode', help: L('Отключайте только для пиратских клиентов: это снижает безопасность.', 'Turn off only for cracked clients: it lowers security.') },
  { key: 'viewDistance', type: 'number', label: L('Дальность прорисовки', 'View distance'), min: 3, max: 32, default: 10, prop: 'view-distance', help: L('Чем больше, тем красивее, но тяжелее серверу.', 'Higher looks better but is heavier on the server.') },
  { key: 'seed', type: 'text', label: L('Seed мира', 'World seed'), default: '', prop: 'level-seed' },
  { key: 'javaArgs', type: 'text', label: L('Параметры Java (JVM)', 'Java (JVM) flags'), default: '', group: 'run', wide: true, help: L('Например: -XX:+UseG1GC. Оставьте пустым, если не уверены.', 'Example: -XX:+UseG1GC. Leave empty if unsure.') },
  { key: 'extraArgs', type: 'text', label: L('Параметры сервера', 'Server arguments'), default: '', group: 'run', wide: true, help: L('Добавляются после nogui.', 'Appended after nogui.') },
  { key: 'acceptEula', type: 'bool', label: L('Принимаю EULA Minecraft (aka.ms/MinecraftEULA)', 'I accept the Minecraft EULA (aka.ms/MinecraftEULA)'), default: false, group: 'run' },
];

function parseProps(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
    if (m) map.set(m[1].trim(), m[2]);
  }
  return map;
}

function applyProps(dir, settings, fields) {
  const file = path.join(dir, 'server.properties');
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {}
  const wanted = new Map();
  for (const f of fields) {
    if (!f.prop) continue;
    const v = settings[f.key];
    if (v === undefined || v === '') {
      if (f.key === 'seed') wanted.set(f.prop, '');
      continue;
    }
    wanted.set(f.prop, typeof v === 'boolean' ? String(v) : String(v));
  }
  wanted.set('server-port', String(settings.port));
  const seen = new Set();
  lines = lines.map((l) => {
    const m = /^([^#=\s][^=]*)=/.exec(l);
    if (m && wanted.has(m[1].trim())) {
      seen.add(m[1].trim());
      return `${m[1].trim()}=${wanted.get(m[1].trim())}`;
    }
    return l;
  });
  for (const [k, v] of wanted) if (!seen.has(k)) lines.push(`${k}=${v}`);
  fs.writeFileSync(file, lines.filter((l, i, a) => !(l === '' && i === a.length - 1)).join('\n') + '\n');
}

function readProps(dir, fields, settings) {
  try {
    const map = parseProps(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'));
    const out = { ...settings };
    for (const f of fields) {
      if (!f.prop || !map.has(f.prop)) continue;
      const raw = map.get(f.prop);
      out[f.key] = f.type === 'bool' ? raw === 'true' : f.type === 'number' ? +raw : raw;
    }
    if (map.has('server-port')) out.port = +map.get('server-port');
    return out;
  } catch {
    return settings;
  }
}

function writeEula(dir, accepted) {
  fs.writeFileSync(path.join(dir, 'eula.txt'), `eula=${accepted ? 'true' : 'false'}\n`);
}

function mcSettingsApply(dir, settings) {
  applyProps(dir, settings, mcFields);
  writeEula(dir, !!settings.acceptEula);
}

function mcCommand(server, javaBin) {
  const s = server.settings;
  const mem = Math.max(512, +s.memory || 2048);
  const jar = s.jar || 'server.jar';
  return {
    cmd: javaBin,
    args: [`-Xms${Math.min(mem, 1024)}M`, `-Xmx${mem}M`, ...gd.splitArgs(s.javaArgs), '-jar', jar, 'nogui', ...gd.splitArgs(s.extraArgs)],
  };
}

const mcReady = /Done \([\d.,]+s\)!/;


const mcCommands = ['help', 'list', 'say', 'tell', 'msg', 'kick', 'ban', 'ban-ip', 'pardon', 'op', 'deop', 'whitelist add', 'whitelist remove', 'whitelist list', 'whitelist on', 'whitelist off', 'gamemode', 'difficulty', 'time set', 'weather', 'tp', 'give', 'kill', 'effect', 'enchant', 'xp', 'clear', 'gamerule', 'seed', 'setworldspawn', 'spawnpoint', 'save-all', 'save-off', 'save-on', 'stop', 'reload', 'plugins', 'version', 'tps'];

function mcBase(name, color, plugins) {
  return {
    kind: 'minecraft',
    name,
    color,
    tags: ['survival', 'sandbox'],
    ramGB: 2,
    plugins,
    fields: mcFields,
    defaultPort: 25565,
    protocol: 'tcp',
    stopCommand: 'stop',
    ready: mcReady,
    commands: mcCommands,
    ports: (s) => [{ label: L('Игра (Java)', 'Game (Java)'), port: +s.port || 25565, proto: 'tcp' }],
    applySettings: mcSettingsApply,
    readSettings: (dir, settings) => readProps(dir, mcFields, settings),
    async command(server, log, dry) {
      const java = dry ? 'java' : await ensureJava(requiredMajor(server.version), log);
      return mcCommand(server, java);
    },
  };
}

// PaperMC: основной API Fill v3, запасной (старый) v2. Для тестов адрес меняется переменной HEARTH_PAPER_API.
const FILL = () => process.env.HEARTH_PAPER_API || 'https://fill.papermc.io/v3';
const PAPER_V2 = () => process.env.HEARTH_PAPER_V2_API || 'https://api.papermc.io/v2';

async function paperVersions(project) {
  try {
    const p = await getJson(`${FILL()}/projects/${project}`);
    const vs = Array.isArray(p.versions) ? p.versions : Object.values(p.versions || {}).flat();
    if (vs.length) return vs;
  } catch { /* запасной вариант ниже */ }
  const p = await getJson(`${PAPER_V2()}/projects/${project}`);
  return p.versions.slice().reverse();
}

async function paperBuild(project, version) {
  try {
    const list = await getJson(`${FILL()}/projects/${project}/versions/${version}/builds`);
    const builds = (Array.isArray(list) ? list : []).filter((b) => b.downloads && b.downloads['server:default']);
    const best = builds.find((b) => b.channel === 'STABLE') || builds[0];
    if (best) {
      const d = best.downloads['server:default'];
      return { name: d.name, url: d.url, sha256: d.checksums && d.checksums.sha256, build: best.id };
    }
  } catch { /* запасной вариант ниже */ }
  const b = await getJson(`${PAPER_V2()}/projects/${project}/versions/${version}/builds`);
  const build = b.builds[b.builds.length - 1];
  if (!build) throw new Error(`нет сборок ${project} для ${version}`);
  const name = build.downloads.application.name;
  return { name, url: `${PAPER_V2()}/projects/${project}/versions/${version}/builds/${build.build}/downloads/${name}`, sha256: build.downloads.application.sha256, build: build.build };
}

function mcPaperLike(project, name, color) {
  return {
    ...mcBase(name, color, 'plugins'),
    async versions() {
      const vs = await paperVersions(project);
      return { latest: vs[0], versions: vs };
    },
    async install(server, dir, log) {
      const b = await paperBuild(project, server.version);
      log(`Скачиваю ${b.name}…`);
      await downloadFile(b.url, path.join(dir, 'server.jar'), (g, t) => log(`${b.name}: ${Math.round(g / 1024)} КБ` + (t ? ` из ${Math.round(t / 1024)}` : ''), t ? g / t : undefined), b.sha256);
      server.settings.jar = 'server.jar';
    },
  };
}

const games = {
  'minecraft-vanilla': {
    ...mcBase('Minecraft: Java Edition (Vanilla)', '#5b9a3c', ''),
    async versions() {
      const m = await getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
      return {
        latest: m.latest.release,
        versions: m.versions.filter((v) => v.type === 'release').map((v) => v.id),
      };
    },
    async install(server, dir, log) {
      const manifest = await getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
      const entry = manifest.versions.find((v) => v.id === server.version);
      if (!entry) throw new Error('версия не найдена: ' + server.version);
      const meta = await getJson(entry.url);
      const dl = meta.downloads && meta.downloads.server;
      if (!dl) throw new Error('для этой версии нет серверной сборки');
      log(`Скачиваю server.jar ${server.version}…`);
      await downloadFile(dl.url, path.join(dir, 'server.jar'), (g, t) => log(`server.jar: ${Math.round(g / 1024)} КБ` + (t ? ` из ${Math.round(t / 1024)}` : ''), t ? g / t : undefined));
      server.settings.jar = 'server.jar';
    },
  },
  'minecraft-paper': mcPaperLike('paper', 'Minecraft: Java Edition (Paper)', '#3b82c4'),
  'minecraft-folia': mcPaperLike('folia', 'Minecraft: Java Edition (Folia)', '#4aa88a'),
  'minecraft-purpur': {
    ...mcBase('Minecraft: Java Edition (Purpur)', '#7a4fc4', 'plugins'),
    async versions() {
      const p = await getJson('https://api.purpurmc.org/v2/purpur');
      const vs = p.versions.slice().reverse();
      return { latest: vs[0], versions: vs };
    },
    async install(server, dir, log) {
      const v = await getJson(`https://api.purpurmc.org/v2/purpur/${server.version}`);
      const build = v.builds && v.builds.latest;
      if (!build) throw new Error('нет сборок Purpur для ' + server.version);
      log(`Скачиваю Purpur ${server.version} #${build}…`);
      await downloadFile(`https://api.purpurmc.org/v2/purpur/${server.version}/${build}/download`, path.join(dir, 'server.jar'), (g, t) => log(`Purpur: ${Math.round(g / 1024)} КБ` + (t ? ` из ${Math.round(t / 1024)}` : ''), t ? g / t : undefined));
      server.settings.jar = 'server.jar';
    },
  },
  'minecraft-fabric': {
    ...mcBase('Minecraft: Java Edition (Fabric)', '#c9b27c', 'mods'),
    async versions() {
      const g = await getJson('https://meta.fabricmc.net/v2/versions/game');
      const vs = g.filter((x) => x.stable).map((x) => x.version);
      return { latest: vs[0], versions: vs };
    },
    async install(server, dir, log) {
      const [loaders, installers] = await Promise.all([getJson('https://meta.fabricmc.net/v2/versions/loader'), getJson('https://meta.fabricmc.net/v2/versions/installer')]);
      const loader = (loaders.find((l) => l.stable) || loaders[0]).version;
      const inst = (installers.find((i) => i.stable) || installers[0]).version;
      log(`Скачиваю Fabric ${server.version} (loader ${loader})…`);
      await downloadFile(`https://meta.fabricmc.net/v2/versions/loader/${server.version}/${loader}/${inst}/server/jar`, path.join(dir, 'server.jar'), (g, t) => log(`Fabric: ${Math.round(g / 1024)} КБ` + (t ? ` из ${Math.round(t / 1024)}` : ''), t ? g / t : undefined));
      server.settings.jar = 'server.jar';
      fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
    },
  },
  terraria: gd.terraria,
  custom: {
    kind: 'custom',
    name: L('Свой сервер (любая игра)', 'Custom server (any game)'),
    color: '#64748b',
    tags: ['custom'],
    ramGB: 0,
    plugins: '',
    fields: [
      { key: 'command', type: 'text', label: L('Команда запуска', 'Start command'), default: '', group: 'run', wide: true, help: L('Например: "D:\\Games\\Server\\server.exe" -port 27015. Папка сервера — рабочая папка процесса.', 'Example: "D:\\Games\\Server\\server.exe" -port 27015. The server folder is the working directory.') },
      { key: 'port', type: 'number', label: L('Порт', 'Port'), min: 1, max: 65535, default: 25565, group: 'run' },
      { key: 'protocol', type: 'select', label: L('Протокол порта', 'Port protocol'), default: 'tcp', group: 'run', options: [['tcp', 'TCP'], ['udp', 'UDP'], ['http', 'HTTP(S)']] },
      { key: 'morePorts', type: 'text', label: L('Дополнительные порты', 'Extra ports'), default: '', group: 'run', help: L('Если игре нужно несколько портов. Например: 27016/udp, 27017/tcp', 'If the game needs several ports. Example: 27016/udp, 27017/tcp') },
      { key: 'stopCommand', type: 'text', label: L('Команда остановки (в консоль)', 'Stop command (to console)'), default: '', group: 'run' },
    ],
    defaultPort: 25565,
    protocol: 'tcp',
    commands: [],
    ports: (s) => gd.portsFromText(s),
    async versions() {
      return { latest: 'custom', versions: ['custom'] };
    },
    async install() {},
    applySettings() {},
    readSettings: (dir, s) => s,
    async command(server) {
      const clean = gd.splitArgs(server.settings.command);
      if (!clean.length) throw new Error('не задана команда запуска');
      return { cmd: clean[0], args: clean.slice(1) };
    },
  },
  'steam-custom': gd.steamCustom,
};

for (const [id, g] of gd.steamGames) games[id] = g;

function portsOf(gameId, settings) {
  const g = games[gameId];
  if (!g) return [];
  const st = { ...settings };
  for (const fl of g.fields) if ((st[fl.key] === undefined || st[fl.key] === '') && fl.default !== undefined) st[fl.key] = fl.default;
  if (g.ports) return g.ports(st).filter((p) => p.port > 0);
  return [{ label: L('Игра', 'Game'), port: +st.port, proto: st.protocol || g.protocol || 'tcp' }];
}

function describe() {
  return Object.entries(games).map(([id, g]) => ({
    id,
    name: g.name,
    kind: g.kind || 'custom',
    fields: g.fields,
    defaultPort: g.defaultPort,
    protocol: g.protocol,
    tags: g.tags || [],
    ramGB: g.ramGB || 0,
    plugins: g.plugins || '',
    color: g.color || '#64748b',
    steam: !!g.appId || g.kind === 'steam',
    commands: g.commands || [],
    importable: true,
    sources: require('./sources').forGame(id),
  }));
}

function detectJar(dir) {
  try {
    const jars = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jar'));
    if (jars.includes('server.jar')) return 'server.jar';
    return jars.find((j) => /paper|purpur|spigot|fabric|forge|server/i.test(j)) || jars[0] || '';
  } catch {
    return '';
  }
}

module.exports = { games, describe, detectJar, portsOf };
