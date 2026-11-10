'use strict';
// @imports:start
import { lab } from './lib.js';
// @imports:end

export const S = {
  sys: null,
  catalog: [],
  servers: [],
  sel: '',
  view: 'servers',
  tab: 'console',
  tun: { relay: {}, tunnels: [] },
  net: null, // адреса этого ПК и их имена
  tunSel: '',
  tasks: [],
  cons: {},
  files: { path: '', items: [], open: null, text: '', orig: '' },
  anim: false,
  seenAddr: {},
  hist: {}, // id → {cpu:[], mem:[]}: последние замеры для графиков
  traffic: {}, // id → {last:{rx,tx,ts}, rx:[], tx:[]}: скорость туннеля
  q: '', // фильтр на странице серверов
  railMin: localStorage.getItem('hearth.rail') === 'min',
};
export const ui = {};
export function setTun(v) {
  if (v.rev && S.tun.rev && v.rev < S.tun.rev) return false;
  S.tun = v;
  return true;
}
export const srv = (id) => S.servers.find((s) => s.id === id);
export const cur = () => srv(S.sel);
export const gameOf = (id) => S.catalog.find((g) => g.id === id);
export const gameName = (id) => (gameOf(id) ? lab(gameOf(id).name) : id);
export const upsert = (v) => {
  const i = S.servers.findIndex((s) => s.id === v.id);
  if (i < 0) S.servers.push(v);
  else if (!(v.rev && S.servers[i].rev && v.rev < S.servers[i].rev)) S.servers[i] = v;
  if (v.cpu != null || v.mem) {
    const hh = S.hist[v.id] || (S.hist[v.id] = { cpu: [], mem: [] });
    hh.cpu.push(v.cpu || 0);
    hh.mem.push(v.mem || 0);
    if (hh.cpu.length > 60) {
      hh.cpu.shift();
      hh.mem.shift();
    }
  }
};
export const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
export const isMc = (s) => !!s && s.game.startsWith('minecraft');
export const isLive = (s) => !!s && ['running', 'starting'].includes(s.state);
