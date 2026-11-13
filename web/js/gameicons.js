'use strict';
// @imports:start
import { token } from './lib.js';
import { gameOf } from './state.js';
// @imports:end
// Значки игр: собственные пиктограммы (не логотипы игр) на цветной плитке в цвет игры.

const G = {
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  crosshair: '<circle cx="12" cy="12" r="7"/><path d="M12 2v6M12 16v6M2 12h6M16 12h6"/><circle cx="12" cy="12" r="1" class="f"/>',
  sprout: '<path d="M12 21v-9"/><path d="M12 12c0-4 2.5-6.5 7-6.5 0 4-2.5 6.5-7 6.5zM12 15c0-3-2-5-6-5 0 3 2 5 6 5z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  wrench: '<path d="M14.5 5.5a4 4 0 0 0 4.6 5.4L9 21l-3-3L16.1 7.9a4 4 0 0 0-1.6-2.4z"/>',
  skull: '<path d="M5 11a7 7 0 0 1 14 0c0 2.2-1 3.4-2.5 4.3V18H7.5v-2.7C6 14.4 5 13.2 5 11z"/><circle cx="9.5" cy="11.5" r="1.3" class="f"/><circle cx="14.5" cy="11.5" r="1.3" class="f"/><path d="M10.5 18v2M13.5 18v2"/>',
  paw: '<ellipse cx="12" cy="16" rx="4" ry="3.2"/><circle cx="6.5" cy="11" r="1.8"/><circle cx="10" cy="7.5" r="1.8"/><circle cx="14" cy="7.5" r="1.8"/><circle cx="17.5" cy="11" r="1.8"/>',
  leaf: '<path d="M5 19C5 10 10 5 20 4c0 10-5 15-14 15z"/><path d="M5 19l8-8"/>',
  horn: '<path d="M4 6c0 7 3 11 8 12 5-1 8-5 8-12-2 3-5 4-8 4S6 9 4 6z"/><path d="M12 18v3"/>',
  house: '<path d="M4 11l8-7 8 7v9H4z"/><path d="M10 20v-5h4v5"/>',
  drop: '<path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z"/>',
  factory: '<path d="M3 20V10l6 3V10l6 3V6h4l2 .5V20z"/><path d="M7 20v-3M12 20v-3M17 20v-3"/>',
  person: '<circle cx="12" cy="7.5" r="3.2"/><path d="M5.5 20c.5-4.5 3-7 6.5-7s6 2.5 6.5 7"/>',
  sword: '<path d="M14 4h6v6L10 20l-2.5-2.5zM7.5 17.5L4 14M6 19.5l-2 .5.5-2"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 10l3 2.5L7 15M12.5 15.5H17"/>',
  server: '<rect x="3.5" y="4" width="17" height="6.5" rx="2"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="2"/><path d="M7 7.3v.01M7 16.8v.01M11 7.3h6M11 16.8h6"/>',
  helmet: '<path d="M4.5 14a7.5 7.5 0 0 1 15 0v1H4.5z"/><path d="M4 18h16M12 6.5V3"/>',
  bolt: '<path d="M13 3L5 13.5h6L10 21l9-11h-6z"/>',
  medkit: '<rect x="3.5" y="7" width="17" height="12" rx="2.5"/><path d="M9 7V5h6v2M12 10.5v5M9.5 13h5"/>',
  axe: '<path d="M5 20L15 10M13 4c4 0 7 3 7 7-3 0-5-1-7-3z"/>',
};

// игра → значок и второстепенный знак в углу (отличает варианты одной игры)
const MOTIF = {
  'minecraft-vanilla': ['cube'],
  'minecraft-paper': ['cube', 'dot'],
  'minecraft-folia': ['cube', 'leaf'],
  'minecraft-purpur': ['cube', 'gem'],
  'minecraft-fabric': ['cube', 'stitch'],
  terraria: ['sprout'],
  cs16: ['crosshair'],
  czero: ['crosshair', 'dot'],
  cs2: ['crosshair', 'two'],
  dod: ['helmet'],
  svencoop: ['bolt'],
  tf2: ['wrench'],
  gmod: ['gear'],
  l4d2: ['medkit'],
  rust: ['axe'],
  ark: ['leaf'],
  palworld: ['paw'],
  valheim: ['horn'],
  '7dtd': ['skull'],
  zomboid: ['house'],
  vrising: ['drop'],
  satisfactory: ['factory'],
  unturned: ['person'],
  conan: ['sword'],
  custom: ['terminal'],
  'steam-custom': ['server'],
};

const ACCENT = {
  dot: '<circle cx="19" cy="5" r="2.2" class="f"/>',
  gem: '<path d="M16.5 4h5l-2.5 3.2z" class="f"/>',
  stitch: '<path d="M16.5 5h5" stroke-dasharray="1.6 1.6"/>',
  leaf: '<path d="M17 6.5c0-2 1.2-3 3-3 0 2-1.2 3-3 3z" class="f"/>',
  two: '<path d="M16.5 4.5h5M16.5 7.5h5" />',
};

function glyph(id, size = 18) {
  const [g, acc] = MOTIF[id] || ['server'];
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${G[g]}${acc ? ACCENT[acc] || '' : ''}</svg>`;
}

/** Плитка с значком игры. size: 'sm' (панель), 'md' (шапка), 'lg' (карточки и каталог). */
const shown = new Set(); // адреса значков, которые уже загрузились (без мигания при перерисовке)
const absent = new Set(); // у этих игр настоящего значка нет: не спрашиваем снова до перезагрузки страницы

/** serverId и rev нужны серверам: у сервера может быть свой значок, rev меняется при замене. */
export function gameBadge(id, size = 'md', serverId = '', rev = 0) {
  const g = gameOf(id) || {};
  const px = size === 'lg' ? 26 : size === 'sm' ? 15 : 20;
  const el = document.createElement('span');
  el.className = 'gbadge ' + size;
  el.style.setProperty('--c', g.color || '#64748b');
  el.dataset.game = id;
  el.innerHTML = glyph(id, px);
  const src = (serverId ? '/api/servers/' + serverId + '/icon?v=' + rev + '&' : '/api/games/' + id + '/icon?') + 'token=' + encodeURIComponent(token);
  if (!absent.has(src)) {
    const img = new Image();
    img.alt = '';
    img.className = 'gimg';
    img.decoding = 'async';
    const put = () => {
      shown.add(src);
      el.classList.add('has-img');
      el.replaceChildren(img);
    };
    img.onload = put;
    img.onerror = () => absent.add(src);
    img.src = src;
    if (shown.has(src) && img.complete && img.naturalWidth) put();
  }
  return el;
}
