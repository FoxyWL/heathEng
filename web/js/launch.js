'use strict';
// @imports:start
import { icon } from './icons.js';
import { T, api, click, copy, h, lab, toast } from './lib.js';
import { renderHeader, renderInvite } from './server.js';
import { fieldGroup, restartNotice } from './settings-tab.js';
import { renderRail } from './shell.js';
import { cur, fill, ui, upsert } from './state.js';
// @imports:end
// Вкладка «Запуск»: параметры запуска (память, порт, аргументы) и итоговая командная строка.

export async function launchTab() {
  const s = cur();
  const id = s.id;
  const grp = fieldGroup(s, true);
  const line = h('pre', { class: 'cmdline' }, T('Собираю команду…', 'Building the command…'));
  const refreshLine = async () => {
    try {
      const r = await api('GET', `/api/servers/${id}/commandline`);
      if (line.isConnected) line.textContent = r.ok ? r.line : T('Команда будет собрана после установки: ', 'The command is built after installation: ') + r.error;
    } catch (e) {
      if (line.isConnected) line.textContent = e.message;
    }
  };
  const save = h('button', { class: 'btn primary' }, T('Сохранить', 'Save'));
  save.addEventListener('click', click(async () => {
    upsert(await api('PATCH', `/api/servers/${id}`, { settings: grp.collect() }));
    renderRail();
    renderHeader();
    renderInvite();
    toast(T('Сохранено', 'Saved'));
    refreshLine();
  }));
  const ports = h('div', { class: 'portlist' }, (s.ports || []).map((p) => h('span', { class: 'tag big' }, `${lab(p.label)} · ${(p.proto || '').toUpperCase()} ${p.port}`)));
  fill(ui.body,
    restartNotice(s),
    grp.count ? h('div', { class: 'form' }, grp.els) : h('p', { class: 'muted' }, T('У этой игры нет отдельных параметров запуска.', 'This game has no separate launch parameters.')),
    s.java ? h('p', { class: 'muted' }, T(`Для этой версии нужна Java ${s.java}. Hearth скачает её сам, если её нет.`, `This version needs Java ${s.java}. Hearth downloads it if missing.`)) : null,
    grp.count ? h('div', { class: 'savebar' }, save) : null,
    h('div', { class: 'sect' },
      h('h3', {}, T('Порты сервера', 'Server ports')), ports),
    h('div', { class: 'sect' },
      h('div', { class: 'sect-head' }, h('h3', {}, T('Итоговая команда запуска', 'Final launch command')), h('button', { class: 'btn sm', on: { click: (e) => copy(line.textContent, e.currentTarget) } }, icon('copy', 14), T('Копировать', 'Copy'))),
      line));
  refreshLine();
}
