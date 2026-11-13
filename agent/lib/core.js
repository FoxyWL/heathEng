'use strict';
// Мост к нативному ядру hearth-core (Rust): CPU и память дерева процессов.
// Если ядра нет или оно не запустилось, Hearth продолжает работать на запасном способе (память без CPU).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const isWin = process.platform === 'win32';
const EXE = isWin ? 'hearth-core.exe' : 'hearth-core';

function resolveBinary() {
  if (process.env.HEARTH_CORE === 'off') return '';
  if (process.env.HEARTH_CORE && fs.existsSync(process.env.HEARTH_CORE)) return process.env.HEARTH_CORE;
  const root = path.join(__dirname, '..', '..');
  const cands = [path.join(root, 'build', EXE), path.join(root, 'core', 'target', 'release', EXE)];
  return cands.find((p) => fs.existsSync(p)) || '';
}

class Core extends EventEmitter {
  constructor(runtimeDir) {
    super();
    this.runtimeDir = runtimeDir;
    this.child = null;
    this.ok = false;
    this.sys = null;
    this.pids = [];
    this.buf = '';
    this.restarts = 0;
    this.limits = new Map();
    this.affSupported = false;
  }

  start() {
    if (this.child) return;
    const bin = resolveBinary();
    if (!bin) return;
    try {
      const c = spawn(bin, ['--interval', String(+process.env.HEARTH_STATS_MS || 2000)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      this.child = c;
      // ядро не должно удерживать процесс Hearth от завершения
      c.unref();
      for (const st of [c.stdin, c.stdout]) if (st && st.unref) st.unref();
      c.stdin.on('error', () => {});
      c.stdout.on('data', (d) => this._data(d));
      c.on('error', () => this._gone(c));
      c.on('close', () => this._gone(c));
      this.ok = true;
      this._send('sys');
      if (this.pids.length) this._send('watch ' + this.pids.join(' '));
      for (const [pid, mask] of this.limits) this._send(`limit ${pid} 0x${mask.toString(16)}`);
    } catch {
      this.ok = false;
    }
  }

  _gone(c) {
    if (this.child !== c) return;
    this.child = null;
    this.ok = false;
    this.emit('down');
    if (!this.stopping && this.restarts < 5) {
      this.restarts++;
      setTimeout(() => this.start(), 1000 * this.restarts).unref();
    }
  }

  _send(line) {
    try {
      if (this.child && this.child.stdin.writable) this.child.stdin.write(line + '\n');
    } catch {}
  }

  _data(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.t === 'sys') this.sys = m;
        else if (m.t === 'stats') {
          this.restarts = 0;
          if (m.items.some((i) => i.aff !== undefined)) this.affSupported = true;
          this.emit('stats', m.items);
        }
      } catch {}
    }
  }

  watch(pids) {
    const a = [...new Set(pids)].sort((x, y) => x - y);
    if (a.join() === this.pids.join()) return;
    this.pids = a;
    this._send('watch ' + a.join(' '));
  }

  /** Привязка дерева процессов к ядрам (маска BigInt); 0 снимает привязку из учёта ядра. */
  limit(pid, mask) {
    const m = BigInt(mask || 0);
    if (m) this.limits.set(pid, m);
    else this.limits.delete(pid);
    this._send(`limit ${pid} 0x${m.toString(16)}`);
  }

  stop() {
    this.stopping = true;
    try {
      this._send('quit');
      if (this.child) this.child.kill();
    } catch {}
  }
}

module.exports = { Core };
