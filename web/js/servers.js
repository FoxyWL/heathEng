'use strict';
// @imports:start
import { meter, spark } from './charts.js';
import { gameBadge } from './gameicons.js';
import { icon } from './icons.js';
import { STATE, T, copy, fmtMem, h } from './lib.js';
import { newServerModal } from './newserver.js';
import { doAction, startServer } from './server.js';
import { go } from './shell.js';
import { S, fill, gameName, isLive, ui } from './state.js';
// @imports:end
// Обзор: все серверы карточками, сводка и поиск.

function totals() {
  const live = S.servers.filter(isLive);
  const players = live.reduce((n, s) => n + (s.players || 0), 0);
  const mem = live.reduce((n, s) => n + (s.mem || 0), 0);
  const online = S.tun.tunnels.filter((t) => t.info).length;
  return { live: live.length, players, mem, online };
}

function statTile(label, value, sub, ico) {
  return h('div', { class: 'tile' }, h('div', { class: 'tile-ico' }, icon(ico, 18)), h('div', {}, h('small', {}, label), h('b', {}, value), sub ? h('em', {}, sub) : null));
}

function card(s) {
  const live = isLive(s);
  const t = S.tun.tunnels.find((x) => x.serverId === s.id && x.info && x.id === 'srv-' + s.id);
  const hist = S.hist[s.id];
  const frac = s.memLimit && s.mem ? s.mem / s.memLimit : 0;
  const main = (s.ports && s.ports[0]) || null;
  return h('article', { class: 'card srv-card ' + s.state, 'data-id': s.id },
    h('button', { class: 'card-main', title: T('Открыть сервер', 'Open the server'), on: { click: () => go('server', s.id) } },
      gameBadge(s.game, 'lg', s.id, s.iconRev),
      h('span', { class: 'card-title' }, h('b', {}, s.name), h('small', {}, `${gameName(s.game)}${s.version && s.version !== 'custom' ? ' ' + s.version : ''}`)),
      h('span', { class: 'badge ' + s.state }, STATE()[s.state] || s.state)),
    h('div', { class: 'card-stats' },
      h('span', { title: T('Порт', 'Port') }, main ? (main.proto || '').toUpperCase() + ' :' + main.port : '—'),
      s.players != null && live ? h('span', {}, icon('users', 14), s.players + (s.maxPlayers ? '/' + s.maxPlayers : '')) : null,
      live && s.mem ? h('span', {}, 'RAM ' + fmtMem(s.mem)) : null,
      live && s.cpu != null ? h('span', {}, 'CPU ' + Math.round(s.cpu) + '%') : null),
    live ? h('div', { class: 'card-live' }, hist ? spark(hist.mem, { w: 240, h: 26 }) : null, s.memLimit ? meter(frac) : null) : null,
    s.state === 'installing' ? h('div', {}, h('div', { class: 'progress' + (s.pct == null ? ' indet' : '') }, h('i', { style: s.pct == null ? '' : `width:${s.pct}%` })), h('small', { class: 'muted' }, s.msg || '')) : null,
    t ? h('div', { class: 'card-addr' }, h('code', {}, t.info.url), h('button', { class: 'btn sm', 'aria-label': T('Копировать адрес', 'Copy address'), on: { click: (e) => copy(t.info.url, e.currentTarget) } }, icon('copy', 14))) : null,
    h('div', { class: 'card-actions' },
      ['stopped', 'crashed'].includes(s.state) ? h('button', { class: 'btn primary sm', on: { click: (e) => startServer(s, e.currentTarget) } }, icon('play', 14), T('Запустить', 'Start')) : null,
      live ? h('button', { class: 'btn sm', on: { click: doAction('stop', s.id) } }, icon('stop', 14), T('Остановить', 'Stop')) : null,
      live ? h('button', { class: 'btn sm ghost', title: T('Перезапустить', 'Restart'), 'aria-label': T('Перезапустить', 'Restart'), on: { click: doAction('restart', s.id) } }, icon('restart', 14)) : null,
      h('button', { class: 'btn sm ghost', on: { click: () => go('server', s.id) } }, T('Открыть', 'Open'), icon('chevronRight', 14))));
}

export function serversPage() {
  const search = h('input', { type: 'search', placeholder: T('Найти сервер', 'Find a server'), value: S.q, 'aria-label': T('Поиск серверов', 'Search servers') });
  const grid = h('div', { class: 'grid' });
  // Карточка пересоздаётся, только если изменилось видимое: иначе нажатие на кнопку могло бы потеряться при обновлении
  const cache = new Map();
  const sigOf = (s) => {
    const t = S.tun.tunnels.find((x) => x.serverId === s.id && x.id === 'srv-' + s.id);
    return JSON.stringify([s.name, s.game, s.version, s.state, s.msg, s.pct, s.players, s.maxPlayers, Math.round((s.mem || 0) / 4), s.cpu == null ? '' : Math.round(s.cpu / 5), s.memLimit, t && t.info && t.info.url, s.ports && s.ports[0] && s.ports[0].port, s.iconRev]);
  };
  const draw = () => {
    const qq = S.q.trim().toLowerCase();
    const items = S.servers.filter((s) => !qq || (s.name + ' ' + gameName(s.game)).toLowerCase().includes(qq));
    const els = items.map((s) => {
      const sig = sigOf(s);
      const hit = cache.get(s.id);
      if (hit && hit.sig === sig) return hit.el;
      const el = card(s);
      cache.set(s.id, { sig, el });
      return el;
    });
    fill(grid, els.length ? els : h('p', { class: 'muted' }, T('Ничего не найдено.', 'Nothing found.')));
  };
  search.addEventListener('input', () => {
    S.q = search.value;
    draw();
  });
  const tiles = h('div', { class: 'tiles' });
  const drawTiles = () => {
    const t2 = totals();
    fill(tiles,
      statTile(T('Серверов работает', 'Servers running'), `${t2.live} / ${S.servers.length}`, '', 'servers'),
      statTile(T('Игроков онлайн', 'Players online'), t2.players, '', 'users'),
      statTile(T('Память серверов', 'Servers memory'), t2.mem ? fmtMem(t2.mem) : '—', S.sys && S.sys.totalMem ? T('из ', 'of ') + fmtMem(S.sys.totalMem) : '', 'ram'),
      statTile(T('Публичных адресов', 'Public addresses'), t2.online, S.tun.relay.enabled ? T('релей: ', 'relay: ') + (S.tun.relay.status === 'online' ? T('в сети', 'online') : S.tun.relay.status) : T('релей выключен', 'relay off'), 'tunnel'));
  };
  drawTiles();
  draw();
  // Мелкие обновления без перерисовки всей страницы: состояние и графики приходят по событиям
  ui.onState = () => {
    drawTiles();
    draw();
  };
  ui.main.replaceChildren(
    h('div', { class: 'page wide' },
      h('div', { class: 'head' }, h('div', {}, h('h1', {}, T('Серверы', 'Servers')), h('div', { class: 'meta' }, h('span', {}, T('Всё, что запущено на этом компьютере', 'Everything running on this computer')))),
        h('div', { class: 'actions' }, search, h('button', { class: 'btn primary', on: { click: () => newServerModal() } }, icon('plus', 16), T('Новый сервер', 'New server')))),
      tiles, grid),
  );
}
