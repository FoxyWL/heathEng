'use strict';
// @imports:start
import { T, api, askConfirm, askInput, click, h, toast } from './lib.js';
import { S, cur, fill, isLive, ui } from './state.js';
// @imports:end
// Игроки Minecraft: онлайн, белый список, операторы, баны.

const NAME = /^[A-Za-z0-9_.]{1,16}$/;

export async function playersTab() {
  const id = S.sel;
  const wrap = h('div', { class: 'players' });
  ui.body.replaceChildren(wrap);
  let data = null;
  const load = async () => {
    try {
      data = await api('GET', `/api/servers/${id}/players`);
    } catch (e) {
      return fill(wrap, h('p', { class: 'muted' }, e.message));
    }
    if (S.sel !== id || S.tab !== 'players') return;
    draw();
  };
  const act = (action, name, reason) => click(async () => {
    await api('POST', `/api/servers/${id}/players/${action}`, { name, reason });
    setTimeout(load, 700);
  });
  const ask = (action, title, ok) => async () => {
    const name = await askInput({ title, label: T('Ник игрока', 'Player name'), ok });
    if (!name) return;
    if (!NAME.test(name)) return toast(T('Ник: до 16 латинских букв, цифр, _ и .', 'Name: up to 16 letters, digits, _ and .'), true);
    try {
      await api('POST', `/api/servers/${id}/players/${action}`, { name });
      setTimeout(load, 700);
    } catch (e) {
      toast(e.message, true);
    }
  };
  const person = (name, actions, sub) => h('li', { class: 'person' },
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, name.slice(0, 1).toUpperCase()), h('span', { class: 'pname' }, h('b', {}, name), sub ? h('small', {}, sub) : null), h('span', { class: 'pact' }, actions));
  const sect = (title, hint, items, addBtn, empty) => h('section', { class: 'sect' },
    h('div', { class: 'sect-head' }, h('h3', {}, title), addBtn),
    hint ? h('p', { class: 'muted' }, hint) : null,
    items.length ? h('ul', { class: 'people' }, items) : h('p', { class: 'muted' }, empty));
  const draw = () => {
    const s = cur();
    if (!data.supported) return fill(wrap, h('p', { class: 'muted' }, T('Управление игроками доступно для Minecraft.', 'Player management is available for Minecraft.')));
    const running = data.running;
    const off = running ? '' : T('Сервер остановлен: команды выполняются только на работающем сервере.', 'The server is stopped: commands run only on a running server.');
    const btn = (label, fn, cls = 'btn sm') => h('button', { class: cls, disabled: !running, title: off, on: { click: fn } }, label);
    fill(wrap,
      !running ? h('div', { class: 'notice' }, off) : null,
      sect(T('Сейчас на сервере', 'Online now'), '', data.online.map((n) => person(n, [
        btn(T('Оператор', 'Op'), act('op', n)),
        btn(T('Выгнать', 'Kick'), async () => {
          const reason = await askInput({ title: T(`Выгнать ${n}?`, `Kick ${n}?`), label: T('Причина (необязательно)', 'Reason (optional)'), ok: T('Выгнать', 'Kick'), optional: true });
          if (reason !== null) await act('kick', n, reason === true ? '' : reason)({ currentTarget: null });
        }),
        btn(T('Забанить', 'Ban'), async () => {
          if (await askConfirm({ title: T(`Забанить ${n}?`, `Ban ${n}?`), text: T('Игрок не сможет зайти, пока вы его не разбаните.', 'The player cannot join until you unban them.'), ok: T('Забанить', 'Ban'), danger: true })) await act('ban', n)({ currentTarget: null });
        }, 'btn sm ghost danger'),
      ])), null, T('Никого нет онлайн.', 'Nobody is online.')),
      sect(T('Белый список', 'Whitelist'), s.settings.whitelist ? T('Включён: зайти могут только эти ники.', 'On: only these names can join.') : T('Сейчас выключен — включите «Только по белому списку» в настройках.', 'Currently off — enable “Whitelist only” in settings.'),
        data.whitelist.map((n) => person(n, [btn(T('Убрать', 'Remove'), act('whitelist-remove', n), 'btn sm ghost')])),
        btn('+ ' + T('Добавить', 'Add'), ask('whitelist-add', T('Добавить в белый список', 'Add to whitelist'), T('Добавить', 'Add')), 'btn sm'), T('Список пуст.', 'The list is empty.')),
      sect(T('Операторы', 'Operators'), '', data.ops.map((o) => person(o.name, [btn(T('Снять права', 'Deop'), act('deop', o.name), 'btn sm ghost')], T('уровень ', 'level ') + o.level)),
        btn('+ ' + T('Назначить', 'Add'), ask('op', T('Выдать права оператора', 'Grant operator rights'), T('Назначить', 'Grant')), 'btn sm'), T('Операторов нет.', 'No operators.')),
      sect(T('Забаненные', 'Banned'), '', data.banned.map((b) => person(b.name, [btn(T('Разбанить', 'Unban'), act('pardon', b.name), 'btn sm')], b.reason)),
        btn('+ ' + T('Забанить', 'Ban'), ask('ban', T('Забанить игрока', 'Ban a player'), T('Забанить', 'Ban')), 'btn sm'), T('Банов нет.', 'No bans.')));
  };
  ui.onState = () => {
    const s = cur();
    if (data && s && data.running !== isLive(s)) load();
    else if (data && s && isLive(s)) {
      const names = s.playerNames || [];
      if (names.join('|') !== data.online.join('|')) load();
    }
  };
  fill(wrap, h('div', { class: 'muted' }, h('span', { class: 'spinner' }), ' ', T('Загрузка…', 'Loading…')));
  await load();
}
