'use strict';
// Загрузчики серверов на имитации источников: Paper (Fill v3 и запасной v2), контрольная сумма, Mojang, Purpur.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

let n = 0;
const ok = (m) => console.log('  ✓', m, `(${++n})`);
const JAR = Buffer.from('fake-paper-jar-' + 'x'.repeat(5000));
const SHA = crypto.createHash('sha256').update(JAR).digest('hex');
let v3Down = false;

const srv = http.createServer((req, res) => {
  const send = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const u = req.url;
  const base = `http://127.0.0.1:${srv.address().port}`;
  if (u.startsWith('/v3/') && v3Down) return send({ error: 'down' }, 503);
  if (u === '/v3/projects/paper') return send({ project: { id: 'paper' }, versions: { '1.21': ['1.21.8', '1.21.7'], '1.20': ['1.20.6'] } });
  if (u === '/v3/projects/paper/versions/1.21.8/builds') return send([
    { id: 12, channel: 'ALPHA', downloads: { 'server:default': { name: 'paper-1.21.8-12.jar', url: base + '/dl/bad', checksums: { sha256: SHA } } } },
    { id: 11, channel: 'STABLE', downloads: { 'server:default': { name: 'paper-1.21.8-11.jar', url: base + '/dl/good', checksums: { sha256: SHA } } } },
  ]);
  if (u === '/v3/projects/paper/versions/1.20.6/builds') return send([{ id: 1, channel: 'STABLE', downloads: { 'server:default': { name: 'p.jar', url: base + '/dl/bad', checksums: { sha256: SHA } } } }]);
  if (u === '/v2/projects/paper') return send({ versions: ['1.20.6', '1.21.8'] });
  if (u === '/v2/projects/paper/versions/1.21.8/builds') return send({ builds: [{ build: 3, downloads: { application: { name: 'paper-1.21.8-3.jar' } } }] });
  if (u === '/v2/projects/paper/versions/1.21.8/builds/3/downloads/paper-1.21.8-3.jar') { res.writeHead(200, { 'content-length': JAR.length }); return res.end(JAR); }
  if (u === '/dl/good') { res.writeHead(200, { 'content-length': JAR.length }); return res.end(JAR); }
  if (u === '/dl/bad') { res.writeHead(200); return res.end(Buffer.from('tampered')); }
  send({ error: 'nf' }, 404);
});

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  process.env.HEARTH_PAPER_API = `http://127.0.0.1:${port}/v3`;
  process.env.HEARTH_PAPER_V2_API = `http://127.0.0.1:${port}/v2`;
  const { games } = require('../agent/lib/catalog');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  const paper = games['minecraft-paper'];

  const v = await paper.versions();
  assert.deepStrictEqual(v.versions, ['1.21.8', '1.21.7', '1.20.6']);
  assert.strictEqual(v.latest, '1.21.8');
  ok('Paper v3: версии из групп, новые первыми');

  const s1 = { version: '1.21.8', settings: {} };
  await paper.install(s1, dir, () => {});
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'server.jar')), JAR);
  assert.strictEqual(s1.settings.jar, 'server.jar');
  ok('Paper v3: выбрана STABLE-сборка, файл скачан, SHA-256 сошёлся');

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  await assert.rejects(() => paper.install({ version: '1.20.6', settings: {} }, dir2, () => {}), /SHA-256/);
  assert(!fs.existsSync(path.join(dir2, 'server.jar')) && !fs.existsSync(path.join(dir2, 'server.jar.part')));
  ok('подменённый файл отклонён, остатков нет');

  v3Down = true;
  const v2 = await paper.versions();
  assert.strictEqual(v2.latest, '1.21.8');
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  await paper.install({ version: '1.21.8', settings: {} }, dir3, () => {});
  assert.deepStrictEqual(fs.readFileSync(path.join(dir3, 'server.jar')), JAR);
  ok('v3 недоступен: работает запасной API v2');

  srv.close();
  console.log(`\ndownloads: ${n} проверок пройдено`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
