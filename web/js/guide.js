'use strict';
// @imports:start
import { icon } from './icons.js';
import { T, closeBack, h, openBack } from './lib.js';
import { newServerModal } from './newserver.js';
import { go } from './shell.js';
import { S, fill } from './state.js';
// @imports:end
// Короткий гайд: от выбора игры до друзей на сервере. Открывается кнопкой «Гайд» и из палитры команд.

const KEY = 'hearth.guide';

const markSeen = () => {
  try {
    localStorage.setItem(KEY, 'done');
  } catch {}
};

function steps() {
  const firstSrv = S.servers[0];
  return [
    { ico: 'servers', title: T('1. Выберите игру', '1. Pick a game'), text: T('«Новый сервер» → выберите игру из каталога. Minecraft проще всего для первого раза. Любой другой сервер подключается через «Свой сервер»: нужна команда запуска или AppID Steam.', '“New server” → pick a game from the catalog. Minecraft is the easiest first try. Any other server goes through “Your own server”: you need a start command or a Steam AppID.'), act: { label: T('Создать сервер', 'Create a server'), run: () => newServerModal() } },
    { ico: 'cpu', title: T('2. Отдайте мощности', '2. Give it some power'), text: T('Раздел «Мощности»: 25% подходит, если вы играете параллельно, 50% — золотая середина, 100% — весь ПК под сервер. Значения можно править вручную. Памяти нужно примерно 2 ГБ на 5–10 игроков в Minecraft.', 'The “PC power” section: 25% suits playing alongside, 50% is the sweet spot, 100% gives the whole PC to the server. You can edit the values by hand. Minecraft needs about 2 GB per 5–10 players.'), act: { label: T('Открыть «Мощности»', 'Open “PC power”'), run: () => go('capacity') } },
    { ico: 'play', title: T('3. Запустите', '3. Start it'), text: T('Нажмите «Запустить». Первый раз дольше: Hearth скачивает сервер и Java сам. Когда статус станет «Работает», сервер готов. Что происходит, видно в консоли.', 'Press “Start”. The first time takes longer: Hearth downloads the server and Java itself. When the status says “Running”, the server is ready. The console shows what is going on.'), act: firstSrv ? { label: T('К серверу', 'To the server'), run: () => go('server', firstSrv.id) } : null },
    { ico: 'tunnel', title: T('4. Позовите друзей', '4. Invite friends'), text: T('В разделе «Туннели» один раз укажите адрес релея: у сервера появится публичный адрес, который достаточно отправить другу. Для игры по одной сети хватит локального адреса.', 'In “Tunnels” enter the relay address once: the server gets a public address you just send to a friend. For the same network the local address is enough.'), act: { label: T('Открыть «Туннели»', 'Open “Tunnels”'), run: () => go('tunnels') } },
    { ico: 'puzzle', title: T('5. Добавьте моды', '5. Add mods'), text: T('Minecraft: во вкладке «Плагины» или «Моды» идёт поиск по Modrinth прямо в Hearth, установка в один клик. Для остальных игр во вкладке «Каталоги» собраны популярные площадки: Steam Workshop, Nexus Mods, Thunderstore, uMod и другие.', 'Minecraft: the “Plugins” or “Mods” tab searches Modrinth inside Hearth with one-click install. For other games the “Catalogs” tab lists popular platforms: Steam Workshop, Nexus Mods, Thunderstore, uMod and more.'), act: null },
    { ico: 'calendar', title: T('6. Берегите мир', '6. Protect the world'), text: T('Вкладка «Расписание и бэкапы»: ежедневная копия мира с ротацией. Автоперезапуск после падения включён сам.', 'The “Schedule & backups” tab: a daily world copy with rotation. Auto-restart after a crash is on by default.'), act: null },
  ];
}

export function openGuide(start = 0) {
  const ex = document.getElementById('guide');
  if (ex && !ex._closing) return;
  if (ex) ex.remove();
  const list = steps();
  let i = Math.max(0, Math.min(list.length - 1, start));
  const back = h('div', { class: 'modal-back', id: 'guide' });
  const body = h('div', { class: 'guide-body' });
  const dots = h('div', { class: 'guide-dots', role: 'tablist' });
  const prev = h('button', { class: 'btn', 'data-guide': 'prev' }, T('Назад', 'Back'));
  const next = h('button', { class: 'btn primary', 'data-guide': 'next' }, '');
  let closed = false;
  const close = (run) => {
    if (closed) return;
    closed = true;
    markSeen();
    document.removeEventListener('keydown', onKey, true);
    closeBack(back);
    if (run) setTimeout(run, 120);
  };
  const draw = () => {
    const s = list[i];
    fill(body,
      h('div', { class: 'guide-ico' }, icon(s.ico, 26)),
      h('h2', {}, s.title),
      h('p', {}, s.text),
      s.act ? h('button', { class: 'btn guide-act', on: { click: () => close(s.act.run) } }, s.act.label) : null);
    dots.replaceChildren(...list.map((_, k) => h('button', { class: 'dot' + (k === i ? ' on' : ''), role: 'tab', 'aria-label': T('Шаг ', 'Step ') + (k + 1), 'aria-selected': String(k === i), on: { click: () => { i = k; draw(); } } })));
    prev.disabled = i === 0;
    next.textContent = i === list.length - 1 ? T('Готово', 'Done') : T('Дальше', 'Next');
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowRight' && i < list.length - 1) {
      i++;
      draw();
    } else if (e.key === 'ArrowLeft' && i > 0) {
      i--;
      draw();
    }
  };
  prev.addEventListener('click', () => {
    if (i > 0) {
      i--;
      draw();
    }
  });
  next.addEventListener('click', () => {
    if (i < list.length - 1) {
      i++;
      draw();
    } else close();
  });
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', (e) => e.target === back && close());
  back.append(h('div', { class: 'modal guide', role: 'dialog', 'aria-modal': 'true', 'aria-label': T('Гайд по настройке сервера', 'Server setup guide') },
    h('div', { class: 'guide-top' }, h('span', { class: 'muted' }, T('Гайд за минуту', 'One-minute guide')), h('button', { class: 'btn quiet sm', 'aria-label': T('Закрыть', 'Close'), on: { click: () => close() } }, icon('x', 15))),
    body, dots, h('div', { class: 'row' }, prev, next)));
  openBack(back);
  draw();
  setTimeout(() => next.focus(), 60);
}
