'use strict';
// @imports:start
import { icon } from './icons.js';
import { T, api, guard, h, lab } from './lib.js';
import { gameOf } from './state.js';
// @imports:end
// Каталоги модов и плагинов: площадки, где берут файлы для выбранной игры. Ссылки открываются в браузере по умолчанию.

export const openSource = guard(async (url) => {
  await api('POST', '/api/open-url', { url });
});

export function sourcesFor(game) {
  const g = gameOf(game);
  return g && g.sources ? g.sources : [];
}

export function sourcesList(game, intro) {
  const list = sourcesFor(game);
  if (!list.length) return h('p', { class: 'muted' }, T('Для этой игры нет готового списка каталогов.', 'There is no ready-made catalog list for this game.'));
  return h('div', { class: 'sources' },
    intro ? h('p', { class: 'muted' }, intro) : null,
    h('div', { class: 'src-grid' }, list.map((x) =>
      h('button', { class: 'src' + (x.primary ? ' primary' : ''), 'data-source': x.id, title: x.url, on: { click: () => openSource(x.url) } },
        h('span', { class: 'src-ico' }, icon(x.primary ? 'star' : 'globe', 18)),
        h('span', { class: 'src-body' }, h('b', {}, x.name), h('small', {}, lab(x.note))),
        icon('external', 15)))));
}

export function catalogsTab(s) {
  return h('div', { class: 'plugins' },
    h('h3', { style: 'margin:0 0 4px' }, T('Где брать моды и дополнения', 'Where to get mods and add-ons')),
    sourcesList(s.game, T('Откроется в вашем браузере. Скачанные файлы кладутся в папку сервера (вкладка «Файлы»), а моды Steam Workshop подключаются по ID в настройках сервера.', 'Opens in your browser. Put downloaded files into the server folder (the Files tab); Steam Workshop mods are added by ID in the server settings.')));
}
