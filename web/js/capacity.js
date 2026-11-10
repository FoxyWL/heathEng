'use strict';
// @imports:start
import { ring } from './charts.js';
import { openGuide } from './guide.js';
import { icon } from './icons.js';
import { T, api, click, fmtMem, h, toast } from './lib.js';
import { go } from './shell.js';
import { S, fill, gameOf, ui } from './state.js';
// @imports:end
// Мощности ПК: сколько ядер, памяти и места на диске отдать серверам. Пресеты 25/50/100% и ручная настройка.

const PRESETS = [25, 50, 100];
const STEP_MB = 256;

export function presetBudget(pc, pct) {
  const ram = Math.min(pc.totalMb, Math.max(512, Math.round((pc.totalMb * pct) / 100 / STEP_MB) * STEP_MB));
  return {
    enabled: true,
    cpuCores: Math.max(1, Math.round((pc.cores * pct) / 100)),
    ramMb: ram,
    diskGb: pc.diskFreeGb ? Math.max(1, Math.floor((pc.diskFreeGb * pct) / 100)) : 0,
  };
}

const pctText = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');

export async function capacityPage() {
  const page = h('div', { class: 'page cap' });
  ui.main.replaceChildren(page);
  ui.onState = null;
  let data = null;

  const alive = () => page.isConnected && S.view === 'capacity';
  const load = async () => {
    const d = await api('GET', '/api/capacity');
    if (alive()) data = d;
  };
  const save = async (body) => {
    try {
      const d = await api('PUT', '/api/capacity', body);
      if (!alive()) return;
      data = d;
      draw();
    } catch (e) {
      toast(e.message, true);
      await load().catch(() => {});
      if (alive()) draw();
    }
  };

  const live = {};
  const paintLive = () => {
    if (!data || !live.cpu) return;
    const b = data.budget;
    const running = S.servers.filter((s) => ['running', 'starting'].includes(s.state));
    const usedMb = running.reduce((a, s) => a + (s.mem || 0), 0);
    const cpuAll = running.reduce((a, s) => a + (s.cpu || 0), 0);
    const N = b.enabled && b.cpuCores ? b.cpuCores : data.pc.cores;
    const cpuBudget = Math.min(100, cpuAll * (data.pc.cores / N));
    const ramBase = b.enabled && b.ramMb ? b.ramMb : data.pc.totalMb;
    live.cpu.ring.update(cpuBudget / 100);
    live.cpu.text.textContent = `${N} ${T('яд. в бюджете', 'cores in budget')}`;
    live.ram.ring.update(usedMb / ramBase);
    live.ram.text.textContent = `${fmtMem(usedMb)} ${T('из', 'of')} ${fmtMem(ramBase)}`;
  };

  const numInput = (value, { min, max, step, label, onChange, cls }) => {
    const el = h('input', { type: 'number', value: String(value), min, max, step, 'aria-label': label, class: cls || '' });
    el.addEventListener('change', () => {
      const v = Math.max(min, Math.min(max, Math.round(+el.value || 0)));
      el.value = String(v);
      onChange(v);
    });
    return el;
  };

  const slider = ({ id, ico, title, hint, value, min, max, step, fmt, onChange }) => {
    const out = h('output', { class: 'sl-val', for: id }, fmt(value));
    const range = h('input', { type: 'range', id, min, max, step, value: String(value), 'aria-label': title });
    range.addEventListener('input', () => (out.textContent = fmt(+range.value)));
    range.addEventListener('change', () => onChange(+range.value));
    return h('div', { class: 'sl' }, h('label', { for: id, class: 'sl-lab' }, icon(ico, 16), h('b', {}, title), out), range, h('small', {}, hint));
  };

  function draw() {
    if (!alive() || !data) return;
    const { pc, budget: b, servers, totals, warnings } = data;
    const active = b.enabled ? PRESETS.find((p) => {
      const t = presetBudget(pc, p);
      return t.cpuCores === b.cpuCores && Math.abs(t.ramMb - b.ramMb) < STEP_MB && Math.abs(t.diskGb - b.diskGb) <= 1;
    }) : null;
    const mode = !b.enabled ? 'off' : active ? 'p' + active : 'manual';

    const presetCards = PRESETS.map((p) => {
      const t = presetBudget(pc, p);
      const name = p === 25 ? T('Фоновый', 'Background') : p === 50 ? T('Сбалансированный', 'Balanced') : T('Максимум', 'Maximum');
      const note = p === 25 ? T('ПК остаётся почти свободным: для игры или работы параллельно', 'The PC stays almost free for gaming or work alongside') : p === 50 ? T('Половина мощностей: сервер и вы комфортно уживаетесь', 'Half of the power: the server and you share comfortably') : T('Весь ПК под сервер. Остальные программы будут тормозить', 'The whole PC for the server. Other programs will slow down');
      return h('button', { class: 'preset' + (active === p ? ' on' : ''), 'data-preset': String(p), 'aria-pressed': String(active === p), on: { click: () => save({ budget: t }) } },
        h('span', { class: 'preset-pct' }, p + '%'),
        h('b', {}, name),
        h('span', { class: 'preset-nums' }, `${t.cpuCores} ${T('яд.', 'cores')} · ${fmtMem(t.ramMb)}${t.diskGb ? ' · ' + t.diskGb + T(' ГБ', ' GB') : ''}`),
        h('small', {}, note));
    });

    // ----- ручная настройка
    const maxDisk = Math.max(10, pc.diskFreeGb || 100, b.diskGb || 0);
    const manual = h('div', { class: 'cap-manual' },
      slider({ id: 'cap-cpu', ico: 'cpu', title: T('Ядра процессора', 'CPU cores'), hint: T(`Из ${pc.cores}. Серверы привязываются к последним ядрам, нулевое остаётся системе и играм.`, `Out of ${pc.cores}. Servers are pinned to the last cores; core 0 stays for the system and games.`), value: b.cpuCores || pc.cores, min: 1, max: pc.cores, step: 1, fmt: (v) => `${v} ${T('из', 'of')} ${pc.cores} (${pctText(v, pc.cores)})`, onChange: (v) => save({ budget: { enabled: true, cpuCores: v } }) }),
      slider({ id: 'cap-ram', ico: 'ram', title: T('Оперативная память', 'Memory'), hint: T(`Всего ${fmtMem(pc.totalMb)}. Серверы сверх этого бюджета не запустятся: Hearth подскажет, что остановить.`, `${fmtMem(pc.totalMb)} in total. Servers beyond this budget will not start; Hearth tells you what to stop.`), value: b.ramMb || pc.totalMb, min: 512, max: Math.max(512, Math.floor(pc.totalMb / STEP_MB) * STEP_MB), step: STEP_MB, fmt: (v) => `${fmtMem(v)} (${pctText(v, pc.totalMb)})`, onChange: (v) => save({ budget: { enabled: true, ramMb: v } }) }),
      slider({ id: 'cap-disk', ico: 'disk', title: T('Место на диске', 'Disk space'), hint: T(`Свободно ${pc.diskFreeGb} ГБ. Считаются папки серверов, созданных в Hearth, и бэкапы. Новые серверы сверх бюджета не создаются.`, `${pc.diskFreeGb} GB free. Counts server folders created in Hearth and backups. New servers beyond the budget are not created.`), value: b.diskGb || maxDisk, min: 1, max: maxDisk, step: 1, fmt: (v) => `${v} ${T('ГБ', 'GB')}`, onChange: (v) => save({ budget: { enabled: true, diskGb: v } }) }),
      h('div', { class: 'form cap-extra' },
        h('div', { class: 'field' }, h('label', {}, T('Приоритет серверов', 'Server priority'),
          (() => {
            const sel = h('select', { 'aria-label': T('Приоритет серверов', 'Server priority') }, [['low', T('Низкий: игры и браузер всегда в приоритете', 'Low: games and browser always win')], ['below', T('Ниже обычного (рекомендуется)', 'Below normal (recommended)')], ['normal', T('Обычный', 'Normal')]].map(([v, n]) => h('option', { value: v }, n)));
            sel.value = b.priority;
            sel.addEventListener('change', () => save({ budget: { priority: sel.value } }));
            return sel;
          })())),
        h('label', { class: 'check' }, (() => {
          const c = h('input', { type: 'checkbox', checked: b.hardRam, 'aria-label': T('Строго следить за памятью', 'Enforce memory strictly') });
          c.addEventListener('change', () => save({ budget: { hardRam: c.checked } }));
          return c;
        })(), h('span', {}, T('Строго следить за памятью: остановить сервер, если он сильно превысит свой лимит', 'Enforce memory strictly: stop a server that goes far over its limit')))));

    // ----- использование
    const ringCard = (key, ico, label, frac, text) => {
      const r = ring(frac, label);
      const sub = h('small', {}, text);
      live[key] = { ring: r, text: sub };
      return h('div', { class: 'ring-card', 'data-ring': key }, r, h('div', { class: 'ring-info' }, h('b', {}, icon(ico, 15), label), sub));
    };
    const diskGb = totals.diskUsedMb / 1024;
    const diskBase = b.enabled && b.diskGb ? b.diskGb : pc.diskTotalGb || 1;
    const usage = h('div', { class: 'rings' },
      ringCard('cpu', 'cpu', T('Процессор', 'CPU'), 0, ''),
      ringCard('ram', 'ram', T('Память серверов', 'Server memory'), 0, ''),
      ringCard('disk', 'disk', T('Диск', 'Disk'), diskGb / diskBase, `${diskGb.toFixed(1)} ${T('из', 'of')} ${diskBase} ${T('ГБ', 'GB')}`));

    // ----- как поделена память
    const memBase = b.enabled && b.ramMb ? b.ramMb : pc.totalMb;
    const sumAlloc = servers.reduce((a, x) => a + x.ramMb, 0);
    const scale = Math.max(memBase, sumAlloc);
    const colorOf = (x) => (gameOf(x.game) || {}).color || '#64748b';
    const allocBar = servers.some((x) => x.ramMb)
      ? h('div', { class: 'alloc' },
        h('div', { class: 'alloc-bar', role: 'img', 'aria-label': T('Как поделена память между серверами', 'How memory is split between servers') },
          servers.filter((x) => x.ramMb).map((x) => h('span', { class: 'alloc-seg', style: `--c:${colorOf(x)};width:${((x.ramMb / scale) * 100).toFixed(2)}%`, title: `${x.name}: ${fmtMem(x.ramMb)}` }))),
        h('div', { class: 'alloc-legend' },
          servers.filter((x) => x.ramMb).map((x) => h('span', { style: `--c:${colorOf(x)}` }, h('i'), `${x.name} · ${fmtMem(x.ramMb)}`)),
          h('span', { class: 'alloc-free' }, sumAlloc <= memBase ? T(`свободно ${fmtMem(memBase - sumAlloc)}`, `${fmtMem(memBase - sumAlloc)} free`) : T(`больше бюджета на ${fmtMem(sumAlloc - memBase)}`, `over budget by ${fmtMem(sumAlloc - memBase)}`))))
      : null;

    // ----- серверы
    const N = b.enabled && b.cpuCores ? b.cpuCores : pc.cores;
    const rows = servers.map((x) => {
      const ram = numInput(x.ramMb || 0, { min: 256, max: pc.totalMb, step: STEP_MB, label: T('Память, МБ', 'Memory, MB'), cls: 'ram-in', onChange: (v) => save({ servers: { [x.id]: { ramMb: v } } }) });
      if (!x.ramKnown) ram.placeholder = T('не задано', 'not set');
      if (!x.ramKnown) ram.value = '';
      const cpu = h('select', { 'aria-label': T('Ядра сервера', 'Server cores'), class: 'cpu-sel' }, h('option', { value: '0' }, T('Все выделенные', 'All allotted')), Array.from({ length: N }, (_, i) => h('option', { value: String(i + 1) }, String(i + 1))));
      cpu.value = String(Math.min(x.cpuCores, N));
      cpu.addEventListener('change', () => save({ servers: { [x.id]: { cpuCores: +cpu.value } } }));
      const hint = x.slots != null ? T(`≈ ${x.slots} игроков`, `≈ ${x.slots} players`) : '';
      const low = x.ramKnown && x.ramMb < x.recMb;
      return h('tr', { 'data-server': x.id },
        h('td', {}, h('button', { class: 'link', on: { click: () => go('server', x.id) } }, h('span', { class: 'lamp ' + x.state }), x.name)),
        h('td', {}, h('div', { class: 'ram-cell' }, ram, h('small', { class: low ? 'low' : '' }, hint + (hint ? ' · ' : '') + T('рекомендуется ', 'recommended ') + fmtMem(x.recMb)))),
        h('td', {}, cpu, x.cpuSet.length ? h('small', { class: 'cores-now' }, T('ядра ', 'cores ') + x.cpuSet.join(', ')) : null),
        h('td', { class: 'num' }, ['running', 'starting'].includes(x.state) ? `${fmtMem(x.rssMb)}` : '—'),
        h('td', { class: 'num' }, x.diskMb ? (x.diskMb >= 1024 ? (x.diskMb / 1024).toFixed(1) + T(' ГБ', ' GB') : x.diskMb + T(' МБ', ' MB')) : '—'));
    });
    const table = servers.length
      ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, [T('Сервер', 'Server'), T('Память', 'Memory'), T('Ядра', 'Cores'), T('Сейчас', 'Now'), T('На диске', 'On disk')].map((c) => h('th', {}, c)))),
        h('tbody', {}, rows),
        h('tfoot', {}, h('tr', {}, h('td', {}, T('Выделено серверам', 'Allotted to servers')), h('td', { colspan: 4 }, `${fmtMem(totals.allocMb)}${b.enabled && b.ramMb ? ' ' + T('из бюджета', 'of the') + ' ' + fmtMem(b.ramMb) : ''}`)))))
      : h('p', { class: 'muted' }, T('Серверов пока нет. Лимиты появятся здесь, когда вы создадите первый.', 'No servers yet. Limits will appear here once you create the first one.'));

    fill(page,
      h('div', { class: 'cap-head' },
        h('div', {}, h('h1', {}, T('Мощности ПК', 'PC power')), h('p', { class: 'lead' }, T('Выберите, какую часть компьютера отдать под серверы. Hearth не выйдет за этот бюджет: ограничит ядра и приоритет, не запустит лишний сервер и не даст занять больше места на диске.', 'Choose how much of your computer to give to servers. Hearth stays within that budget: it limits cores and priority, refuses an extra server and stops disk use from growing past it.'))),
        h('button', { class: 'btn', 'data-act': 'guide', on: { click: () => openGuide() } }, icon('book', 16), T('Гайд', 'Guide'))),
      warnings.length ? h('div', { class: 'notice cap-warn' }, warnings.map((w) => h('div', { 'data-warn': w.code }, w.text))) : null,
      h('h2', {}, T('Сколько отдать', 'How much to give')),
      h('div', { class: 'presets', role: 'group', 'aria-label': T('Пресеты мощности', 'Power presets') }, presetCards,
        h('button', { class: 'preset off' + (mode === 'off' ? ' on' : ''), 'data-preset': 'off', 'aria-pressed': String(mode === 'off'), on: { click: () => save({ budget: { enabled: false } }) } },
          h('span', { class: 'preset-pct' }, '∞'), h('b', {}, T('Без ограничений', 'No limits')), h('span', { class: 'preset-nums' }, T('Как раньше', 'As before')), h('small', {}, T('Hearth ничего не ограничивает', 'Hearth limits nothing')))),
      h('p', { class: 'muted cap-mode', 'data-mode': mode }, mode === 'manual' ? T('Режим: ручная настройка. Ползунки ниже можно менять в любой момент.', 'Mode: manual. You can change the sliders below at any time.') : mode === 'off' ? T('Бюджет выключен. Выберите пресет или потяните любой ползунок ниже.', 'The budget is off. Pick a preset or move any slider below.') : T(`Режим: ${active}% мощности ПК. Ползунки ниже меняют бюджет вручную.`, `Mode: ${active}% of the PC. The sliders below adjust the budget by hand.`)),
      h('h2', {}, T('Ручная настройка', 'Manual settings')), manual,
      h('h2', {}, T('Сейчас используется', 'In use right now')), usage,
      allocBar,
      h('div', { class: 'cap-srv-head' }, h('h2', {}, T('Распределение по серверам', 'Per-server split')),
        servers.length ? h('button', { class: 'btn', 'data-act': 'auto', on: { click: click(async () => { const d = await api('POST', '/api/capacity/auto'); data = d; draw(); toast(T('Бюджет распределён по серверам', 'Budget split between servers')); }) } }, icon('sliders', 16), T('Распределить автоматически', 'Split automatically')) : null),
      table);
    paintLive();
    ui.onState = paintLive;
  }

  page.replaceChildren(h('p', { class: 'muted' }, h('span', { class: 'spinner' }), ' ', T('Загрузка…', 'Loading…')));
  try {
    await load();
  } catch (e) {
    return page.replaceChildren(h('p', { class: 'muted' }, e.message));
  }
  draw();
  // диск и перечень серверов обновляются раз в несколько секунд, пока открыт экран
  const timer = setInterval(async () => {
    if (!alive()) return window.clearInterval(timer);
    if (document.activeElement && page.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
    try {
      await load();
      draw();
    } catch {}
  }, 8000);
}
