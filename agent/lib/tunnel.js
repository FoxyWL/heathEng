'use strict';
const net = require('net');
const dgram = require('dgram');
const { EventEmitter } = require('events');
const { lineParser, send, bridge, frameParser, makeFrame } = require('../../shared/util');

class TunnelClient extends EventEmitter {
  constructor() {
    super();
    this.relay = null;
    this.sock = null;
    this.status = 'idle';
    this.tunnels = new Map();
    this.retry = 0;
    this.timer = null;
    this.pingTimer = null;
    this.stopped = true;
    this.udp = new Map();
    this.latency = 0; // отклик релея, мс (0 — нет данных)
    this.pingAt = 0;
  }

  _event(t, msg, kind) {
    t.events.push({ ts: Date.now(), msg, kind: kind || 'info' });
    if (t.events.length > 60) t.events.shift();
  }

  configure(relay) {
    this.relay = relay;
  }

  start() {
    if (!this.relay || !this.relay.host) return;
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.pingTimer);
    if (this.sock) this.sock.destroy();
    this.sock = null;
    this._setStatus('idle');
    for (const t of this.tunnels.values()) t.info = null;
    this.emit('update');
  }

  _setStatus(s, err) {
    this.status = s;
    this.error = err || '';
    this.emit('update');
  }

  _connect() {
    clearTimeout(this.timer);
    this._setStatus('connecting');
    const sock = net.connect(this.relay.port || 7000, this.relay.host);
    this.sock = sock;
    sock.setKeepAlive(true, 15000);
    const parse = lineParser((m) => this._onMsg(m));
    sock.on('connect', () => {
      send(sock, { t: 'hello', token: this.relay.token, name: this.relay.name || 'hearth' });
    });
    sock.on('data', parse);
    sock.on('error', (e) => {
      this.lastErr = e.message;
    });
    sock.on('close', () => {
      clearInterval(this.pingTimer);
      if (this.sock === sock) this.sock = null;
      this.latency = 0;
      for (const t of this.tunnels.values()) {
        if (t.info) this._event(t, 'Соединение с релеем потеряно', 'bad');
        t.info = null;
        t.stats.conns = 0;
      }
      this._cleanupUdp();
      if (this.stopped) return;
      this._setStatus('reconnecting', this.lastErr || '');
      const wait = Math.min(30000, 1000 * 2 ** Math.min(this.retry++, 5));
      this.timer = setTimeout(() => this._connect(), wait);
    });
  }

  _onMsg(m) {
    switch (m.t) {
      case 'ok':
        this.retry = 0;
        this.lastErr = '';
        this._setStatus('online');
        this._ping();
        this.pingTimer = setInterval(() => this._ping(), 5000);
        for (const t of this.tunnels.values()) this._sendOpen(t);
        break;
      case 'pong':
        if (this.pingAt) this.latency = Math.max(1, Date.now() - this.pingAt);
        this.pingAt = 0;
        this.emit('latency');
        break;
      case 'err':
        this.stopped = true;
        this._setStatus('error', m.error);
        break;
      case 'opened': {
        const t = this.tunnels.get(m.id);
        if (t) {
          t.info = { host: m.host, port: m.port, url: m.url };
          t.error = '';
          t.stats.since = Date.now();
          this._event(t, 'Подключён', 'ok');
          if (t.proto === 'udp') this._openUdpData(t);
          this.emit('update');
        }
        break;
      }
      case 'open-err': {
        const t = this.tunnels.get(m.id);
        if (t) {
          t.error = m.error;
          this._event(t, 'Ошибка: ' + m.error, 'bad');
          this.emit('update');
        }
        break;
      }
      case 'conn':
        this._onConn(m);
        break;
    }
  }

  _ping() {
    this.pingAt = Date.now();
    send(this.sock, { t: 'ping' });
  }

  _sendOpen(t) {
    send(this.sock, {
      t: 'open',
      id: t.id,
      proto: t.proto,
      subdomain: t.subdomain,
      remotePort: t.remotePort,
    });
  }

  add(spec) {
    const t = {
      id: spec.id,
      proto: spec.proto,
      localPort: spec.localPort,
      subdomain: spec.subdomain || '',
      remotePort: spec.remotePort || 0,
      info: null,
      error: '',
      stats: { rx: 0, tx: 0, conns: 0, total: 0, since: 0 },
      events: [],
    };
    this._event(t, 'Подключение…');
    this.tunnels.set(t.id, t);
    if (this.status === 'online') this._sendOpen(t);
    this.emit('update');
    return t;
  }

  remove(id) {
    if (this.tunnels.delete(id) && this.status === 'online') send(this.sock, { t: 'close', id });
    const u = this.udp.get(id);
    if (u) {
      u.data.destroy();
      this.udp.delete(id);
    }
    this.emit('update');
  }

  list() {
    return [...this.tunnels.values()].map((t) => ({
      id: t.id,
      proto: t.proto,
      localPort: t.localPort,
      subdomain: t.subdomain,
      remotePort: t.remotePort,
      info: t.info,
      error: t.error,
      stats: { ...t.stats, since: t.stats.since || 0 },
      events: t.events.slice(-30),
    }));
  }

  traffic() {
    const out = {};
    for (const t of this.tunnels.values()) out[t.id] = { rx: t.stats.rx, tx: t.stats.tx, conns: t.stats.conns };
    return out;
  }

  _onConn(m) {
    const t = this.tunnels.get(m.id);
    if (!t) return;
    const local = net.connect(t.localPort, '127.0.0.1');
    const data = net.connect(this.relay.port || 7000, this.relay.host);
    const who = m.from ? String(m.from).replace(/^::ffff:/, '') : '';
    let counted = false;
    data.on('data', (c) => (t.stats.rx += c.length));
    local.on('data', (c) => (t.stats.tx += c.length));
    let ready = 0;
    const tryBridge = () => {
      if (++ready === 2) {
        bridge(local, data);
        counted = true;
        t.stats.conns++;
        t.stats.total++;
        this._event(t, 'Подключение' + (who ? ' ' + who : ''));
        this.emit('update');
      }
    };
    const done = () => {
      if (counted) {
        counted = false;
        t.stats.conns = Math.max(0, t.stats.conns - 1);
        this._event(t, 'Отключение' + (who ? ' ' + who : ''));
        this.emit('update');
      }
    };
    local.on('close', done);
    data.on('close', done);
    local.once('connect', tryBridge);
    data.once('connect', () => {
      send(data, { t: 'data', tid: m.tid, token: this.relay.token });
      tryBridge();
    });
    const kill = () => {
      local.destroy();
      data.destroy();
    };
    local.on('error', kill);
    data.on('error', kill);
  }

  _openUdpData(t) {
    const old = this.udp.get(t.id);
    if (old) old.data.destroy();
    const data = net.connect(this.relay.port || 7000, this.relay.host);
    const state = { data, locals: new Map() };
    this.udp.set(t.id, state);
    data.on('connect', () => send(data, { t: 'udp', id: t.id, token: this.relay.token }));
    data.on(
      'data',
      frameParser((sid, payload) => {
        t.stats.rx += payload.length;
        let l = state.locals.get(sid);
        if (!l) {
          t.stats.total++;
          t.stats.conns = state.locals.size + 1;
          this._event(t, 'UDP-сессия ' + sid);
          const s = dgram.createSocket('udp4');
          l = { s, last: Date.now() };
          s.on('message', (reply) => {
            l.last = Date.now();
            t.stats.tx += reply.length;
            if (!data.destroyed) data.write(makeFrame(sid, reply));
          });
          s.on('error', () => {});
          state.locals.set(sid, l);
        }
        l.last = Date.now();
        l.s.send(payload, t.localPort, '127.0.0.1');
      }),
    );
    data.on('error', () => {});
    data.on('close', () => {
      for (const l of state.locals.values()) l.s.close();
      state.locals.clear();
    });
    state.gc = setInterval(() => {
      const now = Date.now();
      for (const [sid, l] of state.locals) {
        if (now - l.last > 60000) {
          l.s.close();
          state.locals.delete(sid);
          t.stats.conns = state.locals.size;
        }
      }
    }, 15000);
    data.on('close', () => clearInterval(state.gc));
  }

  _cleanupUdp() {
    for (const u of this.udp.values()) u.data.destroy();
    this.udp.clear();
  }
}

module.exports = { TunnelClient };
