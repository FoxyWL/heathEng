'use strict';
// @imports:start
import { icon } from './icons.js';
import { T, api, click, h, toast } from './lib.js';
import { fill, setTun } from './state.js';
// @imports:end
// Подключение к релею без ввода адреса: автопоиск в сети и ссылка-приглашение. Токен спрашивается только если он нужен.

export function relayFinder(done) {
  const box = h('div', { class: 'finder', 'data-sect': 'relay-find' });
  const list = h('div', { class: 'found' });
  const tokenIn = h('input', { type: 'password', placeholder: T('токен релея', 'relay token'), autocomplete: 'off', 'data-role': 'relay-token' });
  const link = h('input', { type: 'text', placeholder: 'hearth-relay://relay.example.com:7000?token=…', spellcheck: false, 'data-role': 'relay-link' });
  let pending = null; // найденный релей, которому нужен токен

  const finish = async (res, relay) => {
    if (res.needToken) {
      pending = relay;
      fill(list, h('div', { class: 'need-token' }, h('p', {}, T('Релей ' + (relay.name || relay.host) + ' найден. Введите его токен один раз:', 'Relay ' + (relay.name || relay.host) + ' found. Enter its token once:')), tokenIn,
        h('button', { class: 'btn primary', 'data-act': 'relay-token-ok', on: { click: click(() => connect({ ...pending, token: tokenIn.value })) } }, T('Подключить', 'Connect'))));
      return;
    }
    setTun(res);
    toast(T('Релей подключён', 'Relay connected'));
    done();
  };
  async function connect(r) {
    const res = await api('POST', '/api/relay/connect', { host: r.host, port: r.port, token: r.token, tokenRequired: r.tokenRequired, name: r.name });
    await finish(res, r);
  }

  const search = h('button', { class: 'btn primary', 'data-act': 'relay-find', on: { click: click(async () => {
    fill(list, h('p', { class: 'muted' }, h('span', { class: 'spinner' }), ' ', T('Ищу релей в сети…', 'Looking for a relay…')));
    const r = await api('GET', '/api/relay/discover');
    fill(list, r.found.length
      ? r.found.map((f) => h('div', { class: 'found-row', 'data-relay': f.port }, icon('tunnel', 16), h('b', {}, f.name || f.host), h('small', { class: 'mono' }, `${f.host}:${f.port}`),
        h('small', { class: 'muted' }, f.tokenRequired ? T('нужен токен', 'token required') : T('без токена', 'no token')),
        h('button', { class: 'btn sm', 'data-act': 'relay-use', on: { click: click(() => connect(f)) } }, T('Подключить', 'Connect'))))
      : h('p', { class: 'muted' }, T('Релей в сети не найден. Если он в интернете, вставьте ссылку-приглашение ниже.', 'No relay found on the network. If it is on the internet, paste the invite link below.')));
  }) } }, icon('refresh', 16), T('Найти релей автоматически', 'Find a relay automatically'));

  const useLink = h('button', { class: 'btn', 'data-act': 'relay-link-go', on: { click: click(async () => {
    const res = await api('POST', '/api/relay/connect', { link: link.value });
    await finish(res, { host: res.relay.host, port: res.relay.port, name: res.relay.srvName, tokenRequired: true });
  }) } }, T('Подключить по ссылке', 'Connect by link'));

  fill(box,
    h('div', { class: 'finder-row' }, search, h('small', { class: 'muted' }, T('Ищет на этом ПК и в вашей сети', 'Searches this PC and your network'))),
    list,
    h('div', { class: 'finder-row' }, h('div', { class: 'searchbar grow' }, icon('link', 16), link), useLink));
  return box;
}
