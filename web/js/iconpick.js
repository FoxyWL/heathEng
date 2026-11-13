'use strict';
// @imports:start
import { gameBadge } from './gameicons.js';
import { T, api, click, h, toast } from './lib.js';
import { renderRail } from './shell.js';
import { upsert } from './state.js';
// @imports:end
// Значок сервера: настоящий значок игры берётся автоматически; здесь его можно заменить обложкой из Steam или своей картинкой.

const SIZE = 256;

/** Картинка с диска → PNG не больше 256 px (так запрос остаётся маленьким). */
function shrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, SIZE / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(T('Не удалось прочитать картинку', 'Could not read the image')));
    };
    img.src = url;
  });
}

export function iconSection(s) {
  const preview = h('span', { class: 'icon-preview' });
  const results = h('div', { class: 'icon-results' });
  const draw = (sv) => preview.replaceChildren(gameBadge(sv.game, "lg", sv.id, sv.iconRev));
  draw(s);
  const apply = async (req) => {
    const v = await api('PUT', '/api/servers/' + s.id + '/icon', req);
    upsert(v);
    renderRail();
    draw(v);
    results.replaceChildren();
    toast(T('Значок обновлён', 'Icon updated'));
  };
  const term = h('input', { type: 'text', placeholder: T('Название игры в Steam', 'Game name in Steam'), 'data-role': 'icon-term', spellcheck: false });
  const find = async () => {
    const r = await api('GET', '/api/icons/search?term=' + encodeURIComponent(term.value));
    results.replaceChildren(...(r.length ? r.map((g) => h('button', { class: 'btn sm', 'data-app': g.app, on: { click: click(() => apply({ steamApp: g.app })) } }, g.name)) : [h('small', { class: 'muted' }, T('В Steam ничего не найдено', 'Nothing found in Steam'))]));
  };
  term.addEventListener('keydown', (e) => e.key === 'Enter' && click(find)({ currentTarget: term }));
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, 'data-role': 'icon-file' });
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    try {
      await apply({ dataUrl: await shrink(file.files[0]) });
    } catch (e) {
      toast(e.message, true);
    }
    file.value = '';
  });
  return h('div', { class: 'sect', 'data-sect': 'icon' },
    h('h3', {}, T('Значок', 'Icon')),
    h('p', { class: 'muted' }, T('Для игр из каталога значок скачивается сам (Steam, Википедия). Для своего сервера найдите игру в Steam или загрузите картинку.', 'For catalog games the icon is downloaded automatically (Steam, Wikipedia). For your own server find the game in Steam or upload a picture.')),
    h('div', { class: 'icon-row' }, preview,
      h('div', { class: 'searchbar grow' }, term),
      h('button', { class: 'btn', 'data-act': 'icon-find', on: { click: click(find) } }, T('Найти в Steam', 'Find in Steam')),
      h('button', { class: 'btn', 'data-act': 'icon-upload', on: { click: () => file.click() } }, T('Загрузить свой', 'Upload')),
      h('button', { class: 'btn ghost', 'data-act': 'icon-reset', on: { click: click(async () => { const v = await api('DELETE', '/api/servers/' + s.id + '/icon'); upsert(v); renderRail(); draw(v); toast(T('Значок сброшен', 'Icon reset')); }) } }, T('Сбросить', 'Reset')),
      file),
    results);
}
