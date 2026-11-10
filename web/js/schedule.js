'use strict';
// @imports:start
import { T, api, askConfirm, click, downloadBlob, dt, fmtSize, guard, h, toast } from './lib.js';
import { S, ui } from './state.js';
// @imports:end

export const PRESETS = () => [
  ['0 4 * * *', T('Каждый день в 04:00', 'Every day at 04:00')],
  ['0 */6 * * *', T('Каждые 6 часов', 'Every 6 hours')],
  ['0 * * * *', T('Каждый час', 'Every hour')],
  ['*/30 * * * *', T('Каждые 30 минут', 'Every 30 minutes')],
  ['0 5 * * 0', T('По воскресеньям в 05:00', 'Sundays at 05:00')],
];
const ACTIONS = () => ({ backup: T('Бэкап', 'Backup'), restart: T('Перезапуск', 'Restart'), start: T('Запуск', 'Start'), stop: T('Остановка', 'Stop'), command: T('Команда', 'Command') });

export async function scheduleTab() {
  const id = S.sel;
  const wrap = h('div');
  ui.body.replaceChildren(wrap);
  const draw = async () => {
    if (S.sel !== id || S.tab !== 'schedule') return;
    let backups = [];
    try {
      backups = await api('GET', `/api/servers/${id}/backups`);
      S.tasks = await api('GET', '/api/tasks');
    } catch {}
    const mine = S.tasks.filter((t) => t.serverId === id);
    const name = h('input', { type: 'text', placeholder: T('Ночной бэкап', 'Nightly backup') });
    const act = h('select', {}, Object.entries(ACTIONS()).map(([k, v]) => h('option', { value: k }, v)));
    const cron = h('input', { type: 'text', value: '0 4 * * *', class: 'mono', spellcheck: false });
    const preset = h('select', { 'aria-label': T('Шаблон расписания', 'Schedule preset') }, [h('option', { value: '' }, T('Шаблон…', 'Preset…')), ...PRESETS().map(([c, l]) => h('option', { value: c }, l))]);
    preset.addEventListener('change', () => preset.value && (cron.value = preset.value));
    const cmd = h('input', { type: 'text', placeholder: 'say Restart in 1 minute', class: 'mono' });
    const keep = h('input', { type: 'number', value: 7, min: 1, max: 99 });
    const add = h('button', { class: 'btn primary' }, T('Добавить задачу', 'Add task'));
    add.addEventListener('click', click(async () => {
      await api('POST', '/api/tasks', { serverId: id, name: name.value || ACTIONS()[act.value], action: act.value, cron: cron.value, command: cmd.value, keep: +keep.value });
      toast(T('Задача добавлена', 'Task added'));
      await draw();
    }));
    const tasks = mine.length
      ? h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['', T('Задача', 'Task'), T('Расписание', 'Schedule'), T('Следующий запуск', 'Next run'), T('Последний результат', 'Last result'), ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, mine.map((t) => h('tr', {},
          h('td', {}, h('input', { type: 'checkbox', checked: t.enabled, title: T('Включена', 'Enabled'), on: { change: guard(async (e) => { await api('PATCH', `/api/tasks/${t.id}`, { enabled: e.target.checked }); await draw(); }) } })),
          h('td', {}, h('b', {}, t.name), h('div', { class: 'muted' }, ACTIONS()[t.action] + (t.action === 'command' ? ': ' + t.command : '') + (t.action === 'backup' ? T(`, хранить ${t.keep}`, `, keep ${t.keep}`) : ''))),
          h('td', { class: 'mono' }, t.cron),
          h('td', {}, t.enabled ? dt(t.next) : '—'),
          h('td', {}, t.lastRun ? `${dt(t.lastRun)} · ${t.lastResult}` : '—'),
          h('td', { class: 'r' },
            h('button', { class: 'btn sm', title: T('Выполнить прямо сейчас', 'Run right now'), on: { click: click(async () => { await api('POST', `/api/tasks/${t.id}/run`); toast(T('Задача выполнена', 'Task done')); await draw(); }) } }, T('Выполнить', 'Run now')), ' ',
            h('button', { class: 'btn sm ghost danger', title: T('Удалить задачу', 'Delete task'), on: { click: guard(async () => {
              const ok = await askConfirm({ title: T('Удалить задачу?', 'Delete this task?'), text: t.name, ok: T('Удалить', 'Delete'), danger: true });
              if (ok) {
                await api('DELETE', `/api/tasks/${t.id}`);
                await draw();
              }
            }) } }, '✕'))))))
      : h('p', { class: 'muted' }, T('Задач пока нет. Добавьте, например, ночной бэкап и перезапуск.', 'No tasks yet. Add a nightly backup and restart, for example.'));
    const bk = backups.length
      ? h('table', { class: 't' }, h('thead', {}, h('tr', {}, [T('Файл', 'File'), T('Размер', 'Size'), T('Создан', 'Created'), ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, backups.map((b) => h('tr', {},
          h('td', { class: 'mono' }, b.name), h('td', {}, fmtSize(b.size)), h('td', {}, dt(b.mtime)),
          h('td', { class: 'r' },
            h('button', { class: 'btn sm', on: { click: click(() => downloadBlob(`/api/servers/${id}/backups/${encodeURIComponent(b.name)}`, b.name)) } }, T('Скачать', 'Download')), ' ',
            h('button', { class: 'btn sm', title: T('Вернуть файлы сервера к этому бэкапу', 'Roll the server files back to this backup'), on: { click: guard(async () => {
              const ok = await askConfirm({ title: T('Восстановить из бэкапа?', 'Restore from backup?'), text: T('Файлы сервера будут перезаписаны содержимым бэкапа. Сервер должен быть остановлен.', 'Server files will be overwritten with the backup contents. The server must be stopped.'), ok: T('Восстановить', 'Restore'), danger: true });
              if (ok) {
                await api('POST', `/api/servers/${id}/backups/${encodeURIComponent(b.name)}/restore`);
                toast(T('Восстановлено', 'Restored'));
              }
            }) } }, T('Восстановить', 'Restore')), ' ',
            h('button', { class: 'btn sm ghost danger', title: T('Удалить бэкап', 'Delete backup'), on: { click: guard(async () => {
              const ok = await askConfirm({ title: T('Удалить бэкап?', 'Delete this backup?'), text: b.name, ok: T('Удалить', 'Delete'), danger: true });
              if (ok) {
                await api('DELETE', `/api/servers/${id}/backups/${encodeURIComponent(b.name)}`);
                await draw();
              }
            }) } }, '✕'))))))
      : h('p', { class: 'muted' }, T('Бэкапов пока нет.', 'No backups yet.'));
    wrap.replaceChildren(
      h('h3', { style: 'margin:0 0 8px;font:600 19px var(--display)' }, T('Расписание', 'Schedule')),
      tasks,
      h('div', { class: 'sect' },
        h('h3', {}, T('Новая задача', 'New task')),
        h('p', { class: 'muted' }, T('Время — местное. Формат cron: минута час день месяц день_недели. Проще выбрать шаблон.', 'Local time. Cron format: minute hour day month weekday. Picking a preset is easier.')),
        h('div', { class: 'form' },
          h('div', { class: 'field' }, h('label', {}, T('Название', 'Name'), name)),
          h('div', { class: 'field' }, h('label', {}, T('Действие', 'Action'), act)),
          h('div', { class: 'field' }, h('label', {}, 'Cron', cron), preset),
          h('div', { class: 'field' }, h('label', {}, T('Команда (для «Команда»)', 'Command (for “Command”)'), cmd)),
          h('div', { class: 'field' }, h('label', {}, T('Хранить бэкапов (для «Бэкап»)', 'Backups to keep (for “Backup”)'), keep))),
        h('div', { class: 'savebar' }, add)),
      h('div', { class: 'sect' },
        h('div', { class: 'head' }, h('h3', {}, T('Бэкапы', 'Backups')),
          h('button', { class: 'btn', on: { click: click(async () => { await api('POST', `/api/servers/${id}/backups`, {}); toast(T('Бэкап создан', 'Backup created')); await draw(); }) } }, T('Сделать бэкап сейчас', 'Back up now'))),
        bk),
    );
  };
  await draw();
}
