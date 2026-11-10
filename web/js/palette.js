'use strict';
// @imports:start
import { presetBudget } from './capacity.js';
import { openGuide } from './guide.js';
import { icon } from './icons.js';
import { T, api, closeBack, h, lab, openBack, toast } from './lib.js';
import { newServerModal } from './newserver.js';
import { startServer, tabList } from './server.js';
import { go, toggleRail } from './shell.js';
import { S, gameName, isLive, upsert } from './state.js';
// @imports:end
// Палитра команд (Ctrl+K): быстрый переход и действия с клавиатуры.

async function applyPreset(pct) {
  try {
    const d = await api('GET', '/api/capacity');
    await api('PUT', '/api/capacity', { budget: presetBudget(d.pc, pct) });
    toast(T(`Серверам отдано ${pct}% мощностей ПК`, `Servers get ${pct}% of the PC`));
    if (S.view === 'capacity') go('capacity');
  } catch (e) {
    toast(e.message, true);
  }
}

function items() {
  const out = [
    { label: T('Новый сервер', 'New server'), ico: 'plus', run: () => newServerModal(), hint: 'Ctrl+N' },
    { label: T('Обзор серверов', 'Servers overview'), ico: 'servers', run: () => go('servers') },
    { label: T('Мощности ПК', 'PC power'), ico: 'cpu', run: () => go('capacity') },
    ...[25, 50, 100].map((p) => ({ label: T(`Мощности: отдать ${p}% ПК`, `PC power: give ${p}% of the PC`), ico: 'cpu', hidden: true, run: () => applyPreset(p) })),
    { label: T('Сеть и имена', 'Network and names'), ico: 'world', run: () => go('network') },
    { label: T('Гайд за минуту', 'One-minute guide'), ico: 'book', run: () => openGuide() },
    { label: T('Туннели', 'Tunnels'), ico: 'tunnel', run: () => go('tunnels') },
    { label: T('Настройки Hearth', 'Hearth settings'), ico: 'settings', run: () => go('settings') },
    { label: T('Свернуть / развернуть панель', 'Collapse / expand the sidebar'), ico: 'chevronLeft', run: toggleRail, hint: 'Ctrl+B' },
  ];
  for (const s of S.servers) {
    out.push({ label: s.name, ico: 'servers', sub: gameName(s.game), run: () => go('server', s.id) });
    for (const [tab, name, ico] of tabList(s)) out.push({ label: `${s.name} → ${name}`, ico, run: () => go('server', s.id, tab), hidden: true });
    if (['stopped', 'crashed'].includes(s.state)) out.push({ label: T('Запустить: ', 'Start: ') + s.name, ico: 'play', run: () => startServer(s) });
    if (isLive(s)) {
      out.push({ label: T('Остановить: ', 'Stop: ') + s.name, ico: 'stop', run: () => api('POST', `/api/servers/${s.id}/stop`).then(upsert).catch((e) => toast(e.message, true)) });
      out.push({ label: T('Перезапустить: ', 'Restart: ') + s.name, ico: 'restart', run: () => api('POST', `/api/servers/${s.id}/restart`).then(upsert).catch((e) => toast(e.message, true)) });
    }
  }
  for (const g of S.catalog) out.push({ label: T('Создать: ', 'Create: ') + lab(g.name), ico: 'plus', run: () => newServerModal({ pick: g.id }), hidden: true });
  return out;
}

export function openPalette() {
  const ex = document.getElementById('palette');
  if (ex && !ex._closing) return;
  if (ex) ex.remove();
  const back = h('div', { class: 'modal-back top', id: 'palette' });
  const inp = h('input', { type: 'text', placeholder: T('Сервер, раздел или действие…', 'Server, section or action…'), spellcheck: false, 'aria-label': T('Поиск команд', 'Command search'), autocomplete: 'off' });
  const list = h('ul', { class: 'pal-list', role: 'listbox' });
  let all = items();
  let shown = [];
  let hi = 0;
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    closeBack(back);
  };
  const draw = () => {
    const q = inp.value.trim().toLowerCase();
    shown = all.filter((x) => (q ? (x.label + ' ' + (x.sub || '')).toLowerCase().includes(q) : !x.hidden)).slice(0, 12);
    hi = Math.min(hi, Math.max(0, shown.length - 1));
    list.replaceChildren(...(shown.length ? shown.map((x, i) => h('li', { class: 'pal-item' + (i === hi ? ' on' : ''), role: 'option', 'aria-selected': String(i === hi), on: { mousemove: () => { hi = i; mark(); }, click: () => pick(i) } },
      icon(x.ico, 16), h('span', {}, x.label, x.sub ? h('small', {}, ' · ' + x.sub) : null), x.hint ? h('kbd', {}, x.hint) : null)) : [h('li', { class: 'muted pal-empty' }, T('Ничего не найдено', 'Nothing found'))]));
  };
  const mark = () => [...list.children].forEach((el, i) => {
    el.classList.toggle('on', i === hi);
    el.setAttribute('aria-selected', String(i === hi));
  });
  const pick = (i) => {
    const x = shown[i];
    if (!x) return;
    close();
    setTimeout(() => x.run(), 30);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      hi = Math.min(shown.length - 1, hi + 1);
      mark();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      hi = Math.max(0, hi - 1);
      mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(hi);
    }
  };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', (e) => e.target === back && close());
  inp.addEventListener('input', () => {
    hi = 0;
    draw();
  });
  back.append(h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': T('Поиск и команды', 'Search and commands') }, h('div', { class: 'pal-input' }, icon('search', 18), inp), list));
  openBack(back);
  draw();
  inp.focus();
  void all;
}
