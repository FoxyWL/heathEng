'use strict';
// Публичное имя вместо голого IP: kelly.203-0-113-7.sslip.io (без регистрации, любой желающий) или kelly.duckdns.org (свой постоянный адрес,
// Hearth сам обновляет IP). Настоящий домен вроде kelly.mc зарегистрировать нельзя: зоной .mc владеет Монако, а свои зоны есть только у .hearth в локальной сети.
const dns = require('dns');
const store = require('./store');

const SSLIP = 'sslip.io';
const duckUrl = () => process.env.HEARTH_DUCKDNS_URL || 'https://www.duckdns.org';
const MODES = ['off', 'sslip', 'duckdns'];
const status = { ok: null, ip: '', at: 0, error: '' }; // последнее обновление DuckDNS
let timer = null;
let lastEmitted = '';

const cfg = () => store.config.publicName;
const slug = (s, n = 30) => String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, n);
const duckHost = (sub) => (sub ? `${sub}.duckdns.org` : '');

/** Имя вида метка.203-0-113-7.sslip.io: сервис отвечает адресом, зашитым в само имя. */
function sslipHost(label, ip) {
  const base = String(ip).replace(/\./g, '-') + '.' + SSLIP;
  const l = slug(label);
  return l ? `${l}.${base}` : base;
}

/** Как называть сервер из интернета: имя, если оно настроено и рабочее, иначе внешний IP. */
function hostFor(s) {
  const ext = s.publicIp && s.publicIp.enabled ? s.publicIp.ext : '';
  if (!ext) return '';
  const c = cfg();
  if (c.mode === 'sslip') return sslipHost(s.name, ext);
  if (c.mode === 'duckdns' && c.duckSub && status.ok !== false) return duckHost(c.duckSub);
  return ext;
}

function view() {
  const c = cfg();
  return { mode: c.mode, duck: { sub: c.duckSub, host: duckHost(c.duckSub), hasToken: !!c.duckToken, ...status } };
}

function set(body = {}) {
  const c = cfg();
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (body.mode !== undefined) {
    if (!MODES.includes(body.mode)) throw bad('режим: off, sslip или duckdns');
    c.mode = body.mode;
  }
  if (body.duckSub !== undefined) {
    const sub = String(body.duckSub).trim().toLowerCase().replace(/\.duckdns\.org$/, '');
    if (sub && !/^[a-z0-9-]{1,63}$/.test(sub)) throw bad('имя DuckDNS: латиница, цифры и дефис');
    if (sub !== c.duckSub) Object.assign(status, { ok: null, ip: '', at: 0, error: '' });
    c.duckSub = sub;
  }
  if (body.duckToken) {
    const t = String(body.duckToken).trim();
    if (!/^[0-9a-f-]{20,64}$/i.test(t)) throw bad('токен DuckDNS выглядит как 8-4-4-4-12 шестнадцатеричных символов: скопируйте его с duckdns.org');
    c.duckToken = t;
  }
  if (c.mode === 'duckdns' && !c.duckSub) throw bad('укажите имя на duckdns.org');
  store.saveConfig();
}

/** Отправляет текущий IP в DuckDNS. ip пустой: DuckDNS возьмёт адрес, с которого пришёл запрос. */
async function updateDuck(ip = '') {
  const c = cfg();
  if (!c.duckSub || !c.duckToken) throw Object.assign(new Error('укажите имя и токен DuckDNS'), { status: 400 });
  const q = new URLSearchParams({ domains: c.duckSub, token: c.duckToken, verbose: 'true' });
  if (ip) q.set('ip', ip);
  try {
    const r = await fetch(`${duckUrl()}/update?${q}`, { signal: AbortSignal.timeout(10000) });
    const lines = (await r.text()).trim().split(/\r?\n/).map((x) => x.trim());
    if (lines[0] !== 'OK') {
      Object.assign(status, { ok: false, at: Date.now(), error: 'DuckDNS отклонил обновление (KO): проверьте имя и токен' });
    } else {
      Object.assign(status, { ok: true, ip: lines[1] || ip, at: Date.now(), error: '' });
    }
  } catch (e) {
    Object.assign(status, { ok: false, at: Date.now(), error: 'DuckDNS недоступен: ' + e.message });
  }
  return view();
}

/** Имя действительно указывает на нужный IP? Проверка настоящим запросом к DNS. */
async function verify(host, expected) {
  const resolver = new dns.promises.Resolver();
  if (process.env.HEARTH_DNS_SERVER) resolver.setServers([process.env.HEARTH_DNS_SERVER]);
  try {
    const ips = await resolver.resolve4(host);
    return { host, ips, ok: !expected || ips.includes(expected) };
  } catch (e) {
    return { host, ips: [], ok: false, error: e.code === 'ENOTFOUND' || e.code === 'ENODATA' ? 'имя пока не найдено (DNS обновляется до пары минут)' : e.message };
  }
}

/** Периодически шлёт IP в DuckDNS и сообщает панели, когда имя стало рабочим или перестало. */
function start({ ipSource, emit, everyMs = +process.env.HEARTH_DUCK_MS || 5 * 60 * 1000 }) {
  const tick = async () => {
    const c = cfg();
    if (c.mode === 'duckdns' && c.duckSub && c.duckToken) await updateDuck(ipSource());
    const sig = JSON.stringify([c.mode, status.ok, status.ip]);
    if (sig !== lastEmitted) {
      lastEmitted = sig;
      emit('publicname', view());
    }
  };
  clearInterval(timer);
  timer = setInterval(() => tick().catch(() => {}), everyMs);
  timer.unref();
  return tick;
}

module.exports = { hostFor, view, set, updateDuck, verify, start, sslipHost, duckHost, slug };
