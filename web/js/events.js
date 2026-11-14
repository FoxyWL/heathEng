'use strict';
// @imports:start
import { T, api, h, hooks, token } from './lib.js';
import { S, setTun, srv, upsert } from './state.js';
// @imports:end
// Поток серверных событий: состояние серверов, журнал, установка, туннели, трафик.

let es = null;
let wasOffline = false;

export function closeEvents() {
  if (es) es.close();
  es = null;
}

function setOffline(on) {
  const el = document.getElementById('offline');
  if (on && !el) document.body.append(h('div', { id: 'offline', class: 'offline', role: 'alert' }, T('Нет связи с Hearth. Пробую подключиться снова…', 'Lost connection to Hearth. Reconnecting…')));
  if (!on && el) el.remove();
}

export async function loadAll() {
  const [sys, catalog, servers, tun, tasks, net] = await Promise.all([api('GET', '/api/system'), api('GET', '/api/catalog'), api('GET', '/api/servers'), api('GET', '/api/tunnels'), api('GET', '/api/tasks'), api('GET', '/api/network').catch(() => null)]);
  S.sys = sys;
  S.catalog = catalog;
  S.servers = servers;
  S.tun = tun;
  S.tasks = tasks;
  S.net = net;
}

// Скорость считается на клиенте: сервер присылает накопленные счётчики раз в секунду.
function onTraffic({ ts, t }) {
  for (const [id, v] of Object.entries(t)) {
    const x = S.traffic[id] || (S.traffic[id] = { last: null, rx: [], tx: [], rate: { rx: 0, tx: 0 } });
    if (x.last && ts > x.last.ts) {
      const sec = (ts - x.last.ts) / 1000;
      x.rate = { rx: Math.max(0, (v.rx - x.last.rx) / sec), tx: Math.max(0, (v.tx - x.last.tx) / sec) };
      x.rx.push(x.rate.rx);
      x.tx.push(x.rate.tx);
      if (x.rx.length > 60) {
        x.rx.shift();
        x.tx.shift();
      }
    }
    x.last = { ...v, ts };
  }
  hooks.traffic();
}

export function connectEvents() {
  closeEvents();
  es = new EventSource('/api/events?token=' + encodeURIComponent(token));
  es.onopen = async () => {
    setOffline(false);
    if (wasOffline) {
      wasOffline = false;
      try {
        await loadAll();
        hooks.render();
      } catch {}
    }
  };
  es.onerror = () => {
    wasOffline = true;
    setOffline(true);
  };
  const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
  on('state', (v) => {
    upsert(v);
    hooks.state(v);
  });
  on('removed', ({ id }) => {
    S.servers = S.servers.filter((s) => s.id !== id);
    delete S.hist[id];
    if (S.sel === id) S.sel = S.servers.length ? S.servers[0].id : '';
    if (S.view === 'server' && !S.sel) S.view = 'servers';
    S.anim = true;
    hooks.render();
  });
  on('log', ({ id, line }) => {
    const c = S.cons[id];
    if (!c) return;
    c.lines.push(line);
    if (c.lines.length > 3000) c.lines.splice(0, c.lines.length - 3000);
    hooks.log(id, line);
  });
  on('cleared', ({ id }) => {
    if (S.cons[id]) S.cons[id].lines = [];
    hooks.cleared(id);
  });
  on('install', ({ id, msg, pct }) => {
    const s = srv(id);
    if (!s) return;
    s.msg = msg;
    s.pct = pct;
    hooks.install(id);
  });
  on('tunnels', (v) => {
    if (setTun(v)) hooks.tunnels();
  });
  on('net', async (ev) => {
    try {
      S.net = await api('GET', '/api/network');
    } catch {}
    hooks.net(ev);
  });
  on('relay-found', (f) => {
    S.relayFound = f;
    hooks.relay(f);
  });
  on('relayhost', (v) => {
    S.relayHost = v;
    hooks.relayhost();
  });
  on('publicname', (v) => {
    S.publicName = v;
    hooks.publicname();
  });
  on('traffic', onTraffic);
  on('tasks', (v) => {
    S.tasks = v;
    hooks.tasks();
  });
}
