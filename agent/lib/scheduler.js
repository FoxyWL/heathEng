'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const { tarBin } = require('./winutil');

function parseField(f, min, max) {
  const set = new Set();
  for (const part of f.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const step = m[2] ? +m[2] : 1;
    if (step < 1) return null;
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-');
      lo = +a;
      hi = b !== undefined ? +b : m[2] ? max : +a;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let i = lo; i <= hi; i += step) set.add(i);
  }
  return set;
}

function parseCron(expr) {
  const p = String(expr || '').trim().split(/\s+/);
  if (p.length !== 5) return null;
  const [mi, h, d, mo, w] = [parseField(p[0], 0, 59), parseField(p[1], 0, 23), parseField(p[2], 1, 31), parseField(p[3], 1, 12), parseField(p[4], 0, 7)];
  if (!mi || !h || !d || !mo || !w) return null;
  if (w.has(7)) w.add(0);
  return { mi, h, d, mo, w, domStar: p[2] === '*', dowStar: p[4] === '*' };
}

function matches(c, date) {
  if (!c.mi.has(date.getMinutes()) || !c.h.has(date.getHours()) || !c.mo.has(date.getMonth() + 1)) return false;
  const dom = c.d.has(date.getDate());
  const dow = c.w.has(date.getDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dow;
  if (c.dowStar) return dom;
  return dom || dow;
}

function nextRun(expr, from = new Date()) {
  const c = parseCron(expr);
  if (!c) return null;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (matches(c, d)) return d.getTime();
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function backupDir(serverId) {
  const d = path.join(store.paths.backups, serverId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function listBackups(serverId) {
  const d = backupDir(serverId);
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.tar.gz'))
    .map((f) => {
      const st = fs.statSync(path.join(d, f));
      return { name: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function tarCreate(file, srcDir) {
  return new Promise((res, rej) => {
    const p = spawn(tarBin(), ['-czf', file, '-C', srcDir, '.'], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 || code === 1 ? res() : rej(new Error('tar: ' + err.trim()))));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function doBackup(mgr, server, keep) {
  const r = mgr._rt(server.id);
  const live = !!r.child && r.state === 'running' && server.game.startsWith('minecraft');
  if (live) {
    mgr.send(server.id, 'save-off');
    mgr.send(server.id, 'save-all flush');
    await sleep(4000);
  }
  const baseName = `${server.name.replace(/[^\w.-]+/g, '_')}-${stamp()}`;
  let name = `${baseName}.tar.gz`;
  for (let i = 2; fs.existsSync(path.join(backupDir(server.id), name)); i++) name = `${baseName}-${i}.tar.gz`;
  const file = path.join(backupDir(server.id), name);
  try {
    await tarCreate(file, server.dir);
  } finally {
    if (live && r.child) mgr.send(server.id, 'save-on');
  }
  const all = listBackups(server.id);
  const limit = Math.max(1, +keep || 7);
  for (const b of all.slice(limit)) fs.rmSync(path.join(backupDir(server.id), b.name), { force: true });
  return name;
}

class Scheduler {
  constructor(mgr, emit) {
    this.mgr = mgr;
    this.emit = emit;
    this.lastMinute = -1;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.tick(), 10000);
  }

  stop() {
    clearInterval(this.timer);
  }

  tick() {
    const now = new Date();
    const key = Math.floor(now.getTime() / 60000);
    if (key === this.lastMinute) return;
    this.lastMinute = key;
    for (const t of store.state.tasks) {
      if (!t.enabled) continue;
      const c = parseCron(t.cron);
      if (c && matches(c, now)) this.run(t.id).catch(() => {});
    }
  }

  view(t) {
    return { ...t, next: t.enabled ? nextRun(t.cron) : null };
  }

  list() {
    return store.state.tasks.map((t) => this.view(t));
  }

  validate(spec) {
    if (!parseCron(spec.cron)) throw Object.assign(new Error('неверное cron-выражение (формат: мин час день месяц день_недели)'), { status: 400 });
    if (!['backup', 'restart', 'start', 'stop', 'command'].includes(spec.action)) throw Object.assign(new Error('неизвестное действие'), { status: 400 });
    if (spec.action === 'command' && !String(spec.command || '').trim()) throw Object.assign(new Error('укажите команду'), { status: 400 });
    this.mgr.rec(spec.serverId);
  }

  create(spec) {
    this.validate(spec);
    const t = {
      id: store.uid('task'),
      serverId: spec.serverId,
      name: String(spec.name || spec.action).slice(0, 60),
      cron: spec.cron.trim(),
      action: spec.action,
      command: spec.command || '',
      keep: +spec.keep || 7,
      enabled: spec.enabled !== false,
      lastRun: 0,
      lastResult: '',
    };
    store.state.tasks.push(t);
    store.saveState();
    return this.view(t);
  }

  update(id, patch) {
    const t = store.state.tasks.find((x) => x.id === id);
    if (!t) throw Object.assign(new Error('задача не найдена'), { status: 404 });
    const next = { ...t, ...patch, id: t.id };
    this.validate(next);
    Object.assign(t, next);
    store.saveState();
    return this.view(t);
  }

  remove(id) {
    store.state.tasks = store.state.tasks.filter((t) => t.id !== id);
    store.saveState();
  }

  async run(id) {
    const t = store.state.tasks.find((x) => x.id === id);
    if (!t) throw Object.assign(new Error('задача не найдена'), { status: 404 });
    const s = this.mgr.rec(t.serverId);
    t.lastRun = Date.now();
    this.mgr._log(s, 'sys', `Планировщик: «${t.name}» (${t.action})`);
    try {
      if (t.action === 'backup') t.lastResult = 'ok: ' + (await doBackup(this.mgr, s, t.keep));
      else if (t.action === 'restart') {
        await this.mgr.restart(s.id);
        t.lastResult = 'ok';
      } else if (t.action === 'start') {
        await this.mgr.start(s.id);
        t.lastResult = 'ok';
      } else if (t.action === 'stop') {
        this.mgr.stop(s.id);
        t.lastResult = 'ok';
      } else if (t.action === 'command') {
        this.mgr.send(s.id, t.command);
        t.lastResult = 'ok';
      }
    } catch (e) {
      t.lastResult = 'ошибка: ' + e.message;
      this.mgr._log(s, 'err', `Планировщик: ${t.lastResult}`);
    }
    store.saveState();
    this.emit('tasks', this.list());
    return this.view(t);
  }
}

module.exports = { Scheduler, listBackups, backupDir, doBackup };
