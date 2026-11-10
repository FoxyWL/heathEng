'use strict';
// @imports:start
// @imports:end
// Мини-графики на SVG без библиотек. Значения идут слева направо, новые справа.

const NS = 'http://www.w3.org/2000/svg';
const se = (tag, attrs) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

export function spark(series, { w = 160, h: hh = 36, max = 0, fill: fl = true, cls = '' } = {}) {
  const svg = se('svg', { viewBox: `0 0 ${w} ${hh}`, width: w, height: hh, class: 'spark ' + cls, 'aria-hidden': 'true', preserveAspectRatio: 'none' });
  const n = series.length;
  if (n < 2) {
    svg.append(se('line', { x1: 0, y1: hh - 1, x2: w, y2: hh - 1, class: 'base' }));
    return svg;
  }
  const top = max || Math.max(1, ...series) * 1.15;
  const pts = series.map((v, i) => [(i / (n - 1)) * w, hh - 2 - (Math.min(v, top) / top) * (hh - 4)]);
  const line = pts.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join(' ');
  if (fl) svg.append(se('path', { d: line + ` L${w} ${hh} L0 ${hh} Z`, class: 'area' }));
  svg.append(se('path', { d: line, class: 'line', fill: 'none' }));
  return svg;
}

// Два ряда на одном графике (вход и выход)
export function dual(a, b, opts = {}) {
  const w = opts.w || 320;
  const hh = opts.h || 70;
  const max = Math.max(1, ...a, ...b) * 1.15;
  const wrap = document.createElement('div');
  wrap.className = 'dual';
  const mk = (s, cls) => {
    const svg = spark(s, { w, h: hh, max, cls, fill: true });
    svg.setAttribute('width', '100%');
    return svg;
  };
  wrap.append(mk(a, 'a'), mk(b, 'b'));
  return wrap;
}

export function fmtRate(bps) {
  if (bps < 1024) return Math.round(bps) + ' B/s';
  if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / 1048576).toFixed(2) + ' MB/s';
}

export function meter(frac, cls = '') {
  const f = Math.max(0, Math.min(1, frac || 0));
  const el = document.createElement('div');
  el.className = 'meter ' + cls + (f > 0.9 ? ' hot' : f > 0.75 ? ' warm' : '');
  const i = document.createElement('i');
  i.style.width = (f * 100).toFixed(0) + '%';
  el.append(i);
  return el;
}

/** Кольцевой индикатор 0–1; update(f, текст) меняет заполнение и подпись. */
export function ring(frac = 0, label = '') {
  const C = 2 * Math.PI * 42;
  const el = document.createElement('div');
  el.className = 'ring';
  el.setAttribute('role', 'img');
  el.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="ring-bg" cx="50" cy="50" r="42"/><circle class="ring-fg" cx="50" cy="50" r="42" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${C.toFixed(2)}"/></svg><span class="ring-pct"></span>`;
  const fg = el.querySelector('.ring-fg');
  const pct = el.querySelector('.ring-pct');
  el.update = (f, text) => {
    const v = Math.max(0, Math.min(1, f || 0));
    fg.style.strokeDashoffset = (C * (1 - v)).toFixed(2);
    pct.textContent = text != null ? text : Math.round(v * 100) + '%';
    el.classList.toggle('hot', v > 0.9);
    el.classList.toggle('warm', v > 0.75 && v <= 0.9);
    el.setAttribute('aria-label', `${label} ${pct.textContent}`);
  };
  el.update(frac);
  return el;
}
