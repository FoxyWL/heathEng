'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const { games, detectJar, portsOf } = require('./catalog');
const { requiredMajor } = require('./java');
const gamedefs = require('./gamedefs');
const publicname = require('./publicname');
const { rssMb } = require('./sysinfo');
const { resolveSpawn } = require('./winutil');
const { Core } = require('./core');
const { Capacity } = require('./capacity');

const MAX_LOG = 3000;
const isWin = process.platform === 'win32';

class Manager {
  constructor(emit) {
    this.emit = emit;
    this.rt = new Map();
    for (const s of store.state.servers) this._rt(s.id);
    // Нативное ядро (Rust) считает CPU и память всего дерева процессов; запасной путь — опрос памяти.
    this.core = new Core(store.paths.runtime);
    this.core.on('stats', (items) => this._applyStats(items));
    this.core.start();
    this.cap = new Capacity(this);
    this.memTimer = setInterval(() => this._pollMem(), 5000);
    if (this.memTimer.unref) this.memTimer.unref();
    this.syncTimer = setInterval(() => this._syncCore(), 1000);
    if (this.syncTimer.unref) this.syncTimer.unref();
  }

  _syncCore() {
    const pids = [];
    for (const r of this.rt.values()) if (r.child && r.child.pid && ['running', 'starting', 'stopping'].includes(r.state)) pids.push(r.child.pid);
    this.core.watch(pids);
  }

  _applyStats(items) {
    const byPid = new Map(items.map((i) => [i.pid, i]));
    for (const s of store.state.servers) {
      const r = this.rt.get(s.id);
      if (!r || !r.child) continue;
      const it = byPid.get(r.child.pid);
      if (!it || it.gone) continue;
      const mb = Math.round(it.rss / 1048576);
      const cpu = Math.round(it.cpu * 10) / 10;
      if (Math.abs(mb - r.mem) >= 2 || Math.abs(cpu - (r.cpu || 0)) >= 0.5 || r.procs !== it.procs) {
        r.mem = mb;
        r.cpu = cpu;
        r.procs = it.procs;
        this.cap.watch(s, r, mb);
        this.emit('state', this.view(s));
      }
    }
  }

  async _pollMem() {
    if (this.core.ok) return;
    for (const s of store.state.servers) {
      const r = this.rt.get(s.id);
      if (!r || !r.child || !['running', 'starting'].includes(r.state)) continue;
      const mb = await rssMb(r.child.pid);
      if (mb !== r.mem && r.child) {
        r.mem = mb;
        this.emit('state', this.view(s));
      }
    }
  }

  runningCount() {
    let n = 0;
    for (const r of this.rt.values()) if (r.child) n++;
    return n;
  }

  _rt(id) {
    let r = this.rt.get(id);
    if (!r) {
      r = { state: 'stopped', child: null, logs: [], seq: 0, crashes: [], userStop: false, startedAt: 0, msg: '', pct: null, players: new Set(), mem: 0, partial: { out: '', err: '' }, timers: {} };
      this.rt.set(id, r);
    }
    return r;
  }

  rec(id) {
    const s = store.state.servers.find((x) => x.id === id);
    if (!s) throw Object.assign(new Error('сервер не найден'), { status: 404 });
    return s;
  }

  view(s) {
    const r = this._rt(s.id);
    return {
      rev: ++Manager.revSeq,
      id: s.id,
      name: s.name,
      game: s.game,
      version: s.version,
      dir: s.dir,
      imported: !!s.imported,
      settings: s.settings,
      autoRestart: !!s.autoRestart,
      autostart: !!s.autostart,
      tunnel: s.tunnel,
      netName: s.netName || '',
      iconRev: s.iconRev || 0,
      publicIp: s.publicIp && s.publicIp.enabled ? { ...s.publicIp, host: publicname.hostFor(s) } : s.publicIp || { enabled: false },
      state: r.state,
      msg: r.msg,
      pct: r.pct,
      mem: r.mem,
      kind: (games[s.game] && games[s.game].kind) || 'custom',
      java: s.game.startsWith('minecraft') ? requiredMajor(s.version) : 0,
      ports: portsOf(s.game, s.settings).map((p) => ({ label: p.label, port: p.port, proto: p.proto, optional: !!p.optional, adjacent: p.adjacent || 0 })),
      plugins: (games[s.game] && games[s.game].plugins) || '',
      cpu: r.child ? r.cpu || 0 : null,
      memLimit: s.game.startsWith('minecraft') ? Math.max(512, +s.settings.memory || 2048) : +s.settings.memory || null,
      players: s.game.startsWith('minecraft') && r.child ? r.players.size : null,
      playerNames: s.game.startsWith('minecraft') && r.child ? [...r.players] : [],
      maxPlayers: s.game.startsWith('minecraft') ? +s.settings.maxPlayers || null : null,
      startedAt: r.startedAt,
      pid: r.child ? r.child.pid : 0,
      restartRequired: !!r.restartRequired,
      cpuSet: r.child && r.cpuSet ? r.cpuSet : [],
      limits: s.limits || {},
      createdAt: s.createdAt,
    };
  }

  list() {
    return store.state.servers.map((s) => this.view(s));
  }

  _setState(s, state, msg) {
    const r = this._rt(s.id);
    r.state = state;
    r.msg = msg || '';
    if (state === 'stopped' || state === 'crashed') r.restartRequired = false;
    this.emit('state', this.view(s));
  }

  _log(s, k, text) {
    const r = this._rt(s.id);
    const line = { n: ++r.seq, ts: Date.now(), k, text };
    r.logs.push(line);
    if (r.logs.length > MAX_LOG) r.logs.splice(0, r.logs.length - MAX_LOG);
    this.emit('log', { id: s.id, line });
  }

  logs(id, { search = '', limit = 500, onlyErrors = false } = {}) {
    const r = this._rt(id);
    let out = r.logs;
    if (search) {
      const q = search.toLowerCase();
      out = out.filter((l) => l.text.toLowerCase().includes(q));
    }
    if (onlyErrors) out = out.filter((l) => l.k === 'err' || /\b(ERROR|SEVERE|FATAL|Exception|WARN)\b/.test(l.text));
    return out.slice(-limit);
  }

  clearLogs(id) {
    const r = this._rt(id);
    this.rec(id);
    r.logs = [];
    this.emit('cleared', { id });
  }

  async create(spec) {
    const g = games[spec.game];
    if (!g) throw Object.assign(new Error('неизвестная игра'), { status: 400 });
    const imported = !!spec.importDir;
    if (!imported) await this.cap.checkCreate();
    const id = store.uid('srv');
    let dir;
    if (imported) {
      dir = path.resolve(spec.importDir);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw Object.assign(new Error('папка не найдена: ' + dir), { status: 400 });
    } else {
      dir = path.join(store.paths.servers, id);
      fs.mkdirSync(dir, { recursive: true });
    }
    const defaults = {};
    for (const f of g.fields) defaults[f.key] = f.default;
    let settings = { ...defaults, ...(spec.settings || {}) };
    if (imported && g.readSettings) settings = g.readSettings(dir, settings);
    if (imported && spec.game.startsWith('minecraft')) settings.jar = detectJar(dir) || 'server.jar';
    if (spec.command) settings.command = spec.command;
    if (spec.game === 'custom' && !settings.command) throw Object.assign(new Error('укажите команду запуска'), { status: 400 });
    if (spec.game === 'steam-custom' && !imported && !+settings.appId) throw Object.assign(new Error('укажите AppID сервера в Steam'), { status: 400 });
    if (imported && spec.game === 'terraria') {
      const bin = gamedefs.findFile(dir, process.platform === 'win32' ? ['TerrariaServer.exe'] : ['TerrariaServer.bin.x86_64']);
      if (bin) settings.exe = path.relative(dir, bin);
    }
    const s = {
      id,
      name: String(spec.name || (typeof g.name === 'string' ? g.name : g.name.ru)).slice(0, 60),
      game: spec.game,
      version: spec.version || 'custom',
      dir,
      imported,
      settings,
      autoRestart: spec.autoRestart !== false,
      tunnel: { enabled: false, subdomain: '', remotePort: 0, protocol: settings.protocol || g.protocol, ports: {} },
      createdAt: Date.now(),
    };
    store.state.servers.push(s);
    store.saveState();
    this._rt(id);
    if (imported || g.kind === 'custom') {
      this._setState(s, 'stopped');
      this._log(s, 'sys', imported ? `Подключена существующая папка: ${dir}` : 'Сервер создан');
    } else {
      this._setState(s, 'installing', 'Подготовка…');
      this._install(s).catch(() => {});
    }
    return this.view(s);
  }

  async _install(s) {
    const g = games[s.game];
    const r0 = this._rt(s.id);
    r0.pct = null;
    const log = (m, frac) => {
      r0.msg = m;
      if (typeof frac !== 'number') this._log(s, 'sys', m); // этапы установки — в журнал, проценты — только в индикатор
      if (typeof frac === 'number') r0.pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
      this.emit('install', { id: s.id, msg: m, pct: r0.pct });
    };
    try {
      await g.install(s, s.dir, log);
      g.applySettings(s.dir, s.settings);
      if (g.command && s.game.startsWith('minecraft')) {
        const { requiredMajor, ensureJava } = require('./java');
        await ensureJava(requiredMajor(s.version), log);
      }
      store.saveState();
      this._log(s, 'sys', `Установлено: ${typeof g.name === 'string' ? g.name : g.name.ru} ${s.version}`);
      r0.pct = null;
      this._setState(s, 'stopped');
    } catch (e) {
      this._log(s, 'err', 'Ошибка установки: ' + e.message);
      r0.pct = null;
      this._setState(s, 'error', e.message);
    }
  }

  async retryInstall(id) {
    const s = this.rec(id);
    this._setState(s, 'installing', 'Повторная установка…');
    this._install(s).catch(() => {});
    return this.view(s);
  }

  update(id, patch) {
    const s = this.rec(id);
    const r = this._rt(id);
    const g = games[s.game];
    if (patch.name) s.name = String(patch.name).slice(0, 60);
    if (typeof patch.autoRestart === 'boolean') s.autoRestart = patch.autoRestart;
    if (typeof patch.autostart === 'boolean') s.autostart = patch.autostart;
    if (patch.tunnel) s.tunnel = { ...s.tunnel, ...patch.tunnel };
    if (patch.settings) {
      s.settings = { ...s.settings, ...patch.settings };
      if (r.state === 'running' || r.state === 'starting') r.restartRequired = true;
      else {
        try {
          g.applySettings(s.dir, s.settings);
        } catch (e) {
          this._log(s, 'err', 'Не удалось записать настройки: ' + e.message);
        }
      }
    }
    store.saveState();
    this.emit('state', this.view(s));
    return this.view(s);
  }

  _pump(s, stream, kind) {
    const r = this._rt(s.id);
    stream.on('data', (chunk) => {
      r.partial[kind] += chunk.toString('utf8');
      const parts = r.partial[kind].split(/\r?\n/);
      r.partial[kind] = parts.pop();
      for (const text of parts) {
        this._log(s, kind, text);
        this._trackPlayers(s, r, text);
        const g = games[s.game];
        if (r.state === 'starting' && g.ready && g.ready.test(text)) this._setState(s, 'running');
      }
    });
    stream.on('end', () => {
      if (r.partial[kind]) {
        this._log(s, kind, r.partial[kind]);
        r.partial[kind] = '';
      }
    });
  }

  _trackPlayers(s, r, text) {
    if (!s.game.startsWith('minecraft')) return;
    let m;
    let changed = false;
    if ((m = /: (\S+) joined the game\s*$/.exec(text))) {
      r.players.add(m[1]);
      changed = true;
    } else if ((m = /: (\S+) left the game\s*$/.exec(text))) {
      r.players.delete(m[1]);
      changed = true;
    } else if ((m = /There are (\d+) of a max of \d+ players online:?\s*(.*)$/.exec(text))) {
      r.players = new Set(m[2].split(',').map((x) => x.trim()).filter(Boolean));
      changed = true;
    }
    if (changed) this.emit('state', this.view(s));
  }

  async start(id) {
    const s = this.rec(id);
    const r = this._rt(id);
    if (['running', 'starting', 'installing', 'stopping'].includes(r.state)) return this.view(s);
    const g = games[s.game];
    if (s.game.startsWith('minecraft') && !s.settings.acceptEula) throw Object.assign(new Error('Примите EULA Minecraft в настройках сервера'), { status: 400 });
    this.cap.checkStart(s);
    this._setState(s, 'starting', 'Подготовка запуска…');
    try {
      g.applySettings(s.dir, s.settings);
      const { cmd, args } = await g.command(s, (m) => this._log(s, 'sys', m));
      r.userStop = false;
      r.players.clear();
      this._log(s, 'sys', `Запуск: ${cmd} ${args.join(' ')}`);
      const sp = resolveSpawn(cmd, args, s.dir);
      const child = spawn(sp.cmd, sp.args, { cwd: s.dir, windowsHide: !g.windowed, stdio: ['pipe', 'pipe', 'pipe'], ...sp.opts });
      r.child = child;
      r.startedAt = Date.now();
      r.ramWarned = false;
      r.ramOver = 0;
      // привязка к ядрам и приоритет по бюджету мощностей; повтор нужен для процессов, запущенных сервером позже
      this.cap.applyAll();
      for (const ms of [2500, 15000]) {
        const t = setTimeout(() => r.child === child && this.cap.applyTo(s).catch(() => {}), ms);
        if (t.unref) t.unref();
      }
      child.stdin.on('error', () => {});
      this._pump(s, child.stdout, 'out');
      this._pump(s, child.stderr, 'err');
      child.on('error', (e) => {
        this._log(s, 'err', 'Не удалось запустить процесс: ' + e.message);
      });
      child.on('close', (code, sig) => this._onExit(s, code, sig));
      if (!g.ready) setTimeout(() => r.state === 'starting' && r.child === child && this._setState(s, 'running'), 1500);
      else
        r.timers.ready = setTimeout(() => {
          if (r.state === 'starting' && r.child === child) this._setState(s, 'running');
        }, 180000);
    } catch (e) {
      this._log(s, 'err', e.message);
      this._setState(s, 'crashed', e.message);
      throw e;
    }
    return this.view(s);
  }

  _onExit(s, code, sig) {
    const r = this._rt(s.id);
    clearTimeout(r.timers.ready);
    clearTimeout(r.timers.kill);
    r.child = null;
    r.startedAt = 0;
    r.players.clear();
    r.mem = 0;
    r.cpu = 0;
    r.cpuSet = [];
    setTimeout(() => this.cap.applyAll(), 0);
    const runtime = `код ${code}${sig ? ', сигнал ' + sig : ''}`;
    if (r.userStop) {
      this._log(s, 'sys', `Сервер остановлен (${runtime})`);
      this._setState(s, 'stopped');
      if (r.afterStop) {
        const fn = r.afterStop;
        r.afterStop = null;
        fn();
      }
      return;
    }
    this._log(s, 'err', `Сервер завершился неожиданно (${runtime})`);
    const now = Date.now();
    r.crashes = r.crashes.filter((t) => now - t < 10 * 60000);
    r.crashes.push(now);
    if (s.autoRestart && r.crashes.length <= 5) {
      const wait = 3000 * r.crashes.length;
      this._setState(s, 'crashed', `Перезапуск через ${Math.round(wait / 1000)} с`);
      this._log(s, 'sys', `Автоперезапуск через ${Math.round(wait / 1000)} с (попытка ${r.crashes.length} из 5)`);
      r.timers.restart = setTimeout(() => {
        this.start(s.id).catch(() => {});
      }, wait);
    } else {
      this._setState(s, 'crashed', s.autoRestart ? 'Слишком много падений подряд, автоперезапуск отключён' : 'Сервер упал');
    }
  }

  stop(id) {
    const s = this.rec(id);
    const r = this._rt(id);
    clearTimeout(r.timers.restart);
    if (!r.child) {
      if (r.state === 'crashed') this._setState(s, 'stopped');
      return this.view(s);
    }
    if (r.state === 'stopping') return this.view(s);
    r.userStop = true;
    this._setState(s, 'stopping');
    const g = games[s.game];
    const stopCmd = g.stopCommand || s.settings.stopCommand;
    if (stopCmd) {
      this._log(s, 'in', stopCmd);
      try {
        r.child.stdin.write(stopCmd + '\n');
      } catch {}
    } else {
      this._terminate(r.child, false);
    }
    r.timers.kill = setTimeout(() => {
      if (r.child) {
        this._log(s, 'sys', 'Сервер не остановился за 30 с, завершаю принудительно');
        this._terminate(r.child, true);
      }
    }, 30000);
    return this.view(s);
  }

  kill(id) {
    const s = this.rec(id);
    const r = this._rt(id);
    clearTimeout(r.timers.restart);
    if (r.child) {
      r.userStop = true;
      this._terminate(r.child, true);
    }
    return this.view(s);
  }

  _terminate(child, force) {
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    else child.kill(force ? 'SIGKILL' : 'SIGTERM');
  }

  restart(id) {
    const s = this.rec(id);
    const r = this._rt(id);
    if (!r.child) return this.start(id);
    r.afterStop = () => this.start(id).catch(() => {});
    this.stop(id);
    return this.view(s);
  }

  stopAndWait(id) {
    const r = this._rt(id);
    if (!r.child) return Promise.resolve();
    return new Promise((res) => {
      const prev = r.afterStop;
      r.afterStop = () => {
        if (prev) prev();
        res();
      };
      this.stop(id);
    });
  }

  markRestartRequired(id) {
    const r = this.rt.get(id);
    if (r && (r.state === 'running' || r.state === 'starting')) {
      r.restartRequired = true;
      this.emit('state', this.view(this.rec(id)));
    }
  }

  send(id, text) {
    const s = this.rec(id);
    const r = this._rt(id);
    if (!r.child || !r.child.stdin.writable) throw Object.assign(new Error('сервер не запущен'), { status: 409 });
    this._log(s, 'in', text);
    r.child.stdin.write(text + '\n');
  }

  /**
   * Удаляет сервер из Hearth. С deleteFiles стирает и остатки: папку сервера, бэкапы, расписание, свои туннели.
   * Папку, подключённую по пути (imported), Hearth не трогает: она не копировалась и принадлежит пользователю.
   * Возвращает отчёт: что удалено, что осталось на диске и сколько места освобождено.
   */
  async remove(id, deleteFiles) {
    const s = this.rec(id);
    const r = this._rt(id);
    clearTimeout(r.timers.restart);
    r.userStop = true;
    if (r.child) {
      const child = r.child;
      const gone = new Promise((resolve) => child.once('exit', resolve));
      this._terminate(child, true);
      await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 15000))]); // на Windows файлы заняты, пока процесс жив
    }
    store.state.servers = store.state.servers.filter((x) => x.id !== id);
    store.state.tasks = store.state.tasks.filter((t) => t.serverId !== id);
    store.state.tunnels = (store.state.tunnels || []).filter((t) => t.serverId !== id);
    store.saveState();
    this.rt.delete(id);
    require('./icons').clearCustom(id);
    const report = { deleted: [], kept: [], leftover: [], freedMb: 0 };
    if (s.imported) report.kept.push(s.dir);
    if (deleteFiles) {
      const targets = [];
      if (!s.imported) targets.push(s.dir);
      targets.push(path.join(store.paths.backups, id));
      for (const dir of targets) {
        if (!fs.existsSync(dir)) continue;
        const mb = dirSizeMb(dir);
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        } catch {}
        if (fs.existsSync(dir)) report.leftover.push(dir);
        else {
          report.deleted.push(dir);
          report.freedMb += mb;
        }
      }
    } else if (!s.imported) report.kept.push(s.dir);
    this.emit('removed', { id });
    return report;
  }

  shutdown() {
    for (const [id, r] of this.rt) {
      if (r.child) {
        r.userStop = true;
        try {
          const s = this.rec(id);
          const stopCmd = games[s.game].stopCommand || s.settings.stopCommand;
          if (stopCmd) r.child.stdin.write(stopCmd + '\n');
          else this._terminate(r.child, false);
        } catch {}
      }
    }
  }
}

function dirSizeMb(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else total += fs.statSync(p).size;
      } catch {}
    }
  };
  try {
    walk(dir);
  } catch {}
  return Math.round(total / 1048576);
}

Manager.revSeq = 0;

module.exports = { Manager };
