'use strict';
// Доступ к серверу из интернета напрямую (по внешнему IP роутера) через UPnP, с продлением аренды портов и сменой внешнего IP.
const upnp = require('./upnp');
const netaccess = require('./netaccess');
const { portsOf } = require('./catalog');
const { kindOf } = netaccess;

const wanted = (s) => portsOf(s.game, s.settings).filter((p) => !p.optional && (p.proto === 'tcp' || p.proto === 'udp'));

class PublicAccess {
  constructor({ mgr, store, emit, renewMs = +process.env.HEARTH_PUBLIC_RENEW_MS || 20 * 60 * 1000 }) {
    Object.assign(this, { mgr, store, emit, renewMs });
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.renew().catch(() => {}), this.renewMs);
    this.timer.unref();
  }

  async check() {
    return upnp.check();
  }

  /** Открывает порты сервера на роутере. Возвращает запись для сервера. */
  async open(s) {
    const gw = await upnp.find();
    if (!gw) throw Object.assign(new Error('Роутер с UPnP не найден. Включите UPnP в настройках роутера или пробросьте порты вручную, либо используйте туннель'), { status: 502 });
    const ext = await upnp.externalIp(gw);
    if (!ext || kindOf(ext) !== 'public') throw Object.assign(new Error(`Внешний адрес роутера ${ext || 'не определён'}: он «серый» (провайдер использует CGNAT), из интернета сюда не достучаться. Используйте туннель`), { status: 409 });
    const lan = netaccess.addresses().find((a) => a.primary);
    if (!lan) throw Object.assign(new Error('Нет сетевого адреса этого ПК'), { status: 409 });
    const ports = [];
    for (const p of wanted(s)) {
      try {
        const m = await upnp.addMapping(gw, { port: p.port, proto: p.proto, internalIp: lan.ip, desc: `Hearth: ${s.name}` });
        ports.push({ port: p.port, proto: p.proto, lease: m.lease });
      } catch (e) {
        throw Object.assign(new Error(`Не удалось открыть порт ${p.port}/${p.proto.toUpperCase()}: ${e.message}`), { status: 502 });
      }
    }
    if (!ports.length) throw Object.assign(new Error('У сервера нет портов TCP или UDP'), { status: 400 });
    s.publicIp = { enabled: true, ext, internal: lan.ip, ports, at: Date.now(), router: gw.name };
    this.store.saveState();
    return s.publicIp;
  }

  /** Закрывает порты, насколько роутер даёт это сделать; запись сервера снимается в любом случае. */
  async close(s) {
    const pub = s.publicIp;
    if (pub && pub.enabled) {
      try {
        const gw = await upnp.find();
        if (gw) for (const p of pub.ports) await upnp.removeMapping(gw, p).catch(() => {});
      } catch {}
    }
    s.publicIp = { enabled: false };
    this.store.saveState();
  }

  /** Продлевает аренду, переоткрывает порты после перезагрузки роутера, замечает смену внешнего IP. */
  async renew() {
    const servers = this.store.state.servers.filter((s) => s.publicIp && s.publicIp.enabled);
    if (!servers.length) return;
    for (const s of servers) {
      const old = s.publicIp.ext;
      try {
        const next = await this.open(s);
        if (next.ext !== old) {
          this.emit('net', { type: 'public-ip-changed', id: s.id, name: s.name, from: old, to: next.ext });
          this.emit('state', this.mgr.view(s));
        }
      } catch (e) {
        if (!s.publicIp.error || s.publicIp.error !== e.message) {
          s.publicIp = { ...s.publicIp, error: e.message };
          this.store.saveState();
          this.emit('net', { type: 'public-failed', id: s.id, name: s.name, error: e.message });
          this.emit('state', this.mgr.view(s));
        }
      }
    }
  }
}

module.exports = { PublicAccess, wanted };
