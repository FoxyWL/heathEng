'use strict';
// @imports:start
// @imports:end

export let lang = localStorage.getItem('hearth.lang') || 'ru';
export const setLang = (v) => { lang = v; };
// Точки связи между модулями: нижние слои вызывают верхние через hooks, а не импортом (нет циклов при старте)
const noop = () => {};
export const hooks = { gate: noop, render: noop, state: noop, log: noop, cleared: noop, install: noop, tunnels: noop, traffic: noop, tasks: noop, net: noop, relay: noop, relayhost: noop, publicname: noop };
export const T = (ru, en) => (lang === 'ru' ? ru : en);
export const lab = (o) => (o && typeof o === 'object' ? o[lang] || o.en : o);

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'on') for (const [e, f] of Object.entries(v)) el.addEventListener(e, f);
    else if (k === 'html') el.innerHTML = v;
    else if (['value', 'checked', 'disabled', 'selected', 'type', 'placeholder', 'title', 'min', 'max', 'step', 'multiple', 'spellcheck'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $root = document.getElementById('root');

export function applyTheme() {
  const t = localStorage.getItem('hearth.theme') || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
applyTheme();

export function toast(msg, bad) {
  const el = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, bad ? 6000 : 2800);
}

/* ---------- dialogs (own, no native confirm/prompt) ---------- */
export function openBack(back) {
  document.body.append(back);
  requestAnimationFrame(() => requestAnimationFrame(() => back.classList.add('in')));
}
export function closeBack(back) {
  if (back._closing) return;
  back._closing = true;
  back.classList.remove('in');
  setTimeout(() => back.remove(), 190);
}

export function dialog({ title, text, input, buttons, cancelValue }) {
  return new Promise((resolve) => {
    let done = false;
    const back = h('div', { class: 'modal-back' });
    const finish = (v) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      closeBack(back);
      resolve(v);
    };
    const inp = input ? h('input', { type: 'text', value: input.value || '', placeholder: input.placeholder || '', spellcheck: false, 'aria-label': input.label || title }) : null;
    const btnEls = buttons.map((b) => {
      const el = h('button', { class: 'btn ' + (b.kind === 'primary' ? 'primary' : b.kind === 'danger' ? 'fill-danger' : ''), on: { click: () => finish(inp && b.value === true ? inp.value.trim() : b.value) } }, b.label);
      el.dataset.value = String(b.value);
      return el;
    });
    const okEl = btnEls.find((_, i) => buttons[i].value === true);
    const sync = () => {
      if (inp && okEl) okEl.disabled = !input.optional && !inp.value.trim();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(cancelValue);
      } else if (e.key === 'Enter' && inp && okEl && !okEl.disabled) {
        e.preventDefault();
        okEl.click();
      }
    };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', (e) => e.target === back && finish(cancelValue));
    if (inp) inp.addEventListener('input', sync);
    back.append(
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('h2', {}, title),
        text ? h('p', {}, text) : null,
        input ? h('div', { class: 'field' }, input.label ? h('label', {}, input.label) : null, inp) : null,
        h('div', { class: 'row' }, btnEls)),
    );
    openBack(back);
    sync();
    setTimeout(() => {
      const focus = inp || btnEls.find((_, i) => buttons[i].focus) || okEl || btnEls[0];
      if (focus) focus.focus();
    }, 60);
  });
}
export const askConfirm = ({ title, text, ok, cancel, danger }) =>
  dialog({ title, text, cancelValue: false, buttons: [{ label: cancel || T('Отмена', 'Cancel'), value: false, focus: !!danger }, { label: ok || T('Да', 'Yes'), value: true, kind: danger ? 'danger' : 'primary' }] });
export const askInput = ({ title, text, label, value, placeholder, ok, optional }) =>
  dialog({ title, text, input: { label, value, placeholder, optional }, cancelValue: null, buttons: [{ label: T('Отмена', 'Cancel'), value: null }, { label: ok || T('Готово', 'Done'), value: true, kind: 'primary' }] });
export const askChoice = ({ title, text, buttons }) => dialog({ title, text, buttons, cancelValue: 'cancel' });

export async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = h('textarea', { value: text });
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = '✓ ' + T('Скопировано', 'Copied');
    btn.classList.add('ok');
    setTimeout(() => {
      btn.textContent = old;
      btn.classList.remove('ok');
    }, 1400);
  } else toast(T('Скопировано', 'Copied'));
}

export let token = localStorage.getItem('hearth.token') || '';
export const setToken = (v) => { token = v; };
const hashTok = /token=([0-9a-f]+)/.exec(location.hash);
if (hashTok) {
  token = hashTok[1];
  localStorage.setItem('hearth.token', token);
  history.replaceState(null, '', location.pathname);
}

export async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) {
      localStorage.removeItem('hearth.token');
      token = '';
      hooks.gate(T('Токен не подошёл. Скопируйте его заново.', 'The token was rejected. Copy it again.'));
    }
    throw new Error(j.error || 'HTTP ' + r.status);
  }
  return j;
}
export const guard = (fn) => async (...a) => {
  try {
    return await fn(...a);
  } catch (e) {
    toast(e.message, true);
  }
};
export async function withBusy(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
}
export const click = (fn) => (e) => withBusy(e.currentTarget, () => fn(e));

export const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB');
export const fmtMem = (mb) => (mb < 1024 ? mb + T(' МБ', ' MB') : (mb / 1024).toFixed(1) + T(' ГБ', ' GB'));
const pad = (n) => String(n).padStart(2, '0');
export const clock = (ts) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
export const dt = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const uptime = (since) => {
  const s = Math.floor((Date.now() - since) / 1000);
  const d = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return (d ? d + T(' д ', 'd ') : '') + (hh ? hh + T(' ч ', 'h ') : '') + mm + T(' мин', 'm');
};
export async function downloadBlob(url, name) {
  const r = await fetch(url, { headers: { authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
  const blob = await r.blob();
  saveBlob(blob, name);
}
export function saveBlob(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

export const STATE = () => ({
  running: T('Работает', 'Running'),
  stopped: T('Остановлен', 'Stopped'),
  starting: T('Запускается', 'Starting'),
  stopping: T('Останавливается', 'Stopping'),
  installing: T('Установка', 'Installing'),
  crashed: T('Упал', 'Crashed'),
  error: T('Ошибка', 'Error'),
});
