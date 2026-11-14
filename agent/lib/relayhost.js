'use strict';
// «Стать релеем»: релей Hearth работает прямо на этом ПК (если у него белый IP), порты открываются через UPnP.
// Это тот же relay/relay.js, что и на VPS, он запускается отдельным процессом: падение релея не трогает серверы игр.
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const upnp = require('./upnp');
const netaccess = require('./netaccess');

const RELAY_JS = path.join(__dirname, '..', '..', 'relay', 'relay.js');
const MAX_LOG = 60;

class RelayHost {
  constructor({ store, emit, renewMs = +process.env.HEARTH_PUBLIC_RENEW_MS || 20 * 60 * 1000 }) {
    Object.assign(this, { store, emit, renewMs });
    this.child = null;
    this.timer = null;
    this.stopping = false;
    this.gen = 0; // меняется при пуске и остановке: запоздавшее продление портов себя отменяет
    this.restarts = 0;
    this.gw = null;
    this.mapped = []; // открытые на роутере порты
    this.s = { running: false, starting: false, link: '', host: '', verdict: '', warning: '', error: '', log: [] };
  }

  get cfg() {
    return this.store.config.relayHost;
  }

  view() {
    const c = this.cfg;
    return {
      enabled: !!c.enabled,
      running: this.s.running,
      starting: this.s.starting,
      link: this.s.link,
      host: this.s.host,
      controlPort: +c.controlPort,
      portMin: +c.portMin,
      portMax: +c.portMax,
      verdict: this.s.verdict,
      warning: this.s.warning,
      error: this.s.error,
      upnp: this.mapped.length > 0,
      log: this.s.log.slice(-12),
      since: this.s.since || 0,
    };
  }

  push() {
    this.emit('relayhost', this.view());
  }

  /** Куда друзьям слать запросы: внешний IP при белом адресе, иначе адрес в локальной сети. */
  async plan() {
    const lan = netaccess.addresses().find((a) => a.primary);
    const chk = await upnp.check().catch(() => ({ verdict: 'unknown', ip: '' }));
    let host = lan ? lan.ip : '127.0.0.1';
    let warning = '';
    if (chk.verdict === 'upnp' || chk.verdict === 'manual') host = chk.ip || host;
    if (chk.verdict === 'cgnat') warning = 'У вас «серый» адрес провайдера (CGNAT): из интернета до этого ПК не достучаться. Релей будет работать только для устройств в вашей сети. Для друзей из интернета нужен VPS.';
    else if (chk.verdict === 'manual') warning = `Роутер без UPnP: пробросьте на этот ПК порты ${this.cfg.controlPort}/TCP и ${this.cfg.portMin}–${this.cfg.portMax} (TCP и UDP) вручную.`;
    else if (chk.verdict === 'unknown') warning = 'Нет связи с интернетом: релей доступен только в вашей сети.';
    return { host, lan: lan ? lan.ip : '', verdict: chk.verdict, warning };
  }

  linkFor(host) {
    const c = this.cfg;
    return `hearth-relay://${host}:${c.controlPort}?token=${c.token}`;
  }

  /** Один запуск за раз: повторный вызов (кнопка, автоперезапуск) дожидается начатого, а не плодит второй релей. */
  start() {
    if (this.startP) return this.startP;
    this.startP = this.doStart().finally(() => (this.startP = null));
    return this.startP;
  }

  async doStart() {
    if (this.child) return this.view();
    const c = this.cfg;
    if (!c.token) c.token = crypto.randomBytes(12).toString('hex');
    c.enabled = true;
    this.store.saveConfig();
    this.stopping = false;
    this.gen++;
    Object.assign(this.s, { starting: true, error: '', warning: '', log: [] });
    this.push();
    let plan;
    try {
      plan = await this.plan();
      this.s.verdict = plan.verdict;
      this.s.warning = plan.warning;
      this.s.host = plan.host;
      await this.spawnRelay(plan);
      if (plan.verdict === 'upnp') await this.mapPorts(plan, this.gen).catch((e) => (this.s.warning = 'Не удалось открыть порты на роутере: ' + e.message + '. Пробросьте их вручную.'));
    } catch (e) {
      this.s.starting = false;
      this.s.running = false;
      this.s.error = e.message;
      c.enabled = false;
      this.store.saveConfig();
      this.kill();
      this.push();
      throw Object.assign(e, { status: e.status || 502 });
    }
    this.s.link = this.linkFor(this.s.host);
    this.s.since = Date.now();
    this.s.starting = false;
    this.s.running = true;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.renew().catch(() => {}), this.renewMs);
    this.timer.unref();
    this.push();
    return this.view();
  }

  spawnRelay(plan) {
    const c = this.cfg;
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1', // в упакованном приложении «node» — это сам Hearth.exe
        RELAY_TOKEN: c.token,
        CONTROL_PORT: String(c.controlPort),
        HTTP_PORT: '0', // HTTP-адреса по IP не нужны: игры идут по TCP и UDP
        PORT_MIN: String(c.portMin),
        PORT_MAX: String(c.portMax),
        PUBLIC_HOST: plan.host,
        RELAY_DOMAIN: plan.host,
        MAX_TUNNELS: String(c.maxTunnels || 16),
      };
      delete env.RELAY_OPEN;
      if (process.env.HEARTH_RELAY_DISCOVERY !== undefined) env.DISCOVERY_PORT = process.env.HEARTH_RELAY_DISCOVERY;
      const child = spawn(process.execPath, [RELAY_JS], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      this.child = child;
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        err ? reject(err) : resolve();
      };
      const t = setTimeout(() => done(new Error('релей не ответил за 10 секунд')), 10000);
      const eat = (d) => {
        for (const line of String(d).split(/\r?\n/).filter(Boolean)) {
          this.s.log.push(line.replace(c.token, '***'));
          if (this.s.log.length > MAX_LOG) this.s.log.shift();
          if (/\[relay\] http :/.test(line)) done();
          if (/ошибка запуска/.test(line)) done(new Error(line.replace(/^\[relay\]\s*/, '')));
        }
      };
      child.stdout.on('data', eat);
      child.stderr.on('data', eat);
      child.on('error', (e) => done(e));
      child.on('exit', (code) => {
        if (this.child === child) this.child = null;
        done(new Error(`релей остановился (код ${code})`));
        this.onExit(code);
      });
    });
  }

  onExit(code) {
    if (this.stopping) return;
    this.s.running = false;
    if (!this.cfg.enabled) return;
    this.s.error = `Релей остановился (код ${code}).`;
    this.push();
    if (this.restarts >= 5) return;
    this.restarts++;
    setTimeout(() => this.cfg.enabled && !this.child && this.start().catch(() => {}), 3000).unref();
  }

  async mapPorts(plan, gen) {
    const c = this.cfg;
    this.gw = await upnp.find();
    if (gen !== this.gen) return;
    if (!this.gw) throw new Error('роутер с UPnP не найден');
    const want = [{ port: +c.controlPort, proto: 'tcp' }];
    for (let p = +c.portMin; p <= +c.portMax; p++) want.push({ port: p, proto: 'tcp' }, { port: p, proto: 'udp' });
    const lanIp = plan.lan || plan.host;
    for (const w of want) {
      if (gen !== this.gen) return;
      await upnp.addMapping(this.gw, { ...w, internalIp: lanIp, desc: 'Hearth: релей' });
      if (!this.mapped.some((m) => m.port === w.port && m.proto === w.proto)) this.mapped.push(w);
    }
  }

  async unmap() {
    const list = this.mapped.splice(0);
    if (!list.length) return;
    try {
      const gw = this.gw || (await upnp.find());
      if (gw) await Promise.all(list.map((m) => upnp.removeMapping(gw, m).catch(() => {})));
    } catch {}
  }

  /** Продлевает аренду портов и замечает смену внешнего IP (ссылка-приглашение тогда меняется). */
  async renew() {
    if (!this.s.running) return;
    const gen = this.gen;
    const plan = await this.plan();
    if (gen !== this.gen || !this.s.running) return;
    if (plan.verdict === 'upnp') await this.mapPorts(plan, gen).catch((e) => (this.s.warning = 'Не удалось продлить порты на роутере: ' + e.message));
    if (plan.host !== this.s.host) {
      this.s.host = plan.host;
      this.s.link = this.linkFor(plan.host);
      this.emit('net', { type: 'relayhost-ip-changed', to: plan.host });
    }
    this.s.verdict = plan.verdict;
    this.push();
  }

  kill() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
  }

  /** Останавливает релей и закрывает порты на роутере. permanent=false: Hearth выходит, релей включится при следующем запуске. */
  async stop({ permanent = true } = {}) {
    this.stopping = true;
    this.gen++;
    clearInterval(this.timer);
    this.kill();
    if (permanent) {
      this.cfg.enabled = false;
      this.store.saveConfig();
    }
    Object.assign(this.s, { running: false, starting: false, link: '', error: '' });
    await this.unmap();
    this.push();
    return this.view();
  }

  /** Новый токен: старый перестаёт работать, подключённые друзья отключатся. */
  async newToken() {
    const was = this.s.running;
    await this.stop({ permanent: false });
    this.cfg.token = crypto.randomBytes(12).toString('hex');
    this.store.saveConfig();
    if (was) await this.start();
    else this.push();
    return this.view();
  }

  /** Релей включён в настройках: поднимаем его при запуске Hearth. */
  autostart() {
    if (this.cfg.enabled && process.env.HEARTH_RELAYHOST_AUTO !== '0') this.start().catch(() => {});
  }

  setPorts({ portMin, portMax, controlPort }) {
    const c = this.cfg;
    const n = (v, d) => (Number.isInteger(+v) && +v >= 1024 && +v <= 65535 ? +v : d);
    const next = { controlPort: n(controlPort, c.controlPort), portMin: n(portMin, c.portMin), portMax: n(portMax, c.portMax) };
    if (next.portMax < next.portMin) throw Object.assign(new Error('конец диапазона меньше начала'), { status: 400 });
    if (next.portMax - next.portMin > 99) throw Object.assign(new Error('диапазон не больше 100 портов'), { status: 400 });
    if (next.controlPort >= next.portMin && next.controlPort <= next.portMax) throw Object.assign(new Error('порт управления не должен попадать в диапазон'), { status: 400 });
    if (this.s.running) throw Object.assign(new Error('сначала остановите релей'), { status: 409 });
    Object.assign(c, next);
    this.store.saveConfig();
    this.push();
    return this.view();
  }
}

module.exports = { RelayHost };
