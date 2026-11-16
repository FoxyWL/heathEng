'use strict';
// Уведомления: когда сервер упал, поднялся, кончается место, сменился публичный IP, пропала связь с релеем, вышла новая версия.
// Отправка: Discord (вебхук), Telegram (бот) или любой вебхук JSON. Токены не возвращаются в панель.
const fs = require('fs');

const EVENTS = ['crash', 'recovered', 'disk', 'ip', 'relay', 'update', 'backup'];
const TYPES = ['discord', 'telegram', 'webhook'];
const TG = () => process.env.HEARTH_TELEGRAM_API || 'https://api.telegram.org';

class Notifier {
  constructor({ store, dataDir }) {
    this.store = store;
    this.dataDir = dataDir;
    this.last = new Map(); // ключ события -> время: один и тот же сигнал не чаще раза в минуту
    this.state = new Map(); // id сервера -> прошлое состояние
    this.timers = [];
    this.relayDownAt = 0;
    this.relayWarned = false;
    this.diskWarned = false;
    this.sent = [];
  }

  get cfg() {
    const c = this.store.config;
    c.notify = { enabled: false, targets: [], events: {}, diskGb: 5, ...(c.notify || {}) };
    c.notify.events = Object.fromEntries(EVENTS.map((e) => [e, c.notify.events[e] !== false]));
    return c.notify;
  }

  view() {
    const c = this.cfg;
    return {
      enabled: c.enabled,
      diskGb: c.diskGb,
      events: c.events,
      targets: c.targets.map((t) => ({ id: t.id, type: t.type, name: t.name || t.type, hint: (t.secret || t.url || '').slice(-4), chatId: t.chatId || '' })),
      log: this.sent.slice(-10),
    };
  }

  set(body) {
    const c = this.cfg;
    if (typeof body.enabled === 'boolean') c.enabled = body.enabled;
    if (body.diskGb !== undefined) c.diskGb = Math.max(1, Math.min(10000, +body.diskGb || 5));
    if (body.events && typeof body.events === 'object') for (const e of EVENTS) if (typeof body.events[e] === 'boolean') c.events[e] = body.events[e];
    if (Array.isArray(body.targets)) {
      const old = new Map(c.targets.map((t) => [t.id, t]));
      c.targets = body.targets.slice(0, 5).map((t, i) => {
        if (!TYPES.includes(t.type)) throw Object.assign(new Error('тип: discord, telegram или webhook'), { status: 400 });
        const prev = old.get(t.id) || {};
        const url = String(t.url || prev.url || '').trim();
        const secret = String(t.secret || prev.secret || '').trim(); // токен бота Telegram
        if (t.type === 'telegram') {
          if (!secret) throw Object.assign(new Error('Telegram: нужен токен бота'), { status: 400 });
          if (!String(t.chatId || prev.chatId || '').trim()) throw Object.assign(new Error('Telegram: нужен chat id'), { status: 400 });
        } else if (!/^https?:\/\/[^\s]+$/i.test(url)) throw Object.assign(new Error('нужна ссылка вебхука, начинающаяся с http:// или https://'), { status: 400 });
        return { id: prev.id || 'n' + Date.now().toString(36) + i, type: t.type, name: String(t.name || prev.name || t.type).slice(0, 40), url: t.type === 'telegram' ? '' : url, secret: t.type === 'telegram' ? secret : '', chatId: String(t.chatId || prev.chatId || '').trim() };
      });
    }
    this.store.saveConfig();
    return this.view();
  }

  async post(target, title, text, ctx) {
    const full = `${title}\n${text}`.trim();
    let url;
    let body;
    if (target.type === 'discord') {
      url = target.url;
      body = { content: full.slice(0, 1900), username: 'Hearth' };
    } else if (target.type === 'telegram') {
      url = `${TG()}/bot${target.secret}/sendMessage`;
      body = { chat_id: target.chatId, text: full.slice(0, 3900) };
    } else {
      url = target.url;
      body = { app: 'hearth', title, text, ...ctx, ts: Date.now() };
    }
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'hearth' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`${target.name}: HTTP ${r.status}`);
  }

  /** event: crash|recovered|disk|ip|relay|update|test. force пропускает проверки включения и паузу (кнопка «Проверить»). */
  async notify(event, title, text, ctx = {}, { force = false, key = '' } = {}) {
    const c = this.cfg;
    if (!force && (!c.enabled || !c.targets.length || c.events[event] === false)) return 0;
    const k = `${event}:${key || ctx.serverId || ''}`;
    const now = Date.now();
    if (!force && now - (this.last.get(k) || 0) < (+process.env.HEARTH_NOTIFY_GAP_MS || 60000)) return 0;
    this.last.set(k, now);
    let ok = 0;
    const errs = [];
    await Promise.all(c.targets.map(async (t) => {
      try {
        await this.post(t, title, text, { event, ...ctx });
        ok++;
      } catch (e) {
        errs.push(e.message);
      }
    }));
    this.sent.push({ ts: now, event, title, ok, error: errs.join('; ') });
    if (this.sent.length > 30) this.sent.shift();
    if (force && errs.length) throw Object.assign(new Error(errs.join('; ')), { status: 502 });
    return ok;
  }

  test() {
    return this.notify('test', 'Hearth: проверка уведомлений', 'Если вы это видите, уведомления работают.', {}, { force: true });
  }

  /** События менеджера серверов: {id, name, state, msg}. */
  onServer(v) {
    if (!v || !v.id) return;
    const prev = this.state.get(v.id);
    this.state.set(v.id, v.state);
    if (prev === v.state) return;
    if (v.state === 'crashed') this.notify('crash', `Сервер «${v.name}» упал`, v.msg || '', { serverId: v.id, server: v.name }).catch(() => {});
    else if (v.state === 'running' && prev === 'crashed') this.notify('recovered', `Сервер «${v.name}» снова работает`, 'Он был перезапущен автоматически.', { serverId: v.id, server: v.name }).catch(() => {});
  }

  onNet(p) {
    if (p && p.type === 'public-ip-changed') this.notify('ip', 'Публичный IP изменился', `Новый адрес: ${p.to || p.ext || ''}. Адреса для друзей обновлены.`, {}, { key: String(p.to || p.ext || '') }).catch(() => {});
  }

  onUpdate(v) {
    if (!v || !v.available || v.available.skipped || this.updateSeen === v.available.version) return;
    this.updateSeen = v.available.version; // об одной версии сообщаем один раз
    {
      this.notify('update', `Вышла версия Hearth ${v.available.version}`, 'Установить: «Настройки» → «Обновления».', {}, { key: v.available.version }).catch(() => {});
    }
  }

  /** Связь с релеем: тревога, только если её нет больше минуты (короткие переподключения не считаются). */
  onRelay(status, enabled) {
    if (!enabled || status === 'online') {
      if (this.relayWarned) this.notify('relay', 'Связь с релеем восстановлена', 'Туннели снова работают.', {}, { key: 'back' }).catch(() => {});
      this.relayDownAt = 0;
      this.relayWarned = false;
      return;
    }
    if (status === 'idle' || this.relayDownAt) return;
    this.relayDownAt = Date.now();
    const t = setTimeout(() => {
      if (this.relayDownAt) {
        this.relayWarned = true;
        this.notify('relay', 'Нет связи с релеем', 'Публичные адреса через туннель сейчас не работают, Hearth переподключается.', {}, { key: 'lost' }).catch(() => {});
      }
    }, +process.env.HEARTH_NOTIFY_RELAY_MS || 60000);
    t.unref();
    this.timers.push(t);
  }

  checkDisk() {
    try {
      const st = fs.statfsSync(this.dataDir);
      const freeGb = (st.bavail * st.bsize) / 1073741824;
      const low = freeGb < this.cfg.diskGb;
      if (low && !this.diskWarned) this.notify('disk', 'Мало места на диске', `Свободно ${freeGb.toFixed(1)} ГБ (порог ${this.cfg.diskGb} ГБ). Бэкапы и миры могут перестать сохраняться.`, {}, { key: 'low' }).catch(() => {});
      this.diskWarned = low;
      return freeGb;
    } catch {
      return null;
    }
  }

  start() {
    const t = setInterval(() => this.checkDisk(), +process.env.HEARTH_DISK_CHECK_MS || 5 * 60000);
    t.unref();
    this.timers.push(t);
  }

  stop() {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers = [];
  }
}

module.exports = { Notifier, EVENTS };
