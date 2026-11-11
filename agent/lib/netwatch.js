'use strict';
// Поддержание сети: слежение за сменой IP ПК и за тем, что запущенный сервер остаётся доступным по адресу в сети.
const netaccess = require('./netaccess');
const { portsOf } = require('./catalog');

const envNum = (k, def) => (process.env[k] !== undefined && process.env[k] !== '' && Number.isFinite(+process.env[k]) ? +process.env[k] : def);
const FAILS = 3; // подряд неудачных проверок до предупреждения

class NetWatch {
  constructor({ mgr, emit, store, addrFn = netaccess.addresses, reachFn = netaccess.reach, ms = envNum('HEARTH_NETWATCH_MS', 15000), graceMs = envNum('HEARTH_NETWATCH_GRACE_MS', 20000) }) {
    Object.assign(this, { mgr, emitEvent: emit, store, addrFn, reachFn, ms, graceMs });
    this.fails = new Map();
    this.warned = new Set();
    this.offline = false;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.ms);
    this.timer.unref();
    this.checkIp();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    this.checkIp();
    await this.checkServers();
  }

  /** Новый IP: имя, посчитанное из него, тоже меняется, а запись в hosts устаревает. */
  checkIp() {
    const cfg = this.store.config;
    cfg.net = cfg.net || { lastIp: '' };
    const p = this.addrFn().find((a) => a.primary);
    if (!p) {
      if (!this.offline && cfg.net.lastIp) this.emitEvent('net', { type: 'offline' });
      this.offline = true;
      return;
    }
    if (this.offline) this.emitEvent('net', { type: 'online', ip: p.ip, fqdn: p.fqdn });
    this.offline = false;
    if (cfg.net.lastIp && cfg.net.lastIp !== p.ip) {
      const ev = { type: 'ip-changed', from: cfg.net.lastIp, to: p.ip, fqdn: p.fqdn };
      this.emitEvent('net', ev);
      for (const s of this.store.state.servers) if (this.mgr.view(s).state === 'running') this.mgr._log(s, 'err', `IP этого ПК изменился: ${ev.from} → ${ev.to}. Автоимя теперь ${ev.fqdn}; имена в hosts нужно обновить (Hearth → Сеть).`);
    }
    if (cfg.net.lastIp !== p.ip) {
      cfg.net.lastIp = p.ip;
      this.store.saveConfig();
    }
  }

  async checkServers() {
    for (const s of this.store.state.servers) {
      const v = this.mgr.view(s);
      if (v.state !== 'running' || Date.now() - v.startedAt < this.graceMs) {
        this.fails.delete(s.id);
        this.warned.delete(s.id);
        continue;
      }
      let res;
      try {
        res = await this.reachFn(portsOf(s.game, s.settings), true);
      } catch {
        continue;
      }
      const bad = res.ports.filter((p) => !p.optional && p.proto === 'tcp' && (p.status === 'closed' || p.status === 'loopback-only'));
      if (bad.length) {
        const n = (this.fails.get(s.id) || 0) + 1;
        this.fails.set(s.id, n);
        if (n >= FAILS && !this.warned.has(s.id)) {
          this.warned.add(s.id);
          const list = bad.map((p) => `${p.port}: ${p.status === 'loopback-only' ? 'слушает только этот ПК' : 'не отвечает'}`).join(', ');
          this.mgr._log(s, 'err', `Друзья не смогут подключиться, порт сервера недоступен в сети (${list}). Откройте Hearth → Сеть.`);
          this.emitEvent('net', { type: 'unreachable', id: s.id, name: s.name, ports: bad.map((p) => ({ port: p.port, status: p.status })) });
        }
      } else {
        this.fails.delete(s.id);
        if (this.warned.delete(s.id)) {
          this.mgr._log(s, 'out', 'Порт сервера снова доступен в сети.');
          this.emitEvent('net', { type: 'recovered', id: s.id, name: s.name });
        }
      }
    }
  }
}

module.exports = { NetWatch, FAILS };
