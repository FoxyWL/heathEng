'use strict';
// @imports:start
import { icon } from './icons.js';
import { T, api, askConfirm, click, dt, fmtSize, guard, h, lang, toast } from './lib.js';
import { openSource, sourcesFor, sourcesList } from './sources.js';
import { S, cur, fill, ui } from './state.js';
// @imports:end
// Плагины и моды: установленные (вкл/выкл/удалить) и онлайн-поиск по Modrinth.

export async function pluginsTab() {
  const id = S.sel;
  const s0 = cur();
  const mods = s0.plugins === 'mods';
  const wrap = h('div', { class: 'plugins' });
  ui.body.replaceChildren(wrap);
  let data = null;
  let mode = 'installed';
  let canOnline = false;
  const body = h('div');
  const tabs = h('div', { class: 'seg', role: 'tablist' });
  const load = async () => {
    try {
      data = await api('GET', `/api/servers/${id}/plugins`);
      data.canOnline = canOnline;
    } catch (e) {
      return fill(body, h('p', { class: 'muted' }, e.message));
    }
    if (S.sel === id && S.tab === 'plugins') {
      drawTabs(!!data.canOnline);
      if (mode === 'installed') draw();
    }
  };
  const installed = new Set();
  const drawTabs = (canOnline) => fill(tabs,
    h('button', { class: 'seg-b' + (mode === 'installed' ? ' on' : ''), role: 'tab', 'data-mode': 'installed', on: { click: () => { mode = 'installed'; drawTabs(canOnline); draw(); } } }, T('Установленные', 'Installed') + (data ? ` (${data.items.length})` : '')),
    canOnline ? h('button', { class: 'seg-b' + (mode === 'online' ? ' on' : ''), role: 'tab', 'data-mode': 'online', on: { click: () => { mode = 'online'; drawTabs(canOnline); draw(); } } }, icon('globe', 14), T('Найти онлайн', 'Search online')) : null,
    h('button', { class: 'seg-b' + (mode === 'catalogs' ? ' on' : ''), role: 'tab', 'data-mode': 'catalogs', on: { click: () => { mode = 'catalogs'; drawTabs(canOnline); draw(); } } }, icon('external', 14), T('Каталоги', 'Catalogs')));
  const drawInstalled = () => {
    const kind = mods ? T('модов', 'mods') : T('плагинов', 'plugins');
    if (!data.items.length) {
      return fill(body, h('div', { class: 'empty' }, icon('puzzle', 28), h('p', {}, T(`Здесь пока нет ${kind}.`, `No ${kind} here yet.`)),
        h('div', { class: 'row-actions' }, data.canOnline ? h('button', { class: 'btn primary', on: { click: () => { mode = 'online'; drawTabs(true); draw(); } } }, icon('globe', 16), T('Найти онлайн', 'Search online')) : null,
          h('button', { class: 'btn', on: { click: click(async () => { await api('POST', `/api/servers/${id}/open-folder`); }) } }, icon('folder', 16), T('Открыть папку', 'Open folder')))));
    }
    fill(body,
      h('p', { class: 'muted' }, T(`Папка: ${data.dir}. Изменения вступят в силу после перезапуска сервера.`, `Folder: ${data.dir}. Changes take effect after the server restarts.`)),
      h('ul', { class: 'plist' }, data.items.map((p) => h('li', { class: 'pl' + (p.enabled ? '' : ' off') },
        h('span', { class: 'pl-ico' }, icon('puzzle', 18)),
        h('span', { class: 'pl-name' }, h('b', {}, p.name.replace(/\.disabled$/, '')), h('small', {}, fmtSize(p.size) + ' · ' + dt(p.mtime))),
        h('label', { class: 'switch', title: p.enabled ? T('Выключить', 'Disable') : T('Включить', 'Enable') }, h('input', { type: 'checkbox', checked: p.enabled, 'aria-label': p.name, on: { change: guard(async () => { await api('POST', `/api/servers/${id}/plugins/toggle`, { name: p.name }); await load(); }) } }), h('i')),
        h('button', { class: 'btn sm ghost danger', title: T('Удалить файл', 'Delete the file'), 'aria-label': T('Удалить', 'Delete'), on: { click: async () => {
          if (!(await askConfirm({ title: T('Удалить файл?', 'Delete the file?'), text: p.name, ok: T('Удалить', 'Delete'), danger: true }))) return;
          try {
            await api('DELETE', `/api/servers/${id}/plugins?name=${encodeURIComponent(p.name)}`);
            await load();
          } catch (e) {
            toast(e.message, true);
          }
        } } }, icon('trash', 15))))));
  };
  const drawOnline = () => {
    const q = h('input', { type: 'search', placeholder: T('Название плагина, например: worldedit', 'Plugin name, e.g. worldedit'), 'aria-label': T('Поиск плагинов', 'Search plugins'), spellcheck: false });
    const results = h('div', { class: 'hits' });
    let seq = 0;
    const run = async () => {
      const my = ++seq;
      fill(results, h('p', { class: 'muted' }, h('span', { class: 'spinner' }), ' ', T('Ищу на Modrinth…', 'Searching Modrinth…')));
      try {
        const r = await api('GET', `/api/servers/${id}/plugins/search?q=${encodeURIComponent(q.value.trim())}`);
        if (my !== seq || !results.isConnected) return;
        if (!r.hits.length) return fill(results, h('p', { class: 'muted' }, T('Ничего не найдено для этой версии сервера.', 'Nothing found for this server version.')));
        fill(results, r.hits.map((x) => {
          const done = installed.has(x.id);
          const btn = h('button', { class: 'btn sm primary', 'data-project': x.id, disabled: done }, done ? icon('check', 14) : icon('download', 14), done ? T('Установлен', 'Installed') : T('Установить', 'Install'));
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
              const res = await api('POST', `/api/servers/${id}/plugins/install`, { project: x.id });
              installed.add(x.id);
              btn.replaceChildren(icon('check', 14), T('Установлен', 'Installed'));
              toast(T(`Установлено: ${res.name}`, `Installed: ${res.name}`));
              load();
            } catch (e) {
              btn.disabled = false;
              toast(e.message, true);
            }
          });
          return h('article', { class: 'hit' },
            x.icon ? h('img', { src: x.icon, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'hit-ico' }, icon('puzzle', 22)),
            h('div', { class: 'hit-body' }, h('b', {}, x.title), h('small', {}, `${x.author} · ${Intl.NumberFormat(lang).format(x.downloads)} ${T('загрузок', 'downloads')}`), h('p', {}, x.description), h('div', { class: 'tags' }, x.categories.map((c) => h('span', { class: 'tag' }, c)))),
            btn);
        }));
      } catch (e) {
        if (my === seq) fill(results, h('div', { class: 'notice bad' }, T('Не удалось связаться с Modrinth: ', 'Could not reach Modrinth: ') + e.message));
      }
    };
    let timer = 0;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 350);
    });
    q.addEventListener('keydown', (e) => e.key === 'Enter' && (clearTimeout(timer), run()));
    fill(body,
      h('p', { class: 'muted' }, (/^\d/.test(s0.version) ? T(`Каталог Modrinth. Показаны ${mods ? 'моды' : 'плагины'}, совместимые с версией ${s0.version}. `, `Modrinth catalog. Showing ${mods ? 'mods' : 'plugins'} compatible with version ${s0.version}. `) : T('Каталог Modrinth. ', 'Modrinth catalog. ')) + T('Файл проверяется по контрольной сумме.', 'The file is checked against its checksum.')),
      h('div', { class: 'row-actions' }, h('div', { class: 'searchbar grow' }, icon('search', 16), q), (() => { const m = sourcesFor(s0.game).find((x) => x.id === 'modrinth'); return m ? h('button', { class: 'btn', 'data-source': 'modrinth-open', title: m.url, on: { click: () => openSource(m.url) } }, icon('external', 15), T('Открыть Modrinth', 'Open Modrinth')) : null; })()), results);
    q.focus();
    run();
  };
  const draw = () => (mode === 'online' ? drawOnline() : mode === 'catalogs' ? fill(body, sourcesList(s0.game, T('Откроется в вашем браузере. Скачанные файлы положите в папку плагинов или модов сервера.', 'Opens in your browser. Put downloaded files into the server plugins or mods folder.'))) : drawInstalled());
  fill(wrap, tabs, body);
  fill(body, h('div', { class: 'muted' }, h('span', { class: 'spinner' }), ' ', T('Загрузка…', 'Loading…')));
  await load0();
  async function load0() {
    try {
      data = await api('GET', `/api/servers/${id}/plugins`);
      const probe = await api('GET', `/api/servers/${id}/plugins/search?q=__probe__`).catch(() => ({ supported: false }));
      canOnline = !!probe.supported;
      data.canOnline = canOnline;
    } catch (e) {
      return fill(body, h('p', { class: 'muted' }, e.message));
    }
    if (!data.supported) return fill(body, h('p', { class: 'muted' }, T('У этой игры нет папки плагинов.', 'This game has no plugin folder.')));
    drawTabs(data.canOnline);
    draw();
  }
}
