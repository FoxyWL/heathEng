'use strict';
// @imports:start
import { capacityPage } from './capacity.js';
import { closeEvents } from './events.js';
import { gameBadge } from './gameicons.js';
import { icon } from './icons.js';
import { $root, STATE, T, api, askConfirm, h, lang } from './lib.js';
import { networkPage } from './network.js';
import { newServerModal } from './newserver.js';
import { openPalette } from './palette.js';
import { serverPage } from './server.js';
import { serversPage } from './servers.js';
import { settingsPage } from './settings-page.js';
import { S, cur, gameName, isLive, ui } from './state.js';
import { tunnelsPage } from './tunnels.js';
import { welcome } from './welcome.js';
// @imports:end
// Оболочка: боковая панель (сворачивается), переключение разделов, выход из приложения.

const flameSvg = () =>
  h('span', { html: '<svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3c1.2 4.6 7 7.4 7 14a7 7 0 0 1-14 0c0-2.9 1.4-4.5 2.8-6.1.4 1.8 1.4 3 2.4 3.4C13.6 10.6 14.4 6.6 16 3z" fill="#f0a030"/><path d="M16 15c.6 2 3 3.1 3 5.6a3 3 0 0 1-6 0c0-1.3.7-2 1.3-2.7.2.8.6 1.2 1 1.4.1-1.7.3-3.2.7-4.3z" fill="#fff3d6"/></svg>' });

export function render() {
  ui.rail = h('aside', { class: 'rail' });
  ui.main = h('main', { class: 'main' });
  ui.app = h('div', { class: 'app' + (S.railMin ? ' min' : '') }, ui.rail, ui.main);
  $root.replaceChildren(ui.app);
  ui.railSig = '';
  renderRail();
  renderMain();
}

export function toggleRail() {
  S.railMin = !S.railMin;
  try {
    localStorage.setItem('hearth.rail', S.railMin ? 'min' : 'full');
  } catch {}
  if (ui.app) ui.app.classList.toggle('min', S.railMin);
  renderRail(true);
}

const shortGame = (id) => gameName(id).replace(/^Minecraft: Java Edition /, 'MC ');

export function renderRail(force) {
  if (!ui.rail) return;
  const sig = JSON.stringify([S.view, S.sel, S.railMin, lang, S.servers.map((x) => [x.id, x.name, x.state, x.players, x.settings.port, x.game, x.iconRev]), S.tun.relay.enabled, S.tun.relay.status]);
  if (!force && ui.railSig === sig && ui.rail.firstChild) return;
  ui.railSig = sig;
  const list = S.servers.length
    ? S.servers.map((s) =>
        h('button', { class: 'srv' + (S.view === 'server' && S.sel === s.id ? ' on' : ''), title: `${s.name} — ${STATE()[s.state] || s.state}`, 'aria-label': s.name, on: { click: () => go('server', s.id) } },
          S.railMin ? h('span', { class: 'gb-wrap' }, gameBadge(s.game, 'md', s.id, s.iconRev), h('span', { class: 'lamp ' + s.state })) : h('span', { class: 'lamp ' + s.state }),
          S.railMin ? null : h('span', {}, h('b', {}, s.name), h('small', {}, `${shortGame(s.game)} · :${s.settings.port || ''}${s.players != null ? ' · ' + s.players + '👤' : ''}`))))
    : S.railMin ? null : h('div', { class: 'empty-rail' }, T('Серверов пока нет. Нажмите «Новый сервер» внизу.', 'No servers yet. Press “New server” below.'));
  const nav = (view, ico, label, tip, extra) =>
    h('button', { class: 'rail-link' + (S.view === view ? ' on' : ''), title: tip || label, 'aria-label': label, on: { click: () => go(view) } }, icon(ico), S.railMin ? null : h('span', { class: 'lbl' }, label), extra);
  const live = S.servers.filter((s) => isLive(s)).length;
  ui.rail.replaceChildren(...[
    h('div', { class: 'brand' }, flameSvg(), S.railMin ? null : h('span', {}, 'Hearth'),
      h('button', { class: 'rail-toggle', title: S.railMin ? T('Развернуть панель', 'Expand the sidebar') : T('Свернуть панель', 'Collapse the sidebar'), 'aria-label': T('Свернуть панель', 'Toggle sidebar'), on: { click: toggleRail } }, icon(S.railMin ? 'chevronRight' : 'chevronLeft', 16))),
    h('div', { class: 'rail-nav' },
      nav('servers', 'servers', T('Обзор', 'Overview'), T('Все серверы на одной странице', 'All servers at a glance'), live && !S.railMin ? h('span', { class: 'count' }, live) : null),
      nav('capacity', 'cpu', T('Мощности', 'PC power'), T('Сколько мощностей ПК отдать серверам', 'How much of the PC to give to servers')),
      nav('network', 'world', T('Сеть', 'Network'), T('Адреса ПК, имена и доступ к серверам', 'PC addresses, names and server access'))),
    S.railMin ? null : h('div', { class: 'rail-title' }, T('Серверы', 'Servers')),
    h('div', { class: 'servers' }, list),
    h('div', { class: 'rail-nav bottom' },
      nav('tunnels', 'tunnel', T('Туннели', 'Tunnels'), T('Публичные адреса и релей', 'Public addresses and relay'), h('span', { class: 'lamp ' + (S.tun.relay.enabled ? S.tun.relay.status : '') })),
      nav('settings', 'settings', T('Настройки', 'Settings'), T('Язык, тема, ИИ-помощник', 'Language, theme, AI assistant'))),
    h('div', { class: 'rail-foot' },
      h('button', { class: 'btn on-dark' + (S.railMin ? ' icon-only' : ''), title: T('Новый сервер (Ctrl+N)', 'New server (Ctrl+N)'), 'aria-label': T('Новый сервер', 'New server'), on: { click: () => newServerModal() } }, icon('plus', 16), S.railMin ? null : h('span', { class: 'lbl' }, T('Новый сервер', 'New server'))),
      h('button', { class: 'btn quiet sm' + (S.railMin ? ' icon-only' : ''), title: T('Поиск и команды (Ctrl+K)', 'Search and commands (Ctrl+K)'), 'aria-label': T('Поиск', 'Search'), on: { click: () => openPalette() } }, icon('search', 15), S.railMin ? null : h('span', { class: 'lbl' }, T('Поиск · Ctrl+K', 'Search · Ctrl+K'))),
      h('button', { class: 'btn quiet sm' + (S.railMin ? ' icon-only' : ''), title: T('Остановить серверы и закрыть Hearth', 'Stop servers and close Hearth'), 'aria-label': T('Выйти из Hearth', 'Quit Hearth'), on: { click: quitApp } }, icon('power', 15), S.railMin ? null : h('span', { class: 'lbl' }, T('Выйти из Hearth', 'Quit Hearth')))),
  ].filter(Boolean));
}

export function go(view, id, tab) {
  S.view = view;
  if (id) {
    if (S.sel !== id) {
      S.tab = 'console';
      S.files = { path: '', items: [], open: null, text: '', orig: '' };
    }
    S.sel = id;
  }
  if (tab) S.tab = tab;
  S.anim = true;
  renderRail();
  renderMain();
}

export async function quitApp() {
  const running = S.servers.filter((s) => isLive(s)).length;
  const ok = await askConfirm({
    title: T('Выйти из Hearth?', 'Quit Hearth?'),
    text: running ? T(`Работающих серверов: ${running}. Они будут корректно остановлены, друзья потеряют соединение.`, `Running servers: ${running}. They will be stopped gracefully and friends will be disconnected.`) : T('Hearth закроется. Серверы сейчас не запущены.', 'Hearth will close. No servers are running.'),
    ok: T('Выйти', 'Quit'),
    danger: running > 0,
  });
  if (!ok) return;
  try {
    await api('POST', '/api/quit');
  } catch {}
  closeEvents();
  $root.replaceChildren(h('div', { class: 'goodbye enter' }, h('div', {}, h('h1', { style: 'font:600 30px var(--display)' }, T('Hearth остановлен', 'Hearth has stopped')), h('p', { class: 'muted' }, T('Это окно можно закрыть. Чтобы начать снова, запустите Hearth.', 'You can close this window. Run Hearth again to start over.')))));
  setTimeout(() => window.close(), 400);
}

export function renderMain() {
  ui.log = null;
  ui.restartNotice = null;
  ui.onState = null;
  ui.onTraffic = null;
  const anim = S.anim;
  S.anim = false;
  if (!S.servers.length && ['servers', 'server', 'welcome'].includes(S.view)) welcome();
  else if (S.view === 'servers' || S.view === 'welcome' || (S.view === 'server' && !cur())) serversPage();
  else if (S.view === 'capacity') capacityPage();
  else if (S.view === 'network') networkPage();
  else if (S.view === 'tunnels') tunnelsPage();
  else if (S.view === 'settings') settingsPage();
  else serverPage();
  if (anim && ui.main.firstElementChild) ui.main.firstElementChild.classList.add('enter');
}
