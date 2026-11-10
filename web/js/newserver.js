'use strict';
// @imports:start
import { gameBadge } from './gameicons.js';
import { icon } from './icons.js';
import { T, api, closeBack, h, lab, openBack } from './lib.js';
import { fieldInput } from './settings-tab.js';
import { render } from './shell.js';
import { S, gameOf, upsert } from './state.js';
// @imports:end
// Каталог игр и создание сервера: поиск, фильтры, версия, импорт папки, свой сервер по команде или AppID.

const TAGS = () => ({ all: T('Все', 'All'), shooter: T('Шутеры', 'Shooters'), survival: T('Выживание', 'Survival'), sandbox: T('Песочницы', 'Sandbox'), coop: T('Кооператив', 'Co-op'), custom: T('Свой сервер', 'Custom') });
const CONFIG_GAMES = ['custom', 'steam-custom'];

export function newServerModal(opts = {}) {
  const back = h('div', { class: 'modal-back' });
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    closeBack(back);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', (e) => e.target === back && close());

  let game = opts.pick && gameOf(opts.pick) ? opts.pick : (S.catalog.find((g) => g.id.startsWith('minecraft')) || S.catalog[0] || {}).id || '';
  let tag = 'all';
  let query = '';
  const search = h('input', { type: 'search', placeholder: T('Найти игру', 'Find a game'), 'aria-label': T('Поиск игры', 'Search games'), spellcheck: false });
  const chipsBox = h('div', { class: 'chips' });
  const gameBox = h('div', { class: 'gamegrid', role: 'radiogroup', 'aria-label': T('Игра', 'Game') });
  const cfg = h('div', { class: 'cfg' });
  const err = h('div', { class: 'notice bad hidden', role: 'alert' });

  const version = h('select', { 'aria-label': T('Версия', 'Version') });
  const verField = h('div', { class: 'field' }, h('label', {}, T('Версия', 'Version'), version));
  const name = h('input', { type: 'text', placeholder: T('Мой сервер', 'My server') });
  const imp = h('input', { type: 'checkbox' });
  const dir = h('input', { type: 'text', class: 'mono', placeholder: 'C:\\Games\\server  |  /home/me/server', spellcheck: false });
  const dirLabel = h('label', {}, '', dir);
  const dirField = h('div', { class: 'field hidden' }, dirLabel, h('small', {}, T('Папка останется на месте, ничего не копируется.', 'The folder stays where it is; nothing is copied.')));
  const impRow = h('label', { class: 'check' }, imp, h('span', {}, T('У меня уже есть такой сервер — подключить папку', 'I already have this server — attach its folder')));
  const eula = h('input', { type: 'checkbox' });
  const eulaField = h('label', { class: 'check hidden' }, eula, h('span', {}, T('Принимаю EULA Minecraft (aka.ms/MinecraftEULA)', 'I accept the Minecraft EULA (aka.ms/MinecraftEULA)')));
  const note = h('small', { class: 'muted' });
  const custom = h('div', { class: 'form' });
  let customInputs = [];

  const g0 = () => gameOf(game) || {};
  const loadVersions = async () => {
    version.replaceChildren(h('option', {}, T('Загрузка…', 'Loading…')));
    try {
      const v = await api('GET', `/api/catalog/${game}/versions`);
      verField.classList.toggle('hidden', v.versions.length < 2 && ['latest', 'custom'].includes(v.latest));
      version.replaceChildren(...v.versions.slice(0, 80).map((x) => h('option', { value: x }, x + (x === v.latest && v.versions.length > 1 ? T(' (последняя)', ' (latest)') : ''))));
      version.value = v.latest;
    } catch (e) {
      version.replaceChildren(h('option', { value: '' }, T('не удалось загрузить список: ', 'could not load list: ') + e.message));
    }
  };
  const sync = () => {
    const g = g0();
    const cfgGame = CONFIG_GAMES.includes(game);
    const mc = game.startsWith('minecraft');
    custom.replaceChildren();
    customInputs = [];
    if (cfgGame) {
      for (const f of g.fields || []) {
        const [i, el] = fieldInput(f, f.default);
        customInputs.push(i);
        custom.append(f.type === 'bool' ? h('div', { class: 'field wide' }, el) : el);
      }
    }
    verField.classList.toggle('hidden', cfgGame || imp.checked);
    dirField.classList.toggle('hidden', !imp.checked && !(cfgGame));
    dirLabel.firstChild.textContent = cfgGame ? T('Рабочая папка (необязательно)', 'Working folder (optional)') : T('Папка существующего сервера', 'Existing server folder');
    eulaField.classList.toggle('hidden', !mc);
    impRow.classList.toggle('hidden', cfgGame);
    custom.classList.toggle('hidden', !cfgGame);
    note.textContent = mc ? T('Java и сам сервер Hearth скачает автоматически. Нужен интернет.', 'Hearth downloads Java and the server itself. Internet is required.')
      : game === 'custom' ? T('Любая программа: укажите команду запуска и порты (через запятую, TCP и UDP).', 'Any program: give the start command and ports (comma separated, TCP and UDP).')
      : game === 'steam-custom' ? T('Любая игра из Steam с выделенным сервером: укажите её AppID, файл запуска и порты. Файлы скачает SteamCMD.', 'Any Steam game with a dedicated server: give its AppID, executable and ports. SteamCMD downloads the files.')
      : g.steam ? T('Файлы сервера скачивает SteamCMD (анонимный вход). Это может занять время и место на диске.', 'SteamCMD downloads the server files (anonymous login). It may take time and disk space.') : '';
    if (g.ramGB) note.textContent += ' ' + T(`Рекомендуется от ${g.ramGB} ГБ ОЗУ.`, `${g.ramGB} GB RAM or more recommended.`);
  };
  const drawGames = () => {
    const q = query.trim().toLowerCase();
    const list = S.catalog.filter((g) => (tag === 'all' || g.tags.includes(tag)) && (!q || lab(g.name).toLowerCase().includes(q) || g.id.includes(q)));
    gameBox.replaceChildren(...(list.length ? list.map((g) => {
      const on = g.id === game;
      const b = h('button', { type: 'button', class: 'gcard' + (on ? ' on' : ''), role: 'radio', 'aria-checked': String(on), 'data-game': g.id, title: lab(g.name), on: { click: () => {
        game = g.id;
        drawGames();
        sync();
        if (!CONFIG_GAMES.includes(game)) loadVersions();
        cfg.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } } },
        gameBadge(g.id, 'lg'),
        h('span', { class: 'gname' }, lab(g.name).replace(/^Minecraft: Java Edition /, 'MC ')));
      return b;
    }) : [h('p', { class: 'muted' }, T('Ничего не найдено. Для любой игры есть «Свой сервер».', 'Nothing found. “Your own server” works for any game.'))]));
  };
  const drawChips = () => chipsBox.replaceChildren(...Object.entries(TAGS()).filter(([k]) => k === 'all' || S.catalog.some((g) => g.tags.includes(k))).map(([k, label]) => h('button', { type: 'button', class: 'chip' + (tag === k ? ' on' : ''), on: { click: () => { tag = k; drawChips(); drawGames(); } } }, label)));
  search.addEventListener('input', () => {
    query = search.value;
    drawGames();
  });
  imp.addEventListener('change', sync);

  const create = h('button', { class: 'btn primary' }, T('Создать', 'Create'));
  create.addEventListener('click', async () => {
    err.classList.add('hidden');
    const body = { game, name: name.value, settings: {} };
    const cfgGame = CONFIG_GAMES.includes(game);
    if (!cfgGame && !imp.checked) body.version = version.value;
    if (imp.checked || (cfgGame && dir.value.trim())) body.importDir = dir.value.trim();
    if (cfgGame) {
      for (const i of customInputs) body.settings[i.dataset.key] = i.dataset.type === 'bool' ? i.checked : i.dataset.type === 'number' ? +i.value : i.value;
    }
    if (game.startsWith('minecraft')) body.settings.acceptEula = eula.checked;
    if (imp.checked && !dir.value.trim()) {
      err.textContent = T('Укажите папку сервера.', 'Specify the server folder.');
      return err.classList.remove('hidden');
    }
    create.disabled = true;
    try {
      const v = await api('POST', '/api/servers', body);
      upsert(v);
      close();
      S.view = 'server';
      S.sel = v.id;
      S.tab = 'console';
      S.anim = true;
      render();
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
      create.disabled = false;
    }
  });
  cfg.append(verField, h('div', { class: 'field' }, h('label', {}, T('Название', 'Name'), name)), impRow, dirField, custom, eulaField, note, err);
  back.append(h('div', { class: 'modal wide', role: 'dialog', 'aria-modal': 'true', 'aria-label': T('Новый сервер', 'New server') },
    h('h2', {}, T('Новый сервер', 'New server')),
    h('div', { class: 'catalog-bar' }, h('div', { class: 'searchbar' }, icon('search', 16), search), chipsBox),
    gameBox, cfg,
    h('div', { class: 'row' }, h('button', { class: 'btn', on: { click: close } }, T('Отмена', 'Cancel')), create)));
  openBack(back);
  drawChips();
  drawGames();
  sync();
  if (game && !CONFIG_GAMES.includes(game)) loadVersions();
  setTimeout(() => (opts.pick ? name : search).focus(), 60);
}
