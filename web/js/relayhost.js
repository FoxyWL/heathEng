'use strict';
// @imports:start
import { icon } from './icons.js';
import { T, api, askConfirm, click, copy, h, toast } from './lib.js';
import { S, fill, ui } from './state.js';
// @imports:end
// «Стать релеем»: релей Hearth на этом ПК для друзей (если у ПК белый IP). Порты открываются через UPnP, друзьям отдаётся одна ссылка.

const VERDICT = () => ({
  upnp: [T('Роутер найден: порты открыты автоматически.', 'Router found: the ports are opened automatically.'), 'ok'],
  manual: [T('Белый адрес есть, но роутер без UPnP: пробросьте порты вручную (ниже).', 'There is a public address but the router has no UPnP: forward the ports by hand (below).'), 'warn'],
  cgnat: [T('«Серый» адрес провайдера: релей работает только для устройств в вашей сети.', 'Carrier-grade NAT: the relay works for devices on your network only.'), 'bad'],
  unknown: [T('Нет связи с интернетом: релей доступен только в вашей сети.', 'No internet: the relay is available on your network only.'), 'dim'],
});

export function relayHostBox() {
  const box = h('details', { class: 'help relayhost', 'data-sect': 'relayhost' });
  let v = S.relayHost || null;
  const set = (x) => {
    v = x;
    S.relayHost = x;
    draw();
  };
  const act = (path, ok) => click(async () => {
    set(await api('POST', path));
    if (ok) toast(ok);
  });
  function draw() {
    const open = box.open;
    if (!v) return fill(box, h('summary', {}, T('Стать релеем для друзей', 'Become a relay for friends')), h('p', { class: 'muted' }, T('Загрузка…', 'Loading…')));
    const [msg, tone] = v.verdict ? VERDICT()[v.verdict] || ['', 'dim'] : ['', 'dim'];
    const head = h('summary', {}, T('Стать релеем для друзей', 'Become a relay for friends'), v.running ? h('span', { class: 'tag ok' }, T('работает', 'running')) : null);
    const intro = h('p', { class: 'muted' }, T('Друзьям, которые просто играют, ничего скачивать не нужно: им достаточно адреса сервера в игре. Релей на этом ПК нужен другим пользователям Hearth, которым нужны публичные адреса через ваш ПК (например, у них «серый» IP): они вставят ссылку в своём Hearth. Работает, если у ПК белый IP, и пока ПК включён.', 'Friends who just play do not need to download anything: the server address in the game is enough. A relay on this PC is for other Hearth users who need public addresses through your PC (for example, they have a shared IP): they paste the link into their own Hearth. It works if the PC has a public IP and only while the PC is on.'));
    const body = [intro];
    if (v.running || v.starting) {
      body.push(
        h('div', { class: 'rh-status' }, h('span', { class: 'lamp ' + (v.running ? 'running' : 'starting') }), h('b', {}, v.running ? T('Релей работает', 'The relay is running') : T('Запускаю…', 'Starting…'))),
        msg ? h('p', { class: 'tone-' + tone, 'data-verdict': v.verdict }, msg) : null,
        v.warning ? h('p', { class: 'tone-warn', 'data-role': 'relayhost-warning' }, v.warning) : null,
        v.link ? h('div', { class: 'addr-row main' }, h('code', { class: 'addr', 'data-role': 'relayhost-link' }, v.link), h('button', { class: 'btn sm', 'data-act': 'relayhost-copy', on: { click: (e) => copy(v.link, e.currentTarget) } }, icon('copy', 14), T('Копировать ссылку', 'Copy the link'))) : null,
        h('p', { class: 'muted' }, T(`Порт управления ${v.controlPort} (TCP) и порты туннелей ${v.portMin}–${v.portMax} (TCP и UDP). Ссылка содержит токен: отправляйте её только тем, кому доверяете.`, `Control port ${v.controlPort} (TCP) and tunnel ports ${v.portMin}–${v.portMax} (TCP and UDP). The link contains a token: send it only to people you trust.`)),
        v.verdict === 'manual' ? h('p', { class: 'muted' }, T(`Пробросьте на этот ПК: ${v.controlPort}/TCP и ${v.portMin}–${v.portMax} по TCP и UDP.`, `Forward to this PC: ${v.controlPort}/TCP and ${v.portMin}–${v.portMax} on TCP and UDP.`)) : null,
        h('p', { class: 'muted' }, T('При первом запуске Windows может спросить разрешение брандмауэра для Hearth: разрешите доступ.', 'On the first start Windows may ask for a firewall permission for Hearth: allow it.')),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn', 'data-act': 'relayhost-stop', on: { click: act('/api/relayhost/stop', T('Релей остановлен', 'Relay stopped')) } }, T('Остановить релей', 'Stop the relay')),
          h('button', { class: 'btn ghost', 'data-act': 'relayhost-token', title: T('Старая ссылка перестанет работать', 'The old link stops working'), on: { click: click(async () => {
            if (!(await askConfirm({ title: T('Сменить токен?', 'Change the token?'), text: T('Старая ссылка перестанет работать, подключённые друзья отключатся. Новую ссылку нужно отправить им заново.', 'The old link stops working and connected friends are disconnected. You need to send them the new link.'), ok: T('Сменить', 'Change') }))) return;
            set(await api('POST', '/api/relayhost/token'));
            toast(T('Токен сменён', 'Token changed'));
          }) } }, T('Сменить токен', 'Change token'))));
    } else {
      body.push(
        v.error ? h('p', { class: 'tone-bad', 'data-role': 'relayhost-error' }, v.error) : null,
        h('p', { class: 'muted' }, T(`Порт управления ${v.controlPort}, порты туннелей ${v.portMin}–${v.portMax}.`, `Control port ${v.controlPort}, tunnel ports ${v.portMin}–${v.portMax}.`)),
        h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', 'data-act': 'relayhost-start', on: { click: click(async () => {
          set({ ...v, starting: true, error: '' });
          try {
            set(await api('POST', '/api/relayhost/start'));
            toast(T('Релей запущен', 'Relay started'));
          } catch (e) {
            set({ ...v, starting: false, running: false, error: e.message });
          }
        }) } }, icon('tunnel', 16), T('Запустить релей на этом ПК', 'Run a relay on this PC'))));
    }
    fill(box, head, ...body);
    box.open = open || !!(v.running || v.starting);
  }
  ui.redrawRelayHost = () => box.isConnected && draw();
  draw();
  api('GET', '/api/relayhost').then((x) => {
    v = x;
    S.relayHost = x;
    draw();
    if (x.running) box.open = true;
  }).catch(() => {});
  return box;
}
