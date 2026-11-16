'use strict';
// @imports:start
import { T, api, askConfirm, click, copy, guard, h, toast } from './lib.js';
import { S, fill } from './state.js';
// @imports:end
// Пользователи панели: оператор запускает и останавливает выбранные серверы и пишет в консоль, зритель только смотрит. Токен показывается один раз.

const ROLE = () => ({ operator: T('Оператор', 'Operator'), viewer: T('Зритель', 'Viewer') });

export function usersBox() {
  const box = h('div', { class: 'sect', 'data-sect': 'users' });
  let data = null;
  let panel = null;
  let fresh = null;
  async function load() {
    [data, panel] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/panel')]);
    draw();
  }
  function draw() {
    if (!data) return fill(box, h('h3', {}, T('Пользователи', 'Users')), h('p', { class: 'muted' }, T('Загрузка…', 'Loading…')));
    const name = h('input', { type: 'text', placeholder: T('Имя (например, Вася)', 'Name (e.g. Sam)'), 'data-role': 'user-name' });
    const role = h('select', { 'data-role': 'user-role' }, Object.entries(ROLE()).map(([k, v]) => h('option', { value: k }, v)));
    const checks = data.servers.map((s) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: s.id, 'data-role': 'user-srv' }), h('span', {}, s.name)));
    const link = (tk) => location.origin + '/#token=' + tk;
    fill(box,
      h('h3', {}, T('Пользователи', 'Users')),
      h('p', { class: 'muted' }, T('Дайте другу свой токен-вход: оператор сможет запускать и останавливать выбранные серверы и писать в консоль, зритель — только смотреть. Файлы, настройки, туннели и релей им недоступны.', 'Give a friend their own sign-in token: an operator can start and stop the chosen servers and use the console, a viewer can only look. Files, settings, tunnels and the relay stay off limits.')),
      fresh ? h('div', { class: 'upd-new', 'data-role': 'user-fresh' },
        h('b', {}, T(`Токен для «${fresh.name}» (показывается один раз)`, `Token for “${fresh.name}” (shown once)`)),
        h('div', { class: 'addr-row main' }, h('code', { class: 'addr', 'data-role': 'user-token' }, fresh.token), h('button', { class: 'btn sm', on: { click: (e) => copy(fresh.token, e.currentTarget) } }, T('Копировать', 'Copy'))),
        h('div', { class: 'addr-row' }, h('code', { class: 'addr' }, link(fresh.token)), h('button', { class: 'btn sm', on: { click: (e) => copy(link(fresh.token), e.currentTarget) } }, T('Ссылка-вход', 'Sign-in link')))) : null,
      data.users.length ? h('table', { class: 't' }, h('thead', {}, h('tr', {}, [T('Имя', 'Name'), T('Роль', 'Role'), T('Серверы', 'Servers'), ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, data.users.map((u) => h('tr', { 'data-user': u.id },
          h('td', {}, h('b', {}, u.name), ' ', h('span', { class: 'muted mono' }, '…' + u.hint)),
          h('td', {}, ROLE()[u.role]),
          h('td', {}, u.servers === '*' ? T('все', 'all') : u.servers.map((id) => (data.servers.find((s) => s.id === id) || {}).name || id).join(', ') || '—'),
          h('td', { class: 'r' },
            h('button', { class: 'btn sm', 'data-act': 'user-reissue', title: T('Выдать новый токен: старый перестанет работать', 'Issue a new token: the old one stops working'), on: { click: click(async () => { const r = await api('POST', '/api/users/' + u.id + '/token'); fresh = { name: u.name, token: r.token }; await load(); }) } }, T('Новый токен', 'New token')), ' ',
            h('button', { class: 'btn sm ghost danger', 'data-act': 'user-delete', on: { click: guard(async () => {
              if (await askConfirm({ title: T('Удалить пользователя?', 'Delete the user?'), text: u.name, ok: T('Удалить', 'Delete'), danger: true })) {
                await api('DELETE', `/api/users/${u.id}`);
                await load();
              }
            }) } }, '✕'))))))
        : h('p', { class: 'muted' }, T('Пользователей пока нет.', 'No users yet.')),
      h('div', { class: 'form', style: 'margin-top:8px' },
        h('div', { class: 'field' }, h('label', {}, T('Имя', 'Name'), name)),
        h('div', { class: 'field' }, h('label', {}, T('Роль', 'Role'), role)),
        h('div', { class: 'field wide' }, h('label', {}, T('Серверы (ничего не отмечено — все)', 'Servers (none ticked — all)')), h('div', { class: 'notify-events' }, checks))),
      h('div', { class: 'savebar' }, h('button', { class: 'btn primary', 'data-act': 'user-add', on: { click: click(async () => {
        try {
          const ids = [...box.querySelectorAll('[data-role=user-srv]:checked')].map((x) => x.value);
          const r = await api('POST', '/api/users', { name: name.value, role: role.value, servers: ids.length ? ids : '*' });
          fresh = { name: r.user.name, token: r.token };
          await load();
        } catch (e) {
          toast(e.message, true);
        }
      }) } }, T('Добавить пользователя', 'Add user'))),
      h('div', { class: 'sect-sub' },
        h('h4', {}, T('Доступ к панели по сети', 'Panel access over the network')),
        h('p', { class: 'muted' }, T('По умолчанию панель слушает только этот ПК. Чтобы друг открыл её из вашей сети или через HTTP-туннель на порт панели, включите доступ по сети и перезапустите Hearth. Токен владельца никому не отдавайте: он даёт полный доступ.', 'By default the panel listens on this PC only. To let a friend open it from your network or via an HTTP tunnel to the panel port, enable network access and restart Hearth. Never share the owner token: it gives full control.')),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-role': 'panel-lan', checked: panel.lan, on: { change: click(async (e) => { panel = await api('PUT', '/api/panel', { lan: e.target.checked }); draw(); }) } }), h('span', {}, T(`Разрешить доступ по сети (порт ${panel.port})`, `Allow network access (port ${panel.port})`))),
        panel.restartNeeded ? h('p', { class: 'tone-warn', 'data-role': 'panel-restart' }, T('Изменение вступит в силу после перезапуска Hearth.', 'The change takes effect after Hearth restarts.')) : null));
  }
  draw();
  load().catch(() => {});
  void S;
  return box;
}
