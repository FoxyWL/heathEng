'use strict';
// @imports:start
import { T, api, click, h, toast } from './lib.js';
import { S, fill } from './state.js';
// @imports:end
// Уведомления: Discord, Telegram или свой вебхук. Токены и ссылки после сохранения не показываются.

const EV = () => ({
  crash: T('Сервер упал', 'A server crashed'),
  recovered: T('Сервер снова работает', 'A server is back'),
  disk: T('Мало места на диске', 'Low disk space'),
  ip: T('Сменился публичный IP', 'Public IP changed'),
  relay: T('Пропала связь с релеем', 'Relay connection lost'),
  update: T('Вышла новая версия Hearth', 'New Hearth version'),
  backup: T('Облачный бэкап не загрузился', 'Cloud backup failed'),
});
const TYPES = () => [['discord', 'Discord'], ['telegram', 'Telegram'], ['webhook', T('Свой вебхук (JSON)', 'Custom webhook (JSON)')]];

export function notifyBox() {
  const box = h('div', { class: 'sect', 'data-sect': 'notify' });
  let v = S.notify || null;
  let rows = [];
  const load = (x) => {
    v = x;
    S.notify = x;
    rows = x.targets.map((t) => ({ ...t, url: '', secret: '' }));
    draw();
  };
  function row(t, i) {
    const type = h('select', { 'data-role': 'notify-type' }, TYPES().map(([val, n]) => h('option', { value: val, selected: val === t.type }, n)));
    const url = h('input', { type: 'password', 'data-role': 'notify-url', placeholder: t.hint ? T(`сохранено (…${t.hint}), пусто — не менять`, `saved (…${t.hint}), blank keeps it`) : 'https://…', autocomplete: 'off' });
    const secret = h('input', { type: 'password', 'data-role': 'notify-secret', placeholder: t.hint ? T('токен сохранён', 'token saved') : T('токен бота от @BotFather', 'bot token from @BotFather'), autocomplete: 'off' });
    const chat = h('input', { type: 'text', 'data-role': 'notify-chat', placeholder: 'chat id', value: t.chatId || '' });
    const sync = () => {
      rows[i] = { ...rows[i], type: type.value, url: url.value, secret: secret.value, chatId: chat.value };
      url.hidden = type.value === 'telegram';
      secret.hidden = chat.hidden = type.value !== 'telegram';
    };
    for (const e of [type, url, secret, chat]) e.addEventListener('input', sync);
    sync();
    return h('div', { class: 'form notify-row' }, h('div', { class: 'field' }, type), h('div', { class: 'field wide' }, url, secret, chat),
      h('button', { class: 'btn ghost sm', title: T('Убрать', 'Remove'), on: { click: () => { rows.splice(i, 1); draw(); } } }, '✕'));
  }
  function draw() {
    if (!v) return fill(box, h('h3', {}, T('Уведомления', 'Notifications')), h('p', { class: 'muted' }, T('Загрузка…', 'Loading…')));
    const on = h('input', { type: 'checkbox', checked: v.enabled, 'data-role': 'notify-on' });
    const disk = h('input', { type: 'number', min: 1, value: v.diskGb, 'data-role': 'notify-disk' });
    const evs = Object.entries(EV()).map(([k, label]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-ev': k, checked: v.events[k] !== false }), h('span', {}, label)));
    const collect = () => ({
      enabled: on.checked,
      diskGb: +disk.value || 5,
      events: Object.fromEntries([...box.querySelectorAll('[data-ev]')].map((x) => [x.dataset.ev, x.checked])),
      targets: rows.map((r) => ({ id: r.id, type: r.type, name: r.name, url: r.url, secret: r.secret, chatId: r.chatId })),
    });
    fill(box,
      h('h3', {}, T('Уведомления', 'Notifications')),
      h('p', { class: 'muted' }, T('Hearth напишет вам в Discord или Telegram, когда сервер упал, кончается место, сменился IP или пропала связь с релеем.', 'Hearth messages you on Discord or Telegram when a server crashes, disk is low, the IP changes or the relay link drops.')),
      h('label', { class: 'check' }, on, h('span', {}, T('Включить уведомления', 'Enable notifications'))),
      h('div', { class: 'notify-targets' }, rows.map(row)),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn ghost', 'data-act': 'notify-add', on: { click: () => { rows.push({ type: 'discord', url: '', secret: '', chatId: '' }); draw(); } } }, T('+ Получатель', '+ Recipient'))),
      h('div', { class: 'notify-events' }, evs),
      h('div', { class: 'field' }, h('label', {}, T('Порог места на диске, ГБ', 'Disk threshold, GB'), disk)),
      h('div', { class: 'savebar' },
        h('button', { class: 'btn primary', 'data-act': 'notify-save', on: { click: click(async () => { try { load(await api('PUT', '/api/notify', collect())); toast(T('Сохранено', 'Saved')); } catch (e) { toast(e.message, true); } }) } }, T('Сохранить', 'Save')),
        h('button', { class: 'btn', 'data-act': 'notify-test', on: { click: click(async () => { try { await api('POST', '/api/notify/test'); toast(T('Отправлено: проверьте чат', 'Sent: check your chat')); } catch (e) { toast(e.message, true); } }) } }, T('Отправить пробное', 'Send a test'))),
      v.log && v.log.length ? h('p', { class: 'mono muted', 'data-role': 'notify-log' }, v.log.slice(-3).map((l) => `${new Date(l.ts).toLocaleTimeString()} ${l.title}${l.error ? ' — ' + l.error : ''}`).join(' · ')) : null);
  }
  draw();
  api('GET', '/api/notify').then(load).catch(() => {});
  return box;
}
