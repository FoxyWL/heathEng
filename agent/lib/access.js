'use strict';
// Пользователи панели: владелец (токен панели) делает всё; оператор запускает и останавливает выбранные серверы и пишет в консоль; зритель только смотрит.
// Всё, чего нет в списках ниже, доступно только владельцу.
const crypto = require('crypto');

const ROLES = ['operator', 'viewer'];
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// [шаблон, привязан ли к конкретному серверу (тогда первая группа — id сервера)]
const READ = [
  [/^\/api\/(system|catalog|servers|tunnels|tasks|network)$/, false],
  [/^\/api\/events$/, false],
  [/^\/api\/games\/[^/]+\/icon$/, false],
  [/^\/api\/servers\/([^/]+)$/, true],
  [/^\/api\/servers\/([^/]+)\/(logs|players|icon)$/, true],
];
const OPERATE = [
  [/^\/api\/servers\/([^/]+)\/(start|stop|restart|kill|command)$/, true],
  [/^\/api\/servers\/([^/]+)\/players\/[^/]+$/, true],
  [/^\/api\/servers\/([^/]+)\/backups$/, true],
];
const EVENTS = new Set(['state', 'log', 'cleared', 'install', 'removed', 'tunnels', 'traffic', 'tasks']);

class Access {
  constructor(store) {
    this.store = store;
  }

  get users() {
    const c = this.store.config;
    c.users = Array.isArray(c.users) ? c.users : [];
    return c.users;
  }

  view() {
    return this.users.map((u) => ({ id: u.id, name: u.name, role: u.role, servers: u.servers, created: u.created, hint: u.hint }));
  }

  _clean(b, cur = {}) {
    const name = String(b.name !== undefined ? b.name : cur.name || '').trim().slice(0, 40);
    if (!name) throw Object.assign(new Error('укажите имя'), { status: 400 });
    const role = b.role !== undefined ? b.role : cur.role;
    if (!ROLES.includes(role)) throw Object.assign(new Error('роль: operator или viewer'), { status: 400 });
    let servers = b.servers !== undefined ? b.servers : cur.servers || '*';
    if (servers !== '*') {
      if (!Array.isArray(servers)) throw Object.assign(new Error('серверы: список или *'), { status: 400 });
      servers = servers.map(String);
      const known = new Set(this.store.state.servers.map((s) => s.id));
      if (servers.some((s) => !known.has(s))) throw Object.assign(new Error('неизвестный сервер'), { status: 400 });
    }
    return { name, role, servers };
  }

  create(b) {
    if (this.users.length >= 20) throw Object.assign(new Error('не больше 20 пользователей'), { status: 400 });
    const token = 'hu-' + crypto.randomBytes(18).toString('hex');
    const u = { id: this.store.uid('user'), ...this._clean(b), hash: hash(token), hint: token.slice(-4), created: Date.now() };
    this.users.push(u);
    this.store.saveConfig();
    return { user: this.view().find((x) => x.id === u.id), token };
  }

  update(id, b) {
    const u = this.users.find((x) => x.id === id);
    if (!u) throw Object.assign(new Error('пользователь не найден'), { status: 404 });
    Object.assign(u, this._clean(b, u));
    this.store.saveConfig();
    return this.view().find((x) => x.id === id);
  }

  reissue(id) {
    const u = this.users.find((x) => x.id === id);
    if (!u) throw Object.assign(new Error('пользователь не найден'), { status: 404 });
    const token = 'hu-' + crypto.randomBytes(18).toString('hex');
    u.hash = hash(token);
    u.hint = token.slice(-4);
    this.store.saveConfig();
    return { user: this.view().find((x) => x.id === id), token };
  }

  remove(id) {
    const i = this.users.findIndex((x) => x.id === id);
    if (i < 0) throw Object.assign(new Error('пользователь не найден'), { status: 404 });
    this.users.splice(i, 1);
    this.store.saveConfig();
  }

  /** Кто пришёл с этим токеном: {admin:true}, {user} или null. */
  who(token) {
    if (!token) return null;
    if (token === this.store.config.panelToken) return { admin: true };
    const h = hash(token);
    const u = this.users.find((x) => x.hash === h);
    return u ? { admin: false, user: u } : null;
  }

  has(p, id) {
    return p.admin || p.user.servers === '*' || p.user.servers.includes(id);
  }

  /** Можно ли этому пользователю такой запрос. Для чужих серверов — нет. */
  allow(p, method, pathname) {
    if (p.admin) return true;
    const lists = method === 'GET' ? READ : method === 'POST' && p.user.role === 'operator' ? OPERATE : [];
    for (const [re, scoped] of lists) {
      const m = re.exec(pathname);
      if (m) return scoped ? this.has(p, decodeURIComponent(m[1])) : true;
    }
    return false;
  }

  /** Серверы без путей и настроек (там бывают пароли RCON). */
  redact(v) {
    return { ...v, dir: '', settings: {} };
  }

  filterServers(p, list) {
    return p.admin ? list : list.filter((s) => this.has(p, s.id)).map((s) => this.redact(s));
  }

  filterTunnels(p, v) {
    if (p.admin) return v;
    return { ...v, tunnels: v.tunnels.filter((t) => t.kind === 'server' && this.has(p, t.serverId)) };
  }

  filterTasks(p, list) {
    return p.admin ? list : list.filter((t) => this.has(p, t.serverId));
  }

  /** Событие для подписчика: null — не отправлять, иначе (возможно урезанные) данные. */
  event(p, type, payload) {
    if (p.admin) return payload;
    if (!EVENTS.has(type)) return null;
    if (type === 'tunnels') return this.filterTunnels(p, payload);
    if (type === 'tasks') return Array.isArray(payload) ? this.filterTasks(p, payload) : null;
    if (type === 'traffic') {
      const t = {};
      for (const [k, v] of Object.entries(payload.t || {})) if ([...this.store.state.servers].some((s) => this.has(p, s.id) && (k === 'srv-' + s.id || k.startsWith(`srv-${s.id}-`)))) t[k] = v;
      return { ...payload, t };
    }
    if (payload && payload.id && !this.has(p, payload.id)) return null;
    return type === 'state' ? this.redact(payload) : payload;
  }
}

module.exports = { Access, ROLES };
