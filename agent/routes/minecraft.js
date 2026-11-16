'use strict';
// Маршруты Minecraft и модов: игроки, плагины и моды, мир.
const fs = require('fs');
const path = require('path');

module.exports = function minecraftRoutes({ on, mgr, store, files, modrinth, catalog, spawn, tarBin, backupDir }) {
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

};
