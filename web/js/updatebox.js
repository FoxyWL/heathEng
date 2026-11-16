'use strict';
// @imports:start
import { T, api, click, h, toast } from './lib.js';
import { S, fill, ui } from './state.js';
// @imports:end
// Обновления Hearth: проверка на GitHub, установка одной кнопкой (скачивание, сверка SHA-256, тихая установка, перезапуск).

export function updateBox() {
  const box = h('div', { class: 'sect', 'data-sect': 'update' });
  let v = S.update || null;
  const set = (x) => {
    v = x;
    S.update = x;
    draw();
  };
  function draw() {
    if (!v) return fill(box, h('h3', {}, T('Обновления', 'Updates')), h('p', { class: 'muted' }, T('Загрузка…', 'Loading…')));
    const a = v.available;
    const busy = !!v.stage;
    const stageText = { sum: T('Проверяю контрольную сумму…', 'Checking the checksum…'), download: T(`Скачиваю… ${v.pct || 0}%`, `Downloading… ${v.pct || 0}%`), install: T('Устанавливаю, Hearth перезапустится…', 'Installing, Hearth will restart…') }[v.stage];
    fill(box,
      h('h3', {}, T('Обновления', 'Updates'), a && !a.skipped ? h('span', { class: 'tag ok', 'data-role': 'update-new' }, T('есть новая версия', 'new version')) : null),
      h('p', { class: 'mono muted' }, T(`Установлена версия ${v.current}.`, `Version ${v.current} is installed.`), v.lastCheck ? ' ' + T('Проверено ', 'Checked ') + new Date(v.lastCheck).toLocaleTimeString() : ''),
      a ? h('div', { class: 'upd-new' },
        h('b', { 'data-role': 'update-version' }, T(`Доступна версия ${a.version}`, `Version ${a.version} is available`)),
        a.notes ? h('p', { class: 'muted' }, a.notes) : null,
        busy ? h('div', {}, h('div', { class: 'progress' + (v.stage === 'download' && v.pct ? '' : ' indet') }, h('i', { style: v.stage === 'download' ? `width:${v.pct || 0}%` : '' })), h('div', { class: 'progress-note' }, stageText))
          : h('div', { class: 'row-actions' },
            v.canInstall ? h('button', { class: 'btn primary', 'data-act': 'update-install', on: { click: click(async () => { try { set(await api('POST', '/api/update/install')); } catch (e) { toast(e.message, true); } }) } }, T('Обновить и перезапустить', 'Update and restart')) : h('p', { class: 'muted' }, T('Обновление ставится только в установленной версии: скачайте Hearth-Setup с GitHub.', 'Updating works in the installed version only: download Hearth-Setup from GitHub.')),
            h('button', { class: 'btn ghost', 'data-act': 'update-skip', on: { click: click(async () => { set(await api('PUT', '/api/update', { skip: a.version })); }) } }, T('Пропустить эту версию', 'Skip this version')))) : h('p', { class: 'muted', 'data-role': 'update-none' }, v.error ? '' : T('У вас последняя версия.', 'You are up to date.')),
      v.error ? h('p', { class: 'tone-bad', 'data-role': 'update-error' }, v.error) : null,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', 'data-act': 'update-check', disabled: v.checking || busy, on: { click: click(async () => { set({ ...v, checking: true }); set(await api('POST', '/api/update/check')); }) } }, v.checking ? T('Проверяю…', 'Checking…') : T('Проверить обновления', 'Check for updates')),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-act': 'update-auto', checked: v.auto, on: { change: click(async (e) => { set(await api('PUT', '/api/update', { auto: e.target.checked })); }) } }), ' ', T('Проверять автоматически', 'Check automatically'))));
  }
  ui.redrawUpdate = () => box.isConnected && draw();
  draw();
  api('GET', '/api/update').then(set).catch(() => {});
  return box;
}
