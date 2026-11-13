'use strict';
// @imports:start
import { appendLine, redrawLog, updateCmdState } from './console.js';
import { connectEvents, loadAll } from './events.js';
import { $root, T, h, hooks, setLang, setToken, toast, token } from './lib.js';
import { newServerModal } from './newserver.js';
import { openPalette } from './palette.js';
import { renderHeader, renderInvite, renderTab } from './server.js';
import { render, renderRail, toggleRail } from './shell.js';
import { S, cur, ui } from './state.js';
// @imports:end
// Точка входа: вход по токену, загрузка данных, связь событий с экраном, горячие клавиши.

export function gate(message) {
  const i = h('input', { type: 'password', placeholder: 'token', spellcheck: false, autocomplete: 'off', 'aria-label': 'token' });
  const submit = () => {
    setToken(i.value.trim());
    localStorage.setItem('hearth.token', token);
    boot();
  };
  i.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  $root.replaceChildren(
    h('div', { class: 'gate' },
      h('div', { class: 'box enter' },
        h('h1', {}, 'Hearth'),
        h('p', { class: 'muted' }, T('Окно приложения открывает Hearth само. Если вы видите это поле, вставьте токен доступа из консоли агента (строка «Панель: …#token=…»).', 'The app window opens Hearth by itself. If you see this field, paste the access token from the agent console (the “Panel: …#token=…” line).')),
        h('div', { class: 'err' }, message || ''),
        h('div', { class: 'field' }, i, h('button', { class: 'btn primary', on: { click: submit } }, T('Войти', 'Sign in'))))),
  );
  i.focus();
}
hooks.gate = gate;

// Перерисовка по событию не чаще раза в 250 мс: серверы шлют состояние часто (память, процессор)
let pend = 0;
function soon(fn) {
  if (pend) return;
  pend = setTimeout(() => {
    pend = 0;
    fn();
  }, 250);
}

hooks.render = render;
hooks.state = (v) => {
  soon(() => {
    renderRail();
    if (S.view === 'servers' && ui.onState) ui.onState();
    if (S.view === 'server' && cur()) {
      renderHeader();
      renderInvite();
      if (S.tab === 'console') updateCmdState();
      if (ui.restartNotice) ui.restartNotice.classList.toggle('hidden', !cur().restartRequired);
      if (ui.onState) ui.onState();
    }
  });
};
hooks.log = (id, line) => {
  if (S.view === 'server' && S.sel === id && S.tab === 'console' && ui.log) appendLine(line);
};
hooks.cleared = (id) => {
  if (S.view === 'server' && S.sel === id && S.tab === 'console' && ui.log) redrawLog();
};
hooks.install = (id) => {
  if (S.sel === id && S.view === 'server') renderHeader();
  else if (S.view === 'servers' && ui.onState) ui.onState();
};
hooks.tunnels = () => {
  renderRail();
  if (S.view === 'server') renderInvite();
  if (S.view === 'tunnels' && ui.redrawTunnels) ui.redrawTunnels();
  if (S.view === 'servers' && ui.onState) ui.onState();
};
hooks.traffic = () => {
  if (S.view === 'tunnels') {
    if (ui.redrawList) ui.redrawList();
    if (ui.onTraffic) ui.onTraffic();
  }
};
hooks.net = (ev) => {
  const say = {
    'ip-changed': () => T(`IP этого ПК изменился: ${ev.from} → ${ev.to}. Обновите имена в «Сети»`, `This PC’s IP changed: ${ev.from} → ${ev.to}. Update the names in “Network”`),
    offline: () => T('ПК потерял сеть: друзья не подключатся, пока она не вернётся', 'The PC lost its network: friends cannot connect until it is back'),
    online: () => T(`Сеть вернулась: ${ev.ip}`, `The network is back: ${ev.ip}`),
    unreachable: () => T(`Сервер «${ev.name}» недоступен в сети. Откройте «Сеть»`, `Server “${ev.name}” is not reachable on the network. Open “Network”`),
    recovered: () => T(`Сервер «${ev.name}» снова доступен в сети`, `Server “${ev.name}” is reachable again`),
  }[ev.type];
  if (say) toast(say(), ['unreachable', 'offline', 'ip-changed'].includes(ev.type));
  if (S.view === 'server') renderInvite();
  if (S.view === 'network' && ui.redrawNet) ui.redrawNet();
};
hooks.relay = (f) => {
  toast(f.connected ? (f.moved ? T(`Релей переехал, подключился по новому адресу ${f.host}:${f.port}`, `The relay moved, reconnected at ${f.host}:${f.port}`) : T(`Найден релей ${f.name || f.host}: подключён автоматически`, `Relay ${f.name || f.host} found and connected automatically`)) : T(`Найден релей ${f.name || f.host}. Откройте «Туннели», чтобы подключиться`, `Relay ${f.name || f.host} found. Open “Tunnels” to connect`));
  if (S.view === 'tunnels' && ui.redrawTunnels) ui.redrawTunnels();
  renderRail();
};
hooks.tasks = () => {
  if (S.view === 'server' && S.tab === 'schedule') renderTab();
};

setInterval(() => {
  const s = cur();
  if (S.view === 'server' && s && s.state === 'running' && ui.head) renderHeader();
}, 20000);

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (!S.sys) return;
  if (k === 'k') {
    e.preventDefault();
    openPalette();
  } else if (k === 'n' && !document.querySelector('.modal-back.in')) {
    e.preventDefault();
    newServerModal();
  } else if (k === 'b') {
    e.preventDefault();
    toggleRail();
  }
});

async function boot() {
  if (!token) return gate();
  try {
    await loadAll();
  } catch {
    return;
  }
  if (S.sys.lang && !localStorage.getItem('hearth.lang')) setLang(S.sys.lang);
  if (!S.sel && S.servers.length) S.sel = S.servers[0].id;
  S.view = S.servers.length ? 'servers' : 'welcome';
  connectEvents();
  S.anim = true;
  render();
}

boot();
