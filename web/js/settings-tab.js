'use strict';
// @imports:start
import { iconSection } from './iconpick.js';
import { icon } from './icons.js';
import { T, api, askChoice, askConfirm, click, h, lab, toast, withBusy } from './lib.js';
import { doAction, renderHeader, renderInvite } from './server.js';
import { renderRail } from './shell.js';
import { cur, gameOf, ui, upsert } from './state.js';
// @imports:end
// Вкладка «Настройки»: поля игры (кроме параметров запуска), поведение, публичные адреса по портам, удаление.

export function fieldInput(f, val) {
  if (f.type === 'bool') {
    const i = h('input', { type: 'checkbox', checked: !!val });
    i.dataset.key = f.key;
    i.dataset.type = 'bool';
    return [i, h('label', { class: 'check' }, i, h('span', {}, lab(f.label), f.help ? h('small', { class: 'muted', style: 'display:block' }, lab(f.help)) : null))];
  }
  let i;
  if (f.type === 'select') {
    i = h('select', {}, f.options.map(([v, l]) => h('option', { value: v, selected: v === val }, lab(l))));
    i.value = val;
  } else {
    i = h('input', { type: f.type === 'number' ? 'number' : 'text', value: val ?? '', min: f.min, max: f.max, step: f.step, spellcheck: false });
  }
  i.dataset.key = f.key;
  i.dataset.type = f.type;
  return [i, h('div', { class: 'field' + (f.wide ? ' wide' : '') }, h('label', {}, lab(f.label), i), f.help ? h('small', {}, lab(f.help)) : null)];
}

// Рисует поля одной группы и возвращает функцию, собирающую значения
export function fieldGroup(s, run) {
  const g = gameOf(s.game);
  const inputs = [];
  const els = (g ? g.fields : []).filter((f) => (f.group === 'run') === run).map((f) => {
    const [i, el] = fieldInput(f, s.settings[f.key] ?? f.default);
    inputs.push(i);
    return f.type === 'bool' ? h('div', { class: 'field wide' }, el) : el;
  });
  const collect = () => {
    const settings = {};
    for (const i of inputs) {
      const k = i.dataset.key;
      settings[k] = i.dataset.type === 'bool' ? i.checked : i.dataset.type === 'number' ? +i.value : i.value;
    }
    return settings;
  };
  return { els, collect, count: els.length };
}

export function restartNotice(s) {
  ui.restartNotice = h('div', { class: 'notice' + (s.restartRequired ? '' : ' hidden') },
    T('Изменения применятся после перезапуска сервера. ', 'Changes apply after the server restarts. '),
    h('button', { class: 'btn sm', on: { click: doAction('restart', s.id) } }, T('Перезапустить сейчас', 'Restart now')));
  return ui.restartNotice;
}

export function settingsTab() {
  const s = cur();
  const grp = fieldGroup(s, false);
  const name = h('input', { type: 'text', value: s.name });
  const auto = h('input', { type: 'checkbox', checked: s.autoRestart });
  const autostart = h('input', { type: 'checkbox', checked: s.autostart });
  const tEn = h('input', { type: 'checkbox', checked: s.tunnel.enabled });
  const tSub = h('input', { type: 'text', value: s.tunnel.subdomain || '', placeholder: 'my-server' });
  const tPort = h('input', { type: 'number', value: s.tunnel.remotePort || '', placeholder: T('любой свободный', 'any free port') });
  const ports = s.ports || [];
  const sel = (s.tunnel && s.tunnel.ports) || {};
  const portChecks = ports.map((p, i) => {
    const c = h('input', { type: 'checkbox', checked: i === 0 ? true : sel[i] !== undefined ? !!sel[i] : !p.optional, disabled: i === 0 });
    return { c, p, i };
  });
  const save = h('button', { class: 'btn primary' }, T('Сохранить', 'Save'));
  save.addEventListener('click', click(async () => {
    const pm = {};
    for (const x of portChecks) if (x.i > 0) pm[x.i] = x.c.checked;
    upsert(await api('PATCH', `/api/servers/${s.id}`, { name: name.value, autoRestart: auto.checked, autostart: autostart.checked, settings: grp.collect(), tunnel: { enabled: tEn.checked, subdomain: tSub.value.trim(), remotePort: +tPort.value || 0, ports: pm } }));
    renderRail();
    renderHeader();
    renderInvite();
    toast(T('Сохранено', 'Saved'));
  }));
  const remove = h('button', { class: 'btn danger' }, icon('trash', 16), T('Удалить сервер', 'Remove server'));
  remove.addEventListener('click', async () => {
    let files = false;
    if (s.imported) {
      const ok = await askConfirm({ title: T('Убрать сервер из Hearth?', 'Remove the server from Hearth?'), text: T('Папка с файлами останется на диске нетронутой.', 'The folder with its files stays on disk untouched.'), ok: T('Убрать из Hearth', 'Remove'), danger: true });
      if (!ok) return;
    } else {
      const c = await askChoice({
        title: T(`Удалить «${s.name}»?`, `Remove “${s.name}”?`),
        text: T('«Удалить с файлами» сотрёт папку сервера, мир, бэкапы и расписание. Это нельзя отменить. Можно оставить файлы на диске.', '“Delete with files” erases the server folder, the world, backups and schedule. This cannot be undone. You can keep the files on disk instead.'),
        buttons: [{ label: T('Отмена', 'Cancel'), value: 'cancel', focus: true }, { label: T('Оставить файлы', 'Keep files'), value: 'keep' }, { label: T('Удалить с файлами', 'Delete with files'), value: 'files', kind: 'danger' }],
      });
      if (c === 'cancel') return;
      files = c === 'files';
    }
    await withBusy(remove, async () => {
      const r = await api('DELETE', `/api/servers/${s.id}${files ? '?files=1' : ''}`);
      if (r.leftover && r.leftover.length) toast(T(`Сервер удалён, но часть файлов занята и осталась: ${r.leftover.join(', ')}`, `Server removed, but some files are in use and remain: ${r.leftover.join(', ')}`), true);
      else toast(files ? T(`Сервер удалён вместе с файлами (освобождено ${r.freedMb} МБ)`, `Server and its files removed (${r.freedMb} MB freed)`) : T('Сервер удалён', 'Server removed'));
    });
  });
  const portsBox = ports.length > 1
    ? h('div', { class: 'portlist' }, h('small', { class: 'muted' }, T('Какие порты открывать наружу', 'Which ports to expose')),
        portChecks.map(({ c, p, i }) => h('label', { class: 'check portrow' }, c, h('span', {}, `${lab(p.label)} — `, h('code', {}, `${(p.proto || '').toUpperCase()} ${p.port}`), i === 0 ? T(' (основной)', ' (main)') : p.optional ? T(' (по желанию)', ' (optional)') : ''))))
    : null;
  ui.body.replaceChildren(
    restartNotice(s),
    h('div', { class: 'form' }, h('div', { class: 'field wide' }, h('label', {}, T('Название', 'Name'), name)), grp.els),
    h('div', { class: 'sect' },
      h('h3', {}, T('Работа сервера', 'Server behaviour')),
      h('label', { class: 'check' }, auto, h('span', {}, T('Перезапускать автоматически, если сервер упал (до 5 раз за 10 минут)', 'Restart automatically if the server crashes (up to 5 times in 10 minutes)'))),
      h('label', { class: 'check' }, autostart, h('span', {}, T('Запускать вместе с Hearth', 'Start together with Hearth')))),
    h('div', { class: 'sect' },
      h('h3', {}, T('Публичный адрес', 'Public address')),
      h('p', { class: 'muted' }, T('Адрес остаётся закреплённым, пока включён, даже если сервер остановлен. Нужен настроенный релей в разделе «Туннели». Протокол каждого порта задан игрой.', 'The address stays reserved while enabled, even when the server is stopped. Requires a configured relay in “Tunnels”. Each port’s protocol is set by the game.')),
      h('label', { class: 'check' }, tEn, h('span', {}, T('Выдать публичный адрес через туннель', 'Provide a public address through the tunnel'))),
      portsBox,
      h('div', { class: 'form', style: 'margin-top:10px' },
        h('div', { class: 'field' }, h('label', {}, T('Поддомен (для HTTP)', 'Subdomain (HTTP)'), tSub)),
        h('div', { class: 'field' }, h('label', {}, T('Желаемый внешний порт', 'Preferred public port'), tPort)))),
    h('div', { class: 'savebar' }, save),
    iconSection(s),
    h('div', { class: 'sect' },
      h('h3', {}, T('Папка и удаление', 'Folder and removal')),
      h('p', { class: 'mono muted' }, s.dir),
      remove),
  );
}
