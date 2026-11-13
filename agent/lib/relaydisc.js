'use strict';
// Автоопределение релея: не нужно вводить адрес и порт вручную.
// Ищем (1) на этом ПК, (2) в локальной сети широковещательным запросом, (3) среди известных адресов (HEARTH_RELAYS, настройка) по /.well-known/hearth-relay.
// Токен релея по сети не передаётся: он берётся из ссылки-приглашения (hearth-relay://хост:порт?token=…) или вводится один раз.
const dgram = require('dgram');
const net = require('net');
const os = require('os');

const DISCOVERY_PORT = +process.env.HEARTH_DISCOVERY_PORT || 7001;

/** Принимает «hearth-relay://host:port?token=…», «host:port» или «host». */
function parseLink(input) {
  let v = String(input || '').trim();
  if (!v) throw new Error('вставьте ссылку-приглашение или адрес релея');
  let token = '';
  let name = '';
  const m = /^hearth-relay:\/\/(.+)$/i.exec(v);
  if (m) {
    const [rest, query = ''] = m[1].split('?');
    const q = new URLSearchParams(query);
    token = q.get('token') || '';
    name = q.get('name') || '';
    v = rest.replace(/\/$/, '');
  }
  const hp = /^([A-Za-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?$/.exec(v);
  if (!hp) throw new Error('не похоже на адрес релея: ' + v.slice(0, 60));
  const port = hp[2] ? +hp[2] : 7000;
  if (port < 1 || port > 65535) throw new Error('порт релея должен быть от 1 до 65535');
  return { host: hp[1], port, token, name };
}

/** Широковещательные адреса всех сетей этого ПК. */
function broadcasts() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

function udpSearch(targets, ms, port = DISCOVERY_PORT) {
  return new Promise((resolve) => {
    const found = new Map();
    const s = dgram.createSocket('udp4');
    s.on('error', () => {});
    s.on('message', (m, r) => {
      try {
        const j = JSON.parse(m.toString());
        if (j && j.hearthRelay === 1 && Number.isInteger(j.port)) found.set(`${r.address}:${j.port}`, { host: j.host && j.host !== 'localhost' ? j.host : r.address, via: r.address, port: j.port, name: String(j.name || '').slice(0, 60), tokenRequired: j.tokenRequired !== false, source: 'lan' });
      } catch {}
    });
    s.bind(0, () => {
      try {
        s.setBroadcast(true);
      } catch {}
      for (const t of targets) s.send('HEARTH-RELAY?', port, t, () => {});
      setTimeout(() => {
        try {
          s.close();
        } catch {}
        resolve([...found.values()]);
      }, ms);
    });
  });
}

async function wellKnown(host, port, ms = 2000) {
  try {
    const r = await fetch(`http://${host}:${port}/.well-known/hearth-relay`, { signal: AbortSignal.timeout(ms) });
    const j = await r.json();
    if (j && j.hearthRelay === 1) return { host: j.host || host, via: host, port: j.port, name: String(j.name || '').slice(0, 60), tokenRequired: j.tokenRequired !== false, source: 'known' };
  } catch {}
  return null;
}

/** Все найденные релеи. extra: известные адреса «host[:http-порт]». */
async function discover({ extra = [], ms = 1200, discoveryPort } = {}) {
  const list = await udpSearch(['127.0.0.1', ...broadcasts()], ms, discoveryPort);
  const known = (process.env.HEARTH_RELAYS ? process.env.HEARTH_RELAYS.split(',') : []).concat(extra).map((x) => x.trim()).filter(Boolean);
  const more = await Promise.all(known.map((k) => {
    const [h, p] = k.split(':');
    return wellKnown(h, +p || 80);
  }));
  const seen = new Set();
  return [...list, ...more.filter(Boolean)].filter((r) => {
    const key = r.host + ':' + r.port;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Проверка, что по адресу отвечает управляющий порт релея. */
function reachable(host, port, ms = 2500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: ms });
    s.on('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.on('timeout', () => {
      s.destroy();
      resolve(false);
    });
  });
}

module.exports = { parseLink, discover, reachable, DISCOVERY_PORT };
