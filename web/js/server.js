'use strict';
// @imports:start
import { meter, spark } from './charts.js';
import { consoleTab } from './console.js';
import { filesTab } from './files.js';
import { gameBadge } from './gameicons.js';
import { icon } from './icons.js';
import { launchTab } from './launch.js';
import { STATE, T, api, askConfirm, click, copy, fmtMem, h, toast, uptime, withBusy } from './lib.js';
import { playersTab } from './players.js';
import { pluginsTab } from './plugins.js';
import { scheduleTab } from './schedule.js';
import { settingsTab } from './settings-tab.js';
import { go } from './shell.js';
import { catalogsTab } from './sources.js';
import { S, cur, fill, gameName, isLive, isMc, ui, upsert } from './state.js';
import { worldTab } from './world.js';
// @imports:end
// Страница сервера: шапка с живыми показателями, адрес для друзей, вкладки.

export function serverPage() {
  ui.head = h('div');
  ui.headSig = '';
  ui.inviteSig = '';
  ui.invite = h('div');
  ui.tabs = h('div');
  ui.body = h('div');
  ui.main.replaceChildren(h('div', { class: 'page' }, ui.head, ui.invite, ui.tabs, ui.body));
  renderHeader();
  renderInvite();
  renderTabs();
  renderTab(false);
}

export const doAction = (path, id) => async (e) => {
  const b = e && e.currentTarget;
  await withBusy(b, async () => upsert(await api('POST', `/api/servers/${id}/${path}`)));
};

export async function startServer(s, btn) {
  s = s || cur();
  await withBusy(btn, async () => {
    if (isMc(s) && !s.settings.acceptEula) {
      const ok = await askConfirm({
        title: T('Лицензия Minecraft', 'Minecraft licence'),
        text: T('Чтобы запустить сервер, нужно принять EULA Minecraft: aka.ms/MinecraftEULA.', 'To start the server you must accept the Minecraft EULA: aka.ms/MinecraftEULA.'),
        ok: T('Принять и запустить', 'Accept and start'),
      });
      if (!ok) return;
      await api('PATCH', `/api/servers/${s.id}`, { settings: { acceptEula: true } });
    }
    upsert(await api('POST', `/api/servers/${s.id}/start`));
  });
}

function resources(s) {
  const hist = S.hist[s.id] || { cpu: [], mem: [] };
  const frac = s.memLimit && s.mem ? s.mem / s.memLimit : 0;
  const cell = (label, value, sub, extra) => h('div', { class: 'res' }, h('small', {}, label), h('b', {}, value), sub ? h('em', {}, sub) : null, extra);
  return h('div', { class: 'resources' },
    cell('CPU', s.cpu != null ? Math.round(s.cpu) + '%' : '—', '', spark(hist.cpu, { w: 140, h: 28, max: 100 })),
    cell('RAM', s.mem ? fmtMem(s.mem) : '—', s.memLimit ? T('лимит ', 'limit ') + fmtMem(s.memLimit) : '', s.memLimit ? meter(frac) : spark(hist.mem, { w: 140, h: 28 })),
    isMc(s) || s.players != null ? cell(T('Игроки', 'Players'), (s.players ?? 0) + (s.maxPlayers ? ' / ' + s.maxPlayers : ''), s.playerNames && s.playerNames.length ? s.playerNames.slice(0, 3).join(', ') + (s.playerNames.length > 3 ? '…' : '') : T('никого нет', 'nobody online')) : null,
    cell(T('Аптайм', 'Uptime'), s.startedAt ? uptime(s.startedAt) : '—', s.pid ? 'PID ' + s.pid : ''));
}

// Шапка перерисовывается, только если изменилось то, что на ней видно: иначе нажатие на кнопку могло бы потеряться
const headSig = (s) => [s.name, s.state, s.msg, s.pct, s.players, (s.playerNames || []).join(','), s.maxPlayers, Math.round((s.mem || 0) / 4), s.cpu == null ? '' : Math.round(s.cpu / 5), s.memLimit, s.pid, s.startedAt ? Math.floor((Date.now() - s.startedAt) / 60000) : '', s.version, s.iconRev].join('|');

export function renderHeader() {
  const s = cur();
  if (!ui.head || !s) return;
  const sig = s.id + '#' + headSig(s);
  if (ui.headSig === sig && ui.head.firstChild) return;
  ui.headSig = sig;
  const st = STATE();
  const live = isLive(s);
  const btns = [];
  if (['stopped', 'crashed'].includes(s.state)) btns.push(h('button', { class: 'btn primary', title: T('Запустить сервер', 'Start the server'), on: { click: (e) => startServer(s, e.currentTarget) } }, icon('play', 16), T('Запустить', 'Start')));
  if (s.state === 'error') btns.push(h('button', { class: 'btn primary', on: { click: doAction('reinstall', s.id) } }, icon('refresh', 16), T('Повторить установку', 'Retry install')));
  if (live) {
    btns.push(h('button', { class: 'btn', title: T('Корректно остановить, мир сохранится', 'Stop gracefully, the world is saved'), on: { click: doAction('stop', s.id) } }, icon('stop', 16), T('Остановить', 'Stop')));
    btns.push(h('button', { class: 'btn', title: T('Остановить и запустить снова', 'Stop and start again'), on: { click: doAction('restart', s.id) } }, icon('restart', 16), T('Перезапустить', 'Restart')));
  }
  if (live || s.state === 'stopping') {
    btns.push(h('button', { class: 'btn ghost danger', title: T('Только если сервер завис', 'Only if the server is stuck'), on: { click: async (e) => {
      const b = e.currentTarget;
      const ok = await askConfirm({ title: T('Завершить принудительно?', 'Force kill?'), text: T('Процесс будет убит сразу. Несохранённые данные мира могут пропасть.', 'The process is killed immediately. Unsaved world data may be lost.'), ok: T('Завершить', 'Kill'), danger: true });
      if (ok) await withBusy(b, async () => upsert(await api('POST', `/api/servers/${s.id}/kill`)));
    } } }, T('Принудительно', 'Force kill')));
  }
  btns.push(h('button', { class: 'btn ghost', title: T('Открыть папку сервера в проводнике', 'Open the server folder in the file manager'), on: { click: click(async () => { await api('POST', `/api/servers/${s.id}/open-folder`); toast(T('Папка открыта', 'Folder opened')); }) } }, icon('folder', 16), T('Папка', 'Folder')));
  const meta = [
    h('span', { class: 'lamp ' + s.state }),
    h('span', { class: 'badge ' + s.state }, st[s.state] || s.state),
    ['crashed', 'error'].includes(s.state) && s.msg ? h('span', {}, s.msg) : null,
    gameBadge(s.game, 'sm', s.id, s.iconRev),
    h('span', {}, `${gameName(s.game)}${s.version && s.version !== 'custom' ? ' ' + s.version : ''}`),
  ];
  const progress = s.state === 'installing'
    ? h('div', {}, h('div', { class: 'progress' + (s.pct == null ? ' indet' : '') }, h('i', { style: s.pct == null ? '' : `width:${s.pct}%` })), h('div', { class: 'progress-note' }, (s.msg || T('Подготовка…', 'Preparing…')) + (s.pct != null ? ` — ${s.pct}%` : '')))
    : null;
  fill(ui.head, h('div', { class: 'head' }, h('div', {}, h('h1', {}, s.name), h('div', { class: 'meta' }, meta)), h('div', { class: 'actions' }, btns)), progress, live ? resources(s) : null);
}

function addrRow(t, main) {
  return h('div', { class: 'addr-row' + (main ? ' main' : '') },
    main ? null : h('span', { class: 'addr-label' }, t.name.split(' · ').slice(1).join(' · ') || t.id),
    t.info ? h('code', { class: 'addr' }, t.info.url) : h('span', { class: 'addr dim' }, t.error || T('ожидание…', 'waiting…')),
    t.info ? h('button', { class: 'btn' + (main ? '' : ' sm'), title: T('Скопировать адрес', 'Copy the address'), on: { click: (e) => copy(t.info.url, e.currentTarget) } }, T('Скопировать', 'Copy')) : null);
}

// основной порт игры (первый TCP) — для строки «В вашей сети»
const portOf = (s) => {
  const p = (s.ports || []).find((x) => x.proto === 'TCP' && !x.optional) || (s.ports || [])[0];
  return p ? p.port : s.port || null;
};

export function renderInvite() {
  const s = cur();
  if (!ui.invite || !s) return;
  const r = S.tun.relay;
  const mine = S.tun.tunnels.filter((x) => x.serverId === s.id);
  const t = mine.find((x) => x.id === 'srv-' + s.id);
  const extra = mine.filter((x) => x !== t);
  const lan = S.net && S.net.addresses.find((x) => x.primary);
  const lanPort = lan && portOf(s);
  const sig = JSON.stringify([s.id, s.game, s.tunnel.enabled, r.enabled, r.host, r.status, r.error, lan && lan.ip, lanPort, s.netName, s.publicIp && s.publicIp.ext, s.publicIp && s.publicIp.error, mine.map((x) => [x.id, x.info && x.info.url, x.error, x.name])]);
  if (ui.inviteSig === sig && ui.invite.firstChild) return;
  ui.inviteSig = sig;
  const row = [h('div', { class: 'lbl' }, T('Адрес для друзей', 'Address for friends'))];
  let fresh = false;
  let howto = null;
  if (t && t.info) {
    row.push(h('div', { class: 'addr' }, t.info.url));
    row.push(h('button', { class: 'btn', title: T('Скопировать адрес', 'Copy the address'), on: { click: (e) => copy(t.info.url, e.currentTarget) } }, T('Скопировать', 'Copy')));
    row.push(h('button', { class: 'btn ghost', title: T('Закрыть публичный доступ', 'Close public access'), on: { click: click(async () => { await api('PATCH', `/api/servers/${s.id}`, { tunnel: { enabled: false } }); }) } }, T('Выключить', 'Turn off')));
    fresh = S.seenAddr[s.id] !== t.info.url;
    S.seenAddr[s.id] = t.info.url;
    if (isMc(s)) howto = T('Друзьям: Minecraft → «Сетевая игра» → «Прямое подключение» → вставить адрес.', 'For friends: Minecraft → “Multiplayer” → “Direct Connection” → paste the address.');
    else if (t.proto === 'http') howto = T('Откройте этот адрес в любом браузере.', 'Open this address in any browser.');
    else if (['cs16', 'czero', 'dod', 'cs2', 'tf2', 'gmod', 'l4d2', 'svencoop'].includes(s.game)) howto = T('Друзьям: в консоли игры (~) ввести connect и адрес.', 'For friends: in the game console (~) type connect and the address.');
    else howto = T('Друзьям: вставить адрес в прямое подключение или в консоль игры.', 'For friends: paste the address into the direct-connect box or the game console.');
  } else if (!r.enabled || !r.host) {
    row.push(h('div', { class: 'addr dim' }, T('Друзья пока не смогут подключиться: туннель не настроен.', 'Friends cannot connect yet: the tunnel is not set up.')));
    row.push(h('button', { class: 'btn flame', on: { click: () => go('tunnels') } }, T('Настроить туннель', 'Set up the tunnel')));
  } else if (!s.tunnel.enabled) {
    row.push(h('div', { class: 'addr dim' }, T('Публичный адрес выключен.', 'The public address is off.')));
    row.push(h('button', { class: 'btn flame', on: { click: click(async () => { await api('PATCH', `/api/servers/${s.id}`, { tunnel: { enabled: true } }); }) } }, T('Получить адрес', 'Get an address')));
  } else {
    row.push(h('div', { class: 'addr dim' }, h('span', { class: 'spinner' }), ' ', r.status === 'online' ? T('Запрашиваю адрес…', 'Requesting an address…') : T('Подключаюсь к релею…', 'Connecting to the relay…')));
    if (t && t.error) row.push(h('div', { class: 'err' }, t.error));
    else if (r.error) row.push(h('div', { class: 'err' }, r.error));
  }
  const pubRow = s.publicIp && s.publicIp.enabled && lanPort ? h('div', { class: 'invite lan' },
    h('div', { class: 'lbl' }, T('Из интернета', 'From the internet')),
    h('div', { class: 'addr' }, `${s.publicIp.ext}:${lanPort}`),
    h('button', { class: 'btn', on: { click: (e) => copy(`${s.publicIp.ext}:${lanPort}`, e.currentTarget) } }, T('Скопировать', 'Copy')),
    s.publicIp.error ? h('div', { class: 'err' }, s.publicIp.error) : null) : null;
  const lanRow = lan && lanPort ? h('div', { class: 'invite lan' },
    h('div', { class: 'lbl' }, T('В вашей сети', 'On your network')),
    h('div', { class: 'addr' }, `${s.netName || lan.fqdn}:${lanPort}`),
    h('button', { class: 'btn', title: T('Скопировать имя', 'Copy the name'), on: { click: (e) => copy(`${s.netName || lan.fqdn}:${lanPort}`, e.currentTarget) } }, T('Скопировать', 'Copy')),
    h('button', { class: 'btn ghost', title: `${lan.ip}:${lanPort}`, on: { click: (e) => copy(`${lan.ip}:${lanPort}`, e.currentTarget) } }, 'IP:порт'),
    h('button', { class: 'btn ghost', on: { click: () => go('network') } }, T('Доступ', 'Access'))) : null;
  const more = extra.length ? h('div', { class: 'invite-more' }, extra.map((x) => addrRow(x, false))) : null;
  fill(ui.invite, h('div', { class: 'invite' + (fresh ? ' fresh' : '') }, row), lanRow, pubRow, more, howto ? h('p', { class: 'howto' }, howto) : null);
}

export function tabList(s) {
  const tabs = [['console', T('Консоль', 'Console'), 'terminal']];
  if (isMc(s)) tabs.push(['players', T('Игроки', 'Players'), 'users']);
  if (s.plugins) tabs.push(['plugins', s.plugins === 'mods' ? T('Моды', 'Mods') : T('Плагины', 'Plugins'), 'puzzle']);
  if (isMc(s)) tabs.push(['world', T('Мир', 'World'), 'world']);
  if (!['custom', 'steam-custom'].includes(s.game) && !s.plugins) tabs.push(['catalogs', T('Каталоги', 'Catalogs'), 'globe']);
  tabs.push(['launch', T('Запуск', 'Launch'), 'rocket'], ['settings', T('Настройки', 'Settings'), 'sliders'], ['files', T('Файлы', 'Files'), 'file'], ['schedule', T('Расписание и бэкапы', 'Schedule & backups'), 'calendar']);
  return tabs;
}

function renderTabs() {
  const s = cur();
  const tabs = tabList(s);
  if (!tabs.some(([id]) => id === S.tab)) S.tab = 'console';
  ui.tabs.replaceChildren(h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, name, ico]) => h('button', { class: 'tab' + (S.tab === id ? ' on' : ''), role: 'tab', 'aria-selected': String(S.tab === id), 'data-tab': id, on: { click: () => { S.tab = id; renderTabs(); renderTab(true); } } }, icon(ico, 15), name))));
}

export function renderTab(anim) {
  ui.log = null;
  ui.restartNotice = null;
  ui.cmdInput = null;
  ui.onState = null;
  const t = S.tab;
  if (t === 'console') consoleTab();
  else if (t === 'players') playersTab();
  else if (t === 'plugins') pluginsTab();
  else if (t === 'world') worldTab();
  else if (t === 'catalogs') fill(ui.body, catalogsTab(cur()));
  else if (t === 'launch') launchTab();
  else if (t === 'settings') settingsTab();
  else if (t === 'files') filesTab();
  else scheduleTab();
  if (anim) {
    ui.body.classList.remove('enter');
    void ui.body.offsetWidth;
    ui.body.classList.add('enter');
  }
}
