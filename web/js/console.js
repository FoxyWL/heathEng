'use strict';
// @imports:start
import { T, api, askInput, click, clock, copy, guard, h, lab, lang, saveBlob } from './lib.js';
import { MC_ARG, MC_ITEMS, MC_SELECTORS } from './mc-data.js';
import { S, cur, gameOf, ui } from './state.js';
// @imports:end

// Подсказки команд: команды игры из каталога и для Minecraft — аргументы и предметы на русском
function suggestions(text, g) {
  const t = text.replace(/^\//, '');
  if (!t.trim()) return [];
  const low = t.toLowerCase();
  const out = [];
  const parts = low.split(/\s+/);
  const mc = g && g.id.startsWith('minecraft');
  if (mc) {
    const head2 = parts.slice(0, 2).join(' ');
    const sub = MC_ARG[head2] ? head2 : MC_ARG[parts[0]] ? parts[0] : '';
    if ((parts[0] === 'give' || parts[0] === 'clear') && parts.length >= 3) {
      const w = parts[parts.length - 1];
      for (const [id, ru] of MC_ITEMS) if (!w || id.includes(w) || ru.toLowerCase().includes(w)) out.push({ label: id, sub: ru, insert: parts.slice(0, -1).join(' ') + ' ' + id + ' ' });
    } else if (sub && parts.length > sub.split(' ').length) {
      const w = parts[parts.length - 1];
      const base = parts.slice(0, -1).join(' ');
      for (const a of MC_ARG[sub]) if (a.toLowerCase().startsWith(w) && a.toLowerCase() !== w) out.push({ label: a, insert: base + ' ' + a });
    } else if (parts.length === 2 && ['give', 'kick', 'ban', 'op', 'deop', 'tp', 'kill', 'gamemode', 'effect', 'clear', 'msg', 'xp'].includes(parts[0])) {
      for (const sel of MC_SELECTORS) if (sel.startsWith(parts[1]) && sel !== parts[1]) out.push({ label: sel, insert: parts[0] + ' ' + sel + ' ' });
    }
  }
  if (!out.length && parts.length === 1) {
    for (const c of (g && g.commands) || []) {
      const name = typeof c === 'string' ? c : c.cmd || c.name;
      const info = typeof c === 'string' ? '' : lab(c.desc || c.help || '');
      if (name && name.toLowerCase().startsWith(low) && name.toLowerCase() !== low) out.push({ label: name, sub: info, insert: name + ' ' });
    }
  }
  return out.slice(0, 8);
}

const consState = { q: '', onlyErr: false, auto: true, hist: [], hi: -1 };

function lineClass(l) {
  if (l.k === 'in') return 'in';
  if (l.k === 'sys') return 'sys';
  if (/^\s+at\s|^\s*\.\.\. \d+ more/.test(l.text)) return 'stack';
  if (l.k === 'err' || /\b(ERROR|SEVERE|FATAL)\b|Exception|Caused by:|Traceback|Segmentation fault|OutOfMemory/.test(l.text)) return 'err';
  if (/\bWARN(ING)?\b/.test(l.text)) return 'warn';
  return '';
}
const isProblem = (l) => ['err', 'warn'].includes(lineClass(l));
const passes = (l) => (!consState.q || l.text.toLowerCase().includes(consState.q.toLowerCase())) && (!consState.onlyErr || isProblem(l));

function markHtml(text, q) {
  if (!q) return Hl.esc(text);
  const lo = text.toLowerCase();
  const ql = q.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const j = lo.indexOf(ql, i);
    if (j < 0) break;
    out += Hl.esc(text.slice(i, j)) + '<mark>' + Hl.esc(text.slice(j, j + q.length)) + '</mark>';
    i = j + q.length;
  }
  return out + Hl.esc(text.slice(i));
}

function lineEl(l, live) {
  const c = lineClass(l);
  const sp = h('span');
  sp.innerHTML = markHtml(l.text, consState.q);
  return h('div', { class: 'ln ' + c + (live && c === 'err' ? ' live' : '') }, h('time', {}, clock(l.ts)), sp);
}

export function appendLine(l) {
  if (!passes(l)) return;
  const el = ui.log;
  const stick = consState.auto;
  el.append(lineEl(l, true));
  while (el.childElementCount > 2500) el.firstElementChild.remove();
  if (stick) el.scrollTop = el.scrollHeight;
}

export function redrawLog() {
  const c = S.cons[S.sel];
  if (!ui.log || !c) return;
  if (!c.lines.length) {
    ui.log.replaceChildren(h('div', { class: 'ln sys' }, h('time', {}, ''), h('span', {}, T('Журнал пуст. Здесь появится вывод сервера.', 'The log is empty. Server output will appear here.'))));
    return;
  }
  ui.log.replaceChildren(...c.lines.filter(passes).slice(-1500).map((l) => lineEl(l, false)));
  ui.log.scrollTop = ui.log.scrollHeight;
}

export function updateCmdState() {
  const s = cur();
  if (!ui.cmdInput || !s) return;
  const live = ['running', 'starting'].includes(s.state);
  ui.cmdInput.disabled = !live;
  ui.cmdBtn.disabled = !live;
  ui.cmdInput.placeholder = live ? T('Команда серверу, Enter — отправить', 'Command to the server, Enter to send') : T('Сервер не запущен', 'Server is not running');
  for (const b of ui.chipBtns || []) b.disabled = !live;
}

const sendCmd = guard(async (text) => {
  await api('POST', `/api/servers/${S.sel}/command`, { text });
});

export async function consoleTab() {
  const id = S.sel;
  const s = cur();
  ui.log = h('div', { class: 'log', tabindex: 0, 'aria-label': T('Журнал сервера', 'Server log') });
  ui.log.addEventListener('scroll', () => {
    consState.auto = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 40;
  });
  const search = h('input', { type: 'search', placeholder: T('Поиск по журналу', 'Search the log'), value: consState.q, 'aria-label': T('Поиск', 'Search') });
  search.addEventListener('input', () => {
    consState.q = search.value;
    redrawLog();
  });
  const onlyErr = h('input', { type: 'checkbox', checked: consState.onlyErr });
  onlyErr.addEventListener('change', () => {
    consState.onlyErr = onlyErr.checked;
    redrawLog();
  });
  const aiOut = h('div');
  const bar = h('div', { class: 'console-bar' },
    search,
    h('label', { title: T('Показать только ошибки и предупреждения', 'Show errors and warnings only') }, onlyErr, T('только проблемы', 'problems only')),
    S.sys.ai.enabled ? h('button', { class: 'btn sm', title: T('Отправить ошибки из журнала ИИ-помощнику', 'Send errors from the log to the AI assistant'), on: { click: click(async () => {
      const lines = S.cons[id].lines;
      const pick = (lines.filter(isProblem).length ? lines.filter((l) => isProblem(l) || /^\s+at\s/.test(l.text)) : lines).slice(-80).map((l) => l.text).join('\n');
      aiOut.replaceChildren(h('div', { class: 'ai-box' }, h('span', { class: 'spinner' }), ' ', T('Думаю…', 'Thinking…')));
      try {
        const r = await api('POST', '/api/ai/explain', { text: pick, lang });
        aiOut.replaceChildren(h('div', { class: 'ai-box enter' }, r.answer, h('small', {}, T('Ответ сгенерирован ИИ и может быть неточным — проверьте перед применением на рабочем сервере.', 'Generated by AI and may be inaccurate — verify before applying on a live server.'))));
      } catch (e) {
        aiOut.replaceChildren(h('div', { class: 'ai-box' }, e.message));
      }
    }) } }, T('Объяснить ошибки (ИИ)', 'Explain errors (AI)')) : null,
    h('button', { class: 'btn sm', title: T('Скопировать видимые строки', 'Copy visible lines'), on: { click: (e) => copy(S.cons[id].lines.filter(passes).map((l) => `[${clock(l.ts)}] ${l.text}`).join('\n'), e.currentTarget) } }, T('Копировать', 'Copy')),
    h('button', { class: 'btn sm', title: T('Сохранить журнал в файл', 'Save the log to a file'), on: { click: () => saveBlob(new Blob([S.cons[id].lines.map((l) => `[${clock(l.ts)}] ${l.text}`).join('\n')], { type: 'text/plain' }), `${s.name.replace(/[^\w.-]+/g, '_')}-log.txt`) } }, T('Сохранить', 'Save')),
    h('button', { class: 'btn sm', title: T('Очистить журнал', 'Clear the log'), on: { click: click(async () => { await api('DELETE', `/api/servers/${id}/logs`); }) } }, T('Очистить', 'Clear')),
  );

  ui.chipBtns = [];
  let chips = null;
  if (s.game.startsWith('minecraft')) {
    const ask = (title, label, build) => async () => {
      const v = await askInput({ title, label, ok: T('Отправить', 'Send') });
      if (v) sendCmd(build(v));
    };
    const items = [
      [T('Игроки онлайн', 'Players online'), () => sendCmd('list'), T('Команда list', 'list command')],
      [T('Сохранить мир', 'Save world'), () => sendCmd('save-all'), T('Команда save-all', 'save-all command')],
      [T('Сообщение всем…', 'Broadcast…'), ask(T('Сообщение всем игрокам', 'Message to all players'), T('Текст', 'Text'), (v) => 'say ' + v)],
      [T('В белый список…', 'Whitelist add…'), ask(T('Добавить в белый список', 'Add to whitelist'), T('Ник игрока', 'Player name'), (v) => 'whitelist add ' + v)],
      [T('Сделать оператором…', 'Make operator…'), ask(T('Выдать права оператора', 'Grant operator rights'), T('Ник игрока', 'Player name'), (v) => 'op ' + v)],
      [T('Выгнать игрока…', 'Kick player…'), ask(T('Выгнать игрока', 'Kick a player'), T('Ник игрока', 'Player name'), (v) => 'kick ' + v)],
    ];
    chips = h('div', { class: 'chips', 'aria-label': T('Быстрые команды', 'Quick commands') }, items.map(([label, fn, tip]) => {
      const b = h('button', { class: 'chip', title: tip || label, on: { click: fn } }, label);
      ui.chipBtns.push(b);
      return b;
    }));
  }

  ui.cmdInput = h('input', { type: 'text', spellcheck: false, autocomplete: 'off', 'aria-label': T('Команда', 'Command') });
  const sugg = h('ul', { class: 'sugg hidden', role: 'listbox' });
  let sugItems = [];
  let sugHi = 0;
  const hideSug = () => {
    sugItems = [];
    sugg.classList.add('hidden');
  };
  const showSug = () => {
    sugItems = suggestions(ui.cmdInput.value, gameOf(s.game));
    sugHi = 0;
    if (!sugItems.length) return hideSug();
    sugg.replaceChildren(...sugItems.map((x, i) => h('li', { class: 'sug' + (i === 0 ? ' on' : ''), role: 'option', on: { mousedown: (e) => { e.preventDefault(); applySug(i); } } }, h('b', {}, x.label), x.sub ? h('small', {}, x.sub) : null)));
    sugg.classList.remove('hidden');
  };
  const applySug = (i) => {
    const x = sugItems[i];
    if (!x) return;
    ui.cmdInput.value = x.insert;
    hideSug();
    ui.cmdInput.focus();
  };
  ui.cmdBtn = h('button', { class: 'btn primary' }, T('Отправить', 'Send'));
  const send = guard(async () => {
    const text = ui.cmdInput.value.trim();
    if (!text) return;
    ui.cmdInput.value = '';
    consState.hist.push(text);
    consState.hi = consState.hist.length;
    await api('POST', `/api/servers/${id}/command`, { text });
  });
  ui.cmdBtn.addEventListener('click', send);
  ui.cmdInput.addEventListener('input', showSug);
  ui.cmdInput.addEventListener('blur', () => setTimeout(hideSug, 120));
  ui.cmdInput.addEventListener('keydown', (e) => {
    if (sugItems.length && ['ArrowDown', 'ArrowUp', 'Tab', 'Escape'].includes(e.key)) {
      e.preventDefault();
      if (e.key === 'Tab') return applySug(sugHi);
      if (e.key === 'Escape') return hideSug();
      sugHi = (sugHi + (e.key === 'ArrowDown' ? 1 : -1) + sugItems.length) % sugItems.length;
      [...sugg.children].forEach((el, i) => el.classList.toggle('on', i === sugHi));
      return;
    }
    if (e.key === 'Enter') {
      if (sugItems.length && ui.cmdInput.value.trim() !== sugItems[sugHi].insert.trim() && !sugItems[sugHi].exact) return applySug(sugHi);
      hideSug();
      send();
    } else if (e.key === 'ArrowUp' && consState.hist.length) {
      consState.hi = Math.max(0, consState.hi - 1);
      ui.cmdInput.value = consState.hist[consState.hi] || '';
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      consState.hi = Math.min(consState.hist.length, consState.hi + 1);
      ui.cmdInput.value = consState.hist[consState.hi] || '';
      e.preventDefault();
    }
  });
  ui.body.replaceChildren(h('div', { class: 'console-wrap' }, bar, ui.log, chips, h('div', { class: 'cmd' }, ui.cmdInput, ui.cmdBtn, sugg)), aiOut);
  updateCmdState();
  if (!S.cons[id]) S.cons[id] = { lines: [] };
  try {
    S.cons[id].lines = await api('GET', `/api/servers/${id}/logs?limit=1500`);
  } catch {}
  if (S.sel === id && S.tab === 'console' && ui.log) {
    consState.auto = true;
    redrawLog();
  }
}
