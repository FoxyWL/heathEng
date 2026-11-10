'use strict';
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'hearth/1.0' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function downloadFile(url, dest, onProgress, sha256) {
  const r = await fetch(url, { headers: { 'user-agent': 'hearth/1.0' }, redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`загрузка не удалась: HTTP ${r.status}`);
  const total = +r.headers.get('content-length') || 0;
  let got = 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const src = Readable.fromWeb(r.body);
  src.on('data', (c) => {
    got += c.length;
    if (onProgress) onProgress(got, total);
  });
  const hash = sha256 ? require('crypto').createHash('sha256') : null;
  if (hash) src.on('data', (c) => hash.update(c));
  await pipeline(src, fs.createWriteStream(tmp));
  if (hash && hash.digest('hex') !== String(sha256).toLowerCase()) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error('контрольная сумма SHA-256 не совпала, файл удалён');
  }
  fs.renameSync(tmp, dest);
  return dest;
}

module.exports = { getJson, downloadFile };
