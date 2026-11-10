'use strict';
// @imports:start
import { T, api, askConfirm, askInput, downloadBlob, fmtSize, guard, h, toast, token } from './lib.js';
import { S, ui } from './state.js';
// @imports:end

const joinP = (a, b) => (a ? a + '/' + b : b);

async function loadDir(p) {
  const r = await api('GET', `/api/servers/${S.sel}/files?path=${encodeURIComponent(p)}`);
  S.files.path = r.path;
  S.files.items = r.items;
}

export async function filesTab() {
  const body = h('div', { class: 'files' });
  ui.body.replaceChildren(body);
  const id = S.sel;
  const draw = () => {
    if (S.sel !== id || S.tab !== 'files') return;
    const f = S.files;
    const parts = f.path ? f.path.split('/') : [];
    const crumbs = h('div', { class: 'crumbs' }, h('button', { title: T('Корень папки сервера', 'Server folder root'), on: { click: () => open('') } }, '/'),
      parts.map((p, i) => [h('span', { class: 'muted' }, '/'), h('button', { on: { click: () => open(parts.slice(0, i + 1).join('/')) } }, p)]));
    const upload = h('input', { type: 'file', multiple: true, class: 'hidden' });
    upload.addEventListener('change', guard(async () => {
      for (const file of upload.files) {
        const r = await fetch(`/api/servers/${id}/upload?path=${encodeURIComponent(joinP(f.path, file.name))}`, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: file });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'upload failed');
      }
      toast(T('Загружено', 'Uploaded'));
      await open(f.path);
    }));
    const rowFor = (it) => {
      const full = joinP(f.path, it.name);
      const go1 = () => (it.dir ? open(full) : openFile(full));
      return h('div', { class: 'frow' + (f.open === full ? ' on' : ''), tabindex: 0, on: { click: go1, keydown: (e) => e.key === 'Enter' && go1() } },
        h('span', { class: 'nm' }, (it.dir ? '▸ ' : '') + it.name),
        h('span', { class: 'sz' }, it.dir ? '' : fmtSize(it.size)),
        h('span', { class: 'more' },
          h('button', { class: 'btn ghost sm', title: T('Переименовать', 'Rename'), on: { click: guard(async (e) => {
            e.stopPropagation();
            const n = await askInput({ title: T('Переименовать', 'Rename'), label: T('Новое имя', 'New name'), value: it.name, ok: T('Переименовать', 'Rename') });
            if (n && n !== it.name) {
              await api('POST', `/api/servers/${id}/rename`, { from: full, to: joinP(f.path, n) });
              if (f.open === full) f.open = null;
              await open(f.path);
            }
          }) } }, '✎'),
          h('button', { class: 'btn ghost sm danger', title: T('Удалить', 'Delete'), on: { click: guard(async (e) => {
            e.stopPropagation();
            const ok = await askConfirm({ title: T(`Удалить «${it.name}»?`, `Delete “${it.name}”?`), text: it.dir ? T('Папка будет удалена вместе со всем содержимым.', 'The folder is deleted with everything inside.') : T('Файл будет удалён без возможности восстановления.', 'The file is deleted permanently.'), ok: T('Удалить', 'Delete'), danger: true });
            if (!ok) return;
            await api('DELETE', `/api/servers/${id}/file?path=${encodeURIComponent(full)}`);
            if (f.open && (f.open === full || f.open.startsWith(full + '/'))) f.open = null;
            await open(f.path);
          }) } }, '✕')));
    };
    const list = h('div', { class: 'flist' }, f.items.length ? f.items.map(rowFor) : h('div', { class: 'empty-rail muted' }, T('Папка пуста', 'Empty folder')));
    const left = h('div', {}, crumbs,
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn sm', title: T('Загрузить файлы с компьютера', 'Upload files from your computer'), on: { click: () => upload.click() } }, T('Загрузить', 'Upload')), upload,
        h('button', { class: 'btn sm', on: { click: guard(async () => {
          const n = await askInput({ title: T('Новая папка', 'New folder'), label: T('Имя папки', 'Folder name'), ok: T('Создать', 'Create') });
          if (n) {
            await api('POST', `/api/servers/${id}/mkdir`, { path: joinP(f.path, n) });
            await open(f.path);
          }
        }) } }, T('Папка', 'Folder')),
        h('button', { class: 'btn sm', on: { click: guard(async () => {
          const n = await askInput({ title: T('Новый файл', 'New file'), label: T('Имя файла', 'File name'), ok: T('Создать', 'Create') });
          if (n) {
            await api('PUT', `/api/servers/${id}/file?path=${encodeURIComponent(joinP(f.path, n))}`, { text: '' });
            await open(f.path);
            await openFile(joinP(f.path, n), true);
          }
        }) } }, T('Файл', 'File'))),
      list);
    body.replaceChildren(left, editorPane());
  };
  const open = async (p) => {
    try {
      await loadDir(p);
    } catch (e) {
      toast(e.message, true);
    }
    draw();
  };
  const openFile = async (p, force) => {
    if (!force && S.files.open && S.files.text !== S.files.orig) {
      const ok = await askConfirm({ title: T('Несохранённые изменения', 'Unsaved changes'), text: T('Изменения в открытом файле будут потеряны.', 'Changes in the open file will be lost.'), ok: T('Открыть без сохранения', 'Open anyway'), danger: true });
      if (!ok) return;
    }
    try {
      const r = await api('GET', `/api/servers/${id}/file?path=${encodeURIComponent(p)}`);
      S.files.open = p;
      S.files.text = r.text;
      S.files.orig = r.text;
    } catch (e) {
      toast(e.message, true);
    }
    draw();
  };
  await open(S.files.path || '');
}

function editorPane() {
  const f = S.files;
  if (!f.open) return h('div', { class: 'editor' }, h('div', { class: 'empty-rail muted' }, T('Выберите файл слева, чтобы открыть его в редакторе. Подойдут текстовые файлы, например server.properties.', 'Pick a file on the left to open it in the editor. Text files work, e.g. server.properties.')));
  const id = S.sel;
  const pre = h('pre');
  const ta = h('textarea', { spellcheck: false, value: f.text, 'aria-label': T('Редактор', 'Editor') });
  const status = h('span', { class: 'muted' }, '');
  const paint = () => {
    pre.innerHTML = Hl.highlight(ta.value, f.open) + '\n';
    f.text = ta.value;
    status.textContent = f.text !== f.orig ? T('есть несохранённые изменения', 'unsaved changes') : '';
  };
  ta.addEventListener('input', paint);
  ta.addEventListener('scroll', () => {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  });
  const doSave = guard(async () => {
    await api('PUT', `/api/servers/${id}/file?path=${encodeURIComponent(f.open)}`, { text: ta.value });
    f.orig = ta.value;
    paint();
    toast(T('Файл сохранён', 'File saved'));
  });
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      doSave();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      paint();
    }
  });
  setTimeout(paint, 0);
  return h('div', { class: 'editor' },
    h('div', { class: 'editor-bar' }, h('b', {}, f.open), status,
      h('span', {}, h('button', { class: 'btn sm', on: { click: guard(() => downloadBlob(`/api/servers/${id}/download/${encodeURIComponent(f.open)}`, f.open.split('/').pop())) } }, T('Скачать', 'Download')), ' ', h('button', { class: 'btn sm primary', on: { click: doSave } }, T('Сохранить', 'Save') + ' (Ctrl+S)'))),
    h('div', { class: 'code' }, pre, ta));
}
