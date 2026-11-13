'use strict';
// Значки игр: обложки из Steam (CDN) и Википедии, кэш на диске, свой значок для любого сервера.
// Скачивание только с известных хостов, не больше 3 МБ, формат проверяется по первым байтам.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { ART } = require('./gameart');

const HOSTS = new Set(['cdn.cloudflare.steamstatic.com', 'cdn.akamai.steamstatic.com', 'store.steampowered.com', 'en.wikipedia.org', 'upload.wikimedia.org']);
const MAX = 3 * 1048576;
const MISS_TTL = 24 * 3600 * 1000;
const EXTS = ['jpg', 'png', 'webp', 'gif'];
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const dir = () => {
  const d = path.join(store.paths.data, 'icons');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const inflight = new Map();

/** Формат картинки по первым байтам; '' если это не изображение. */
function sniff(buf) {
  if (buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.slice(0, 3).toString() === 'GIF') return 'gif';
  return '';
}

/** В тестах все запросы уходят на этот адрес. */
const rewrite = (u) => {
  const url = new URL(u);
  if (!HOSTS.has(url.hostname)) throw new Error('хост не разрешён: ' + url.hostname);
  if (process.env.HEARTH_ICON_MOCK) return process.env.HEARTH_ICON_MOCK.replace(/\/$/, '') + url.pathname + url.search;
  return url.href;
};

async function getBuf(u) {
  const r = await fetch(rewrite(u), { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Hearth' }, redirect: 'follow' });
  if (!r.ok) return null;
  const len = +r.headers.get('content-length') || 0;
  if (len > MAX) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length <= MAX ? buf : null;
}

const getJson = async (u) => {
  const b = await getBuf(u);
  try {
    return b ? JSON.parse(b.toString('utf8')) : null;
  } catch {
    return null;
  }
};

const steamUrls = (app) => {
  const base = `https://cdn.cloudflare.steamstatic.com/steam/apps/${app}`;
  return [`${base}/library_600x900.jpg`, `${base}/header.jpg`, `${base}/capsule_231x87.jpg`];
};

async function wikiUrl(title) {
  const j = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  const t = j && (j.thumbnail || j.originalimage);
  return t && t.source ? [t.source] : [];
}

function cached(key) {
  for (const ext of EXTS) {
    const f = path.join(dir(), `${key}.${ext}`);
    if (fs.existsSync(f)) return { file: f, mime: MIME[ext] };
  }
  return null;
}

function save(key, buf) {
  const ext = sniff(buf);
  if (!ext) return null;
  for (const e of EXTS) fs.rmSync(path.join(dir(), `${key}.${e}`), { force: true });
  const f = path.join(dir(), `${key}.${ext}`);
  fs.writeFileSync(f, buf);
  return { file: f, mime: MIME[ext] };
}

const missFile = () => path.join(dir(), 'misses.json');
const misses = () => {
  try {
    return JSON.parse(fs.readFileSync(missFile(), 'utf8'));
  } catch {
    return {};
  }
};
const markMiss = (key) => {
  const m = misses();
  m[key] = Date.now();
  fs.writeFileSync(missFile(), JSON.stringify(m));
};

async function fromCandidates(urls) {
  for (const u of urls) {
    try {
      const b = await getBuf(u);
      if (b && sniff(b)) return b;
    } catch {}
  }
  return null;
}

/** Значок игры из каталога. Скачивается один раз, затем берётся с диска. */
async function forGame(game) {
  const key = 'game-' + game;
  const c = cached(key);
  if (c) return c;
  const art = ART[game];
  if (!art) return null;
  if (Date.now() - (misses()[key] || 0) < MISS_TTL) return null;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const urls = art.app ? steamUrls(art.app) : await wikiUrl(art.wiki).catch(() => []);
    const buf = await fromCandidates(urls);
    if (!buf) {
      markMiss(key);
      return null;
    }
    return save(key, buf);
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Значок сервера: свой (загруженный или выбранный в Steam), иначе значок его игры. */
async function forServer(s) {
  return cached('srv-' + s.id) || forGame(s.game);
}

function setCustom(id, buf) {
  const r = save('srv-' + id, buf);
  if (!r) throw Object.assign(new Error('это не изображение (нужны PNG, JPG, WebP или GIF до 3 МБ)'), { status: 400 });
  return r;
}

async function setFromSteam(id, app) {
  if (!Number.isInteger(app) || app <= 0) throw Object.assign(new Error('нужен номер игры в Steam'), { status: 400 });
  const buf = await fromCandidates(steamUrls(app));
  if (!buf) throw Object.assign(new Error('у этой игры нет обложки в Steam'), { status: 404 });
  return save('srv-' + id, buf);
}

function clearCustom(id) {
  for (const e of EXTS) fs.rmSync(path.join(dir(), `srv-${id}.${e}`), { force: true });
}

/** Поиск игры в магазине Steam по названию: для своих серверов. */
async function searchSteam(term) {
  const q = String(term || '').trim().slice(0, 60);
  if (!q) return [];
  const j = await getJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=US`);
  return ((j && j.items) || []).slice(0, 8).map((i) => ({ app: i.id, name: i.name }));
}

module.exports = { forGame, forServer, setCustom, setFromSteam, clearCustom, searchSteam };
