'use strict';
// @imports:start
import { dual, fmtRate, spark } from './charts.js';
import { icon } from './icons.js';
import { T, api, click, clock, copy, fmtSize, guard, h, toast, uptime } from './lib.js';
import { go, renderMain, renderRail } from './shell.js';
import { S, fill, setTun, ui } from './state.js';
// @imports:end
// Туннели: релей, список с живым трафиком, подробности выбранного туннеля, открытие любого порта.

const stText = () => ({ online: T('подключено', 'connected'), connecting: T('подключаюсь…', 'connecting…'), reconnecting: T('переподключаюсь…', 'reconnecting…'), error: T('ошибка', 'error'), idle: T('выключено', 'off') });
const protoName = (p) => (p === 'http' ? 'HTTP(S)' : (p || '').toUpperCase());
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? T(`${s} с назад`, `${s}s ago`) : s < 3600 ? T(`${Math.floor(s / 60)} мин назад`, `${Math.floor(s / 60)}m ago`) : clock(ts);
};

function detail(t) {
  const x = S.traffic[t.id] || { rx: [], tx: [], rate: { rx: 0, tx: 0 } };
  const st = t.stats || {};
  const box = h('div', { class: 'tdetail', 'data-tunnel': t.id });
  const chartHost = h('div', { class: 'chart' });
  const nums = h('div', { class: 'tiles small' });
  const draw = () => {
    const y = S.traffic[t.id] || { rx: [], tx: [], rate: { rx: 0, tx: 0 } };
    const cur2 = S.tun.tunnels.find((z) => z.id === t.id) || t;
    const c = cur2.stats || {};
    fill(chartHost, dual(y.rx, y.tx, { w: 360, h: 80 }), h('div', { class: 'legend' }, h('span', { class: 'a' }, '↓ ' + T('к вам', 'incoming') + ' ' + fmtRate(y.rate.rx)), h('span', { class: 'b' }, '↑ ' + T('от вас', 'outgoing') + ' ' + fmtRate(y.rate.tx))));
    fill(nums,
      h('div', { class: 'tile' }, h('div', {}, h('small', {}, T('Сейчас подключено', 'Connected now')), h('b', {}, c.conns || 0))),
      h('div', { class: 'tile' }, h('div', {}, h('small', {}, T('Всего подключений', 'Total connections')), h('b', {}, c.total || 0))),
      h('div', { class: 'tile' }, h('div', {}, h('small', {}, T('Принято', 'Received')), h('b', {}, fmtSize(c.rx || 0)))),
      h('div', { class: 'tile' }, h('div', {}, h('small', {}, T('Отправлено', 'Sent')), h('b', {}, fmtSize(c.tx || 0)))),
      h('div', { class: 'tile' }, h('div', {}, h('small', {}, T('Работает', 'Up for')), h('b', {}, c.since ? uptime(c.since) : '—'))));
  };
  draw();
  ui.onTraffic = draw;
  const events = (t.events || []).slice().reverse();
  box.append(
    h('div', { class: 'sect-head' }, h('h3', {}, t.name), h('span', { class: 'tag' }, protoName(t.proto) + ' · ' + T('локальный порт ', 'local port ') + t.localPort)),
    t.info ? h('div', { class: 'addr-row main' }, h('code', { class: 'addr' }, t.info.url), h('button', { class: 'btn sm', on: { click: (e) => copy(t.info.url, e.currentTarget) } }, T('Копировать', 'Copy'))) : h('p', { class: 'muted' }, t.error || T('ожидание адреса…', 'waiting for an address…')),
    chartHost, nums,
    h('h4', {}, T('События', 'Events')),
    events.length ? h('ul', { class: 'events' }, events.slice(0, 12).map((e) => h('li', { class: e.kind }, h('time', {}, ago(e.ts)), e.msg))) : h('p', { class: 'muted' }, T('Пока ничего не происходило.', 'Nothing has happened yet.')));
  void st;
  void x;
  return box;
}

export function tunnelsPage() {
  const r = S.tun.relay;
  const host = h('input', { type: 'text', value: r.host || '', placeholder: 'relay.example.com', spellcheck: false });
  const port = h('input', { type: 'number', value: r.port || 7000 });
  const tok = h('input', { type: 'password', placeholder: r.hasToken ? T('сохранён — оставьте пустым, чтобы не менять', 'saved — leave blank to keep') : T('токен релея', 'relay token'), autocomplete: 'off' });
  const en = h('input', { type: 'checkbox', checked: r.enabled });
  const saveRelay = h('button', { class: 'btn primary' }, T('Сохранить и подключиться', 'Save and connect'));
  saveRelay.addEventListener('click', click(async () => {
    setTun(await api('PUT', '/api/relay', { host: host.value, port: +port.value, token: tok.value, enabled: en.checked }));
    toast(T('Настройки туннеля сохранены', 'Tunnel settings saved'));
    renderRail();
    renderMain();
  }));
  const proto = h('select', {}, [['tcp', 'TCP'], ['udp', 'UDP'], ['http', 'HTTP(S)']].map(([v, l]) => h('option', { value: v }, l)));
  const lport = h('input', { type: 'number', min: 1, max: 65535, placeholder: '3000' });
  const sub = h('input', { type: 'text', placeholder: T('необязательно', 'optional'), spellcheck: false });
  const nm = h('input', { type: 'text', placeholder: T('Мой сайт', 'My site') });
  const addT = h('button', { class: 'btn primary' }, icon('plus', 16), T('Открыть порт', 'Expose port'));
  addT.addEventListener('click', click(async () => {
    setTun(await api('POST', '/api/tunnels', { proto: proto.value, localPort: +lport.value, subdomain: sub.value, name: nm.value }));
    toast(T('Порт открыт', 'Port exposed'));
    renderMain();
  }));
  if (!S.tun.tunnels.some((t) => t.id === S.tunSel)) S.tunSel = S.tun.tunnels[0] ? S.tun.tunnels[0].id : '';
  const list = h('div', { class: 'tlist' });
  const detailHost = h('div');
  const drawList = () => {
    const ts = S.tun.tunnels;
    fill(list, ts.map((t) => {
      const y = S.traffic[t.id];
      const st = t.stats || {};
      const on = t.enabled !== false;
      return h('div', { class: 'trow' + (S.tunSel === t.id ? ' on' : '') + (on ? '' : ' off'), 'data-tunnel': t.id },
        h('button', { class: 'trow-main', on: { click: () => { S.tunSel = t.id; drawList(); drawDetail(); } } },
          h('span', { class: 'lamp ' + (t.info ? 'running' : t.error ? 'crashed' : 'starting') }),
          h('span', { class: 'trow-name' }, h('b', {}, t.name), h('small', {}, `${protoName(t.proto)} · :${t.localPort}${t.info ? ' → ' + t.info.url : t.error ? ' · ' + t.error : ''}`)),
          h('span', { class: 'trow-rate' }, y ? spark(y.rx.map((v, i) => v + (y.tx[i] || 0)), { w: 90, h: 24 }) : null, h('small', {}, (st.conns || 0) + ' ' + T('подкл.', 'conn.')))),
        t.kind === 'port' ? h('label', { class: 'switch', title: on ? T('Выключить туннель', 'Turn the tunnel off') : T('Включить туннель', 'Turn the tunnel on') }, h('input', { type: 'checkbox', checked: on, 'aria-label': t.name, on: { change: guard(async (e) => { setTun(await api('PATCH', `/api/tunnels/${t.id}`, { enabled: e.target.checked })); }) } }), h('i')) : null,
        t.kind === 'port' ? h('button', { class: 'btn sm ghost danger', title: T('Закрыть этот туннель', 'Close this tunnel'), 'aria-label': T('Закрыть', 'Close'), on: { click: click(async () => { setTun(await api('DELETE', `/api/tunnels/${t.id}`)); renderMain(); }) } }, icon('x', 14)) : t.serverId ? h('button', { class: 'btn sm ghost', title: T('Открыть сервер', 'Open the server'), 'aria-label': T('Открыть сервер', 'Open the server'), on: { click: () => go('server', t.serverId) } }, icon('chevronRight', 14)) : null);
    }));
    if (!ts.length) fill(list, h('p', { class: 'muted' }, T('Туннелей пока нет. Включите публичный адрес у сервера или откройте любой порт ниже.', 'No tunnels yet. Turn on a public address for a server or expose any port below.')));
  };
  const drawDetail = () => {
    const t = S.tun.tunnels.find((z) => z.id === S.tunSel);
    fill(detailHost, t ? detail(t) : null);
    if (!t) ui.onTraffic = null;
  };
  drawList();
  drawDetail();
  const metaEl = h('div', { class: 'meta', style: 'margin-bottom:14px' });
  const drawMeta = () => {
    const rr = S.tun.relay;
    const lat = rr.enabled && rr.status === 'online' && rr.latency ? ` · ${rr.latency} ${T('мс', 'ms')}` : '';
    fill(metaEl, h('span', { class: 'lamp ' + (rr.enabled ? rr.status : '') }), h('b', {}, T('Релей: ', 'Relay: ') + (rr.enabled ? stText()[rr.status] || rr.status : stText().idle) + lat), rr.error ? h('span', { style: 'color:var(--bad)' }, rr.error) : null);
  };
  drawMeta();
  const relayCmd = 'RELAY_TOKEN=секрет RELAY_DOMAIN=tun.example.com PUBLIC_HOST=tun.example.com hearth relay';
  ui.main.replaceChildren(
    h('div', { class: 'page wide' },
      h('h1', {}, T('Туннели', 'Tunnels')),
      h('p', { class: 'lead' }, T('Туннель даёт публичный адрес без белого IP и проброса портов. Он работает через релей — небольшой сервер, который вы разворачиваете на любом VPS.', 'A tunnel gives you a public address with no public IP and no port forwarding. It goes through a relay — a small server you deploy on any VPS.')),
      metaEl,
      h('div', { class: 'cols' },
        h('div', {}, h('h2', {}, T('Активные туннели', 'Active tunnels')), list),
        detailHost),
      h('details', { class: 'help', open: !r.host }, h('summary', {}, T('Настройки релея', 'Relay settings')),
        h('div', { class: 'form' },
          h('div', { class: 'field' }, h('label', {}, T('Адрес релея', 'Relay host'), host), h('small', {}, T('Домен или IP вашего VPS', 'Domain or IP of your VPS'))),
          h('div', { class: 'field' }, h('label', {}, T('Порт управления', 'Control port'), port)),
          h('div', { class: 'field wide' }, h('label', {}, T('Токен', 'Token'), tok)),
          h('div', { class: 'field wide' }, h('label', { class: 'check' }, en, h('span', {}, T('Включить туннели', 'Enable tunnels'))))),
        h('div', { class: 'savebar' }, saveRelay)),
      h('div', { class: 'sect' },
        h('h3', {}, T('Открыть любой порт', 'Expose any port')),
        h('p', { class: 'muted' }, T('Покажите клиенту сайт с localhost, примите вебхук, дайте коллеге доступ к dev-машине, откройте приложение на реальном телефоне. Для HTTP релей отдаёт адрес вида имя.домен-релея.', 'Show a client the site on localhost, receive a webhook, give a colleague access to your dev box, open an app on a real phone. For HTTP the relay serves a name.relay-domain address.')),
        h('div', { class: 'form' },
          h('div', { class: 'field' }, h('label', {}, T('Название', 'Name'), nm)),
          h('div', { class: 'field' }, h('label', {}, T('Протокол', 'Protocol'), proto)),
          h('div', { class: 'field' }, h('label', {}, T('Локальный порт', 'Local port'), lport)),
          h('div', { class: 'field' }, h('label', {}, T('Поддомен (HTTP)', 'Subdomain (HTTP)'), sub))),
        h('div', { class: 'savebar' }, addT)),
      h('details', { class: 'help' },
        h('summary', {}, T('У меня нет релея. Как его запустить?', 'I have no relay. How do I run one?')),
        h('p', { class: 'muted' }, T('На VPS с белым IP запустите тот же файл в режиме релея, откройте порты 7000, 8080 и диапазон 20000–29999 (TCP и UDP). Для HTTP-адресов добавьте DNS-запись *.ваш-домен на IP сервера.', 'On a VPS with a public IP run the same file in relay mode, open ports 7000, 8080 and the range 20000–29999 (TCP and UDP). For HTTP addresses add a *.your-domain DNS record pointing at the server.')),
        h('div', { class: 'codeblock' }, h('pre', {}, relayCmd), h('button', { class: 'btn sm', on: { click: (e) => copy(relayCmd, e.currentTarget) } }, T('Копировать', 'Copy'))),
        h('p', { class: 'muted' }, T('Токен, который вы придумали, введите выше в поле «Токен».', 'Enter the token you made up in the “Token” field above.')))),
  );
  ui.redrawList = drawList;
  ui.redrawTunnels = () => {
    drawMeta();
    drawList();
    drawDetail();
  };
}
