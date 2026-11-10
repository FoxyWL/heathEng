'use strict';
const fs = require('fs');
const path = require('path');

const MAX_TEXT = 2 * 1024 * 1024;

function resolveIn(root, rel) {
  const base = path.resolve(root);
  const target = path.resolve(base, '.' + path.sep + String(rel || '').replace(/^[/\\]+/, ''));
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw Object.assign(new Error('путь вне папки сервера'), { status: 400 });
  }
  return target;
}

function list(root, rel) {
  const dir = resolveIn(root, rel);
  const ents = fs.readdirSync(dir, { withFileTypes: true });
  const items = ents.map((e) => {
    let st = null;
    try {
      st = fs.statSync(path.join(dir, e.name));
    } catch {}
    return { name: e.name, dir: e.isDirectory(), size: st && !e.isDirectory() ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
  });
  items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return items;
}

function isBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function readText(root, rel) {
  const file = resolveIn(root, rel);
  const st = fs.statSync(file);
  if (st.isDirectory()) throw Object.assign(new Error('это папка'), { status: 400 });
  if (st.size > MAX_TEXT) throw Object.assign(new Error('файл больше 2 МБ, откройте его вне панели'), { status: 413 });
  const buf = fs.readFileSync(file);
  if (isBinary(buf)) throw Object.assign(new Error('бинарный файл не открывается в редакторе'), { status: 415 });
  return buf.toString('utf8');
}

function writeText(root, rel, text) {
  const file = resolveIn(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function mkdir(root, rel) {
  fs.mkdirSync(resolveIn(root, rel), { recursive: true });
}

function rename(root, from, to) {
  const a = resolveIn(root, from);
  const b = resolveIn(root, to);
  if (fs.existsSync(b)) throw Object.assign(new Error('файл с таким именем уже есть'), { status: 409 });
  fs.renameSync(a, b);
}

function remove(root, rel) {
  const file = resolveIn(root, rel);
  if (file === path.resolve(root)) throw Object.assign(new Error('нельзя удалить корневую папку сервера'), { status: 400 });
  fs.rmSync(file, { recursive: true, force: true });
}

function writeStream(root, rel, req, maxBytes) {
  const file = resolveIn(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return new Promise((res, rej) => {
    let got = 0;
    const out = fs.createWriteStream(file);
    req.on('data', (c) => {
      got += c.length;
      if (got > maxBytes) {
        req.destroy();
        out.destroy();
        fs.rmSync(file, { force: true });
        rej(Object.assign(new Error('файл слишком большой'), { status: 413 }));
      }
    });
    req.pipe(out);
    out.on('finish', () => res(got));
    out.on('error', rej);
  });
}

module.exports = { resolveIn, list, readText, writeText, mkdir, rename, remove, writeStream };
