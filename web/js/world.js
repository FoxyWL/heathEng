'use strict';
// @imports:start
import { icon } from './icons.js';
import { T, api, askConfirm, click, dt, fmtSize, h, toast } from './lib.js';
import { S, cur, fill, isLive, ui } from './state.js';
// @imports:end
// Мир Minecraft: размеры, бэкап одним нажатием, сброс.

export async function worldTab() {
  const id = S.sel;
  const wrap = h('div', { class: 'world' });
  ui.body.replaceChildren(wrap);
  const load = async () => {
    let d;
    try {
      d = await api('GET', `/api/servers/${id}/world`);
    } catch (e) {
      return fill(wrap, h('p', { class: 'muted' }, e.message));
    }
    if (S.sel !== id || S.tab !== 'world') return;
    const total = d.parts.reduce((n, p) => n + p.size, 0);
    fill(wrap,
      d.running ? h('div', { class: 'notice' }, T('Сервер работает: сбросить мир можно только после остановки.', 'The server is running: the world can only be reset after stopping.')) : null,
      h('div', { class: 'tiles' },
        h('div', { class: 'tile' }, h('div', { class: 'tile-ico' }, icon('world', 18)), h('div', {}, h('small', {}, T('Название мира', 'World name')), h('b', {}, d.level))),
        h('div', { class: 'tile' }, h('div', { class: 'tile-ico' }, icon('folder', 18)), h('div', {}, h('small', {}, T('Размер', 'Size')), h('b', {}, fmtSize(total)))),
        h('div', { class: 'tile' }, h('div', { class: 'tile-ico' }, icon('star', 18)), h('div', {}, h('small', {}, 'Seed'), h('b', { class: 'mono' }, d.seed || T('случайный', 'random'))))),
      h('ul', { class: 'plist' }, d.parts.map((p) => h('li', { class: 'pl' + (p.exists ? '' : ' off') },
        h('span', { class: 'pl-ico' }, icon('world', 18)),
        h('span', { class: 'pl-name' }, h('b', {}, p.name), h('small', {}, p.exists ? fmtSize(p.size) + ' · ' + dt(p.mtime) : T('ещё не создан', 'not created yet')))))),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', on: { click: click(async () => { const r = await api('POST', `/api/servers/${id}/backups`, { keep: 7 }); toast(T('Бэкап создан: ', 'Backup created: ') + r.name); }) } }, icon('download', 16), T('Сделать бэкап', 'Back up now')),
        h('button', { class: 'btn danger', disabled: d.running, title: d.running ? T('Остановите сервер', 'Stop the server first') : '', on: { click: async () => {
          const ok = await askConfirm({ title: T('Сбросить мир?', 'Reset the world?'), text: T('Папки мира, Незера и Энда будут удалены. При следующем запуске создастся новый мир. Сделайте бэкап, если мир дорог.', 'The world, Nether and End folders will be deleted. A new world is created on the next start. Make a backup first if the world matters.'), ok: T('Сбросить мир', 'Reset world'), danger: true });
          if (!ok) return;
          try {
            const r = await api('POST', `/api/servers/${id}/world/reset`);
            toast(T(`Удалено папок: ${r.removed}`, `Folders removed: ${r.removed}`));
            load();
          } catch (e) {
            toast(e.message, true);
          }
        } } }, icon('trash', 16), T('Сбросить мир', 'Reset world'))),
      h('p', { class: 'muted' }, T('Сид и режим игры меняются во вкладке «Настройки» и вступают в силу при создании нового мира.', 'Seed and game mode are changed in “Settings” and apply when a new world is created.')));
  };
  let was = isLive(cur());
  ui.onState = () => {
    const now = isLive(cur());
    if (now !== was) {
      was = now;
      load();
    }
  };
  fill(wrap, h('div', { class: 'muted' }, h('span', { class: 'spinner' }), ' ', T('Загрузка…', 'Loading…')));
  await load();
}
