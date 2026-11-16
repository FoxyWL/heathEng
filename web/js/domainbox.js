'use strict';
// @imports:start
import { T, api, click, copy, h, toast } from './lib.js';
import { S, fill } from './state.js';
// @imports:end
// Свой домен: какие записи DNS создать у регистратора, проверка, привязка к серверу (Minecraft Java, HTTPS, сайты: имя читается из подключения).

export function domainBox() {
  const box = h('details', { class: 'help domainbox', 'data-sect': 'domain' });
  const isNamed = (s) => /^minecraft-/.test(s.game);
  function draw() {
    const open = box.open;
    const r = S.tun.relay;
    const servers = (S.servers || []).filter(isNamed);
    const sel = h('select', { 'data-role': 'domain-server' }, servers.map((s) => h('option', { value: s.id }, s.name)));
    const first = servers[0];
    const inp = h('input', { type: 'text', 'data-role': 'domain-host', placeholder: 'play.example.com', spellcheck: false, value: (first && first.tunnel && first.tunnel.customHost) || '' });
    sel.addEventListener('change', () => {
      const s = servers.find((x) => x.id === sel.value);
      inp.value = (s && s.tunnel && s.tunnel.customHost) || '';
    });
    const out = h('div', { 'data-role': 'domain-result' });
    const show = (res) => fill(out,
      h('p', { class: res.ok ? 'tone-ok' : 'tone-warn', 'data-role': 'domain-verdict' }, res.ok ? T('Всё работает: имя ведёт на релей.', 'All good: the name leads to the relay.') : T('Пока не работает.', 'Not working yet.')),
      ...res.problems.map((p) => h('p', { class: 'tone-warn' }, p)),
      h('table', { class: 'dns' }, h('thead', {}, h('tr', {}, ['Тип', 'Имя', 'Значение'].map((x) => h('th', {}, x)))),
        h('tbody', {}, res.records.map((x) => h('tr', { title: x.note }, h('td', {}, x.type + (x.optional ? ' *' : '')), h('td', {}, h('code', {}, x.name)), h('td', {}, h('code', {}, x.value), ' ', h('button', { class: 'btn sm ghost', on: { click: (e) => copy(x.value, e.currentTarget) } }, T('Копир.', 'Copy'))))))),
      h('p', { class: 'muted' }, T('* — необязательная запись. После создания записей DNS обновляется от минут до часа.', '* optional record. DNS updates take minutes up to an hour after you create the records.')));
    const run = (save) => click(async () => {
      if (!servers.length) return;
      try {
        if (save) {
          await api('PATCH', `/api/servers/${sel.value}`, { tunnel: { customHost: inp.value.trim() } });
          toast(inp.value.trim() ? T('Имя привязано к серверу', 'Name linked to the server') : T('Своё имя убрано', 'Custom name removed'));
        }
        if (inp.value.trim()) show(await api('POST', '/api/domain/check', { host: inp.value.trim(), serverId: sel.value }));
      } catch (e) {
        toast(e.message, true);
      }
    });
    const ready = r.enabled && r.status === 'online' && r.vhostPort;
    fill(box,
      h('summary', {}, T('Своё имя (play.example.com)', 'Your own name (play.example.com)')),
      h('p', { class: 'muted' }, T('Если у вас есть домен, друзья смогут заходить по нему без порта. Hearth подскажет, какие записи создать, и проверит их.', 'If you own a domain, friends can join with it and no port. Hearth tells you which records to create and checks them.')),
      !ready ? h('p', { class: 'tone-warn', 'data-role': 'domain-na' }, T('Нужен релей с общим портом (установщик релея включает его по умолчанию). Сейчас такого релея нет.', 'A relay with a shared port is required (the relay installer enables it by default). There is none right now.')) : null,
      !servers.length ? h('p', { class: 'muted' }, T('Имена по домену доступны для серверов Minecraft Java.', 'Domain names work for Minecraft Java servers.')) : null,
      ready && servers.length ? h('div', { class: 'form' },
        h('div', { class: 'field' }, h('label', {}, T('Сервер', 'Server'), sel)),
        h('div', { class: 'field' }, h('label', {}, T('Ваше имя', 'Your name'), inp))) : null,
      ready && servers.length ? h('div', { class: 'savebar' }, h('button', { class: 'btn', 'data-act': 'domain-check', on: { click: run(false) } }, T('Записи и проверка', 'Records and check')), h('button', { class: 'btn primary', 'data-act': 'domain-save', on: { click: run(true) } }, T('Привязать и проверить', 'Link and check'))) : null,
      out);
    box.open = open;
  }
  draw();
  return box;
}
