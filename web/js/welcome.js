'use strict';
// @imports:start
import { openGuide } from './guide.js';
import { icon } from './icons.js';
import { T, h } from './lib.js';
import { newServerModal } from './newserver.js';
import { ui } from './state.js';
// @imports:end

export function welcome() {
  ui.main.replaceChildren(
    h('div', { class: 'page welcome' },
      h('h1', {}, T('Сервер за пять минут', 'A server in five minutes')),
      h('p', { class: 'lead' }, T('Выберите игру и версию — Hearth скачает сборку, подготовит всё нужное и выдаст публичный адрес, по которому друзья смогут зайти без проброса портов.', 'Pick a game and a version — Hearth downloads the build, sets up what it needs and gives you a public address your friends can join without port forwarding.')),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn primary lg', on: { click: () => newServerModal() } }, icon('plus', 18), T('Создать сервер', 'Create a server')),
        h('button', { class: 'btn lg', on: { click: () => newServerModal({ pick: 'custom' }) } }, icon('rocket', 18), T('Свой сервер для любой игры', 'Your own server for any game')),
        h('button', { class: 'btn lg', 'data-act': 'guide', on: { click: () => openGuide() } }, icon('book', 18), T('Гайд за минуту', 'One-minute guide'))),
      h('div', { class: 'steps' },
        h('div', { class: 'step' }, h('div', { class: 'n' }, '1'), h('b', {}, T('Создайте сервер', 'Create a server')), h('span', {}, T('Выберите игру из каталога, укажите AppID Steam или любую команду запуска. Или подключите папку готового сервера.', 'Pick a game from the catalog, enter a Steam AppID or any start command. Or attach the folder of an existing server.'))),
        h('div', { class: 'step' }, h('div', { class: 'n' }, '2'), h('b', {}, T('Отдайте мощности', 'Give it power')), h('span', {}, T('В разделе «Мощности» выберите 25%, 50% или 100% ПК, либо задайте ядра, память и диск вручную.', 'In “PC power” pick 25%, 50% or 100% of the PC, or set cores, memory and disk by hand.'))),
        h('div', { class: 'step' }, h('div', { class: 'n' }, '3'), h('b', {}, T('Подключите туннель и позовите друзей', 'Connect the tunnel and invite friends')), h('span', {}, T('Укажите адрес релея один раз: у сервера появится публичный адрес, его достаточно отправить другу.', 'Enter the relay address once: the server gets a public address you just send to a friend.')))),
      h('p', { class: 'howto' }, T('Туннель можно использовать не только для игр: вебхуки, сайт с localhost, проверка на телефоне — раздел «Туннели».', 'The tunnel is not only for games: webhooks, a localhost site, testing on a phone — see “Tunnels”.'))),
  );
}
