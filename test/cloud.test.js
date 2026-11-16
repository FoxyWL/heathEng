'use strict';
// Облачные бэкапы: подпись SigV4 проверяется поддельным S3 (серверная сторона пересчитывает подпись), загрузка, список, ротация, возврат на ПК, восстановление, ошибки.
const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
let n = 0;
const ok = (m) => console.log('  ✓', m, `(${++n})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const AK = 'AKIATEST';
const SK = 'secret/KEY+test';
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');
const objects = new Map(); // "bucket/key" -> {data, mtime}
let sigFails = 0;
let sigOk = 0;

// Поддельный S3: проверяет подпись так же, как настоящий (по присланным заголовкам), хранит объекты в памяти
const s3 = http.createServer((q, r) => {
  const chunks = [];
  q.on('data', (d) => chunks.push(d));
  q.on('end', () => {
    const body = Buffer.concat(chunks);
    const u = new URL(q.url, 'http://x');
    const a = q.headers.authorization || '';
    const m = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(a);
    const fail = (c, msg) => {
      sigFails++;
      r.statusCode = c;
      r.end(`<Error><Code>${c === 403 ? 'SignatureDoesNotMatch' : 'Bad'}</Code><Message>${msg}</Message></Error>`);
    };
    if (!m || m[1] !== AK) return fail(403, 'unknown key');
    const [, , day, region, signed, sig] = m;
    const names = signed.split(';');
    const canonHeaders = names.map((k) => `${k}:${String(q.headers[k]).trim()}\n`).join('');
    const cq = [...u.searchParams.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const payload = q.headers['x-amz-content-sha256'];
    if (payload !== sha(body)) return fail(400, 'payload hash mismatch');
    const canon = [q.method, u.pathname, cq, canonHeaders, signed, payload].join('\n');
    const sts = ['AWS4-HMAC-SHA256', q.headers['x-amz-date'], `${day}/${region}/s3/aws4_request`, sha(canon)].join('\n');
    const key = hmac(hmac(hmac(hmac('AWS4' + SK, day), region), 's3'), 'aws4_request');
    if (crypto.createHmac('sha256', key).update(sts).digest('hex') !== sig) return fail(403, 'signature mismatch');
    sigOk++;
    const p = decodeURIComponent(u.pathname.slice(1)); // bucket/key
    const [bucket, ...rest] = p.split('/');
    const k = rest.join('/');
    if (bucket !== 'bk') return fail(404, 'no bucket');
    if (q.method === 'PUT') {
      objects.set(p, { data: body, mtime: Date.now() });
      return r.end();
    }
    if (q.method === 'GET' && !k) {
      const prefix = u.searchParams.get('prefix') || '';
      const items = [...objects].filter(([kk]) => kk.startsWith(`bk/${prefix}`)).map(([kk, v]) => `<Contents><Key>${kk.slice(3).replace(/&/g, '&amp;')}</Key><Size>${v.data.length}</Size><LastModified>${new Date(v.mtime).toISOString()}</LastModified></Contents>`);
      return r.end(`<ListBucketResult>${items.join('')}</ListBucketResult>`);
    }
    if (q.method === 'GET') return objects.has(p) ? r.end(objects.get(p).data) : fail(404, 'NoSuchKey');
    if (q.method === 'DELETE') {
      objects.delete(p);
      return (r.statusCode = 204), r.end();
    }
    fail(405, 'method');
  });
});

(async () => {
  let agent;
  let fail = null;
  try {
    await new Promise((r) => s3.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${s3.address().port}`;

    // --- S3-клиент напрямую ---
    const { S3 } = require('../agent/lib/s3');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-s3-'));
    const f = path.join(tmp, 'a b&c.tar.gz');
    const payload = crypto.randomBytes(300000);
    fs.writeFileSync(f, payload);
    const c = new S3({ endpoint, region: 'eu-test-1', bucket: 'bk', accessKey: AK, secretKey: SK });
    await c.put('hearth/s1/a b&c.tar.gz', f);
    assert(objects.get('bk/hearth/s1/a b&c.tar.gz').data.equals(payload));
    const list = await c.list('hearth/s1/');
    assert(list.length === 1 && list[0].key === 'hearth/s1/a b&c.tar.gz' && list[0].size === payload.length);
    await c.get('hearth/s1/a b&c.tar.gz', path.join(tmp, 'back.bin'));
    assert(fs.readFileSync(path.join(tmp, 'back.bin')).equals(payload));
    await c.del('hearth/s1/a b&c.tar.gz');
    assert.strictEqual((await c.list('hearth/')).length, 0);
    assert(sigFails === 0 && sigOk >= 4, `подписи: верных ${sigOk}, неверных ${sigFails}`);
    ok('подпись SigV4 принята «хранилищем» (пересчёт на его стороне): загрузка, список, скачивание, удаление, имя с пробелом и &');
    await assert.rejects(() => new S3({ endpoint, region: 'eu-test-1', bucket: 'bk', accessKey: AK, secretKey: 'wrong' }).list(''), /403 SignatureDoesNotMatch/);
    await assert.rejects(() => new S3({ endpoint, bucket: 'nope', accessKey: AK, secretKey: SK, region: 'us-east-1' }).list(''), /S3: 403|S3: 404/);
    ok('неверный ключ или бакет: понятная ошибка с кодом хранилища');

    // --- через агента ---
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-cl-'));
    let out = '';
    agent = spawn('node', [path.join(root, 'main.js')], { env: { ...process.env, DATA_DIR: data, PORT: '17830', NO_BROWSER: '1', HEARTH_NO_OPEN: '1', HEARTH_RELAY_AUTO: '0', HEARTH_NETWATCH_MS: '60000' }, stdio: ['ignore', 'pipe', 'inherit'] });
    agent.stdout.on('data', (d) => (out += d));
    for (let i = 0; i < 80 && !/token=/.test(out); i++) await wait(100);
    const token = /token=([0-9a-f]+)/.exec(out)[1];
    const api = async (m, u, body) => {
      const r = await fetch('http://127.0.0.1:17830' + u, { method: m, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { s: r.status, j: await r.json().catch(() => ({})) };
    };
    assert.strictEqual((await api('PUT', '/api/cloud', { enabled: true })).s, 400);
    assert.strictEqual((await api('PUT', '/api/cloud', { endpoint: 'ftp://x' })).s, 400);
    assert.strictEqual((await api('POST', '/api/cloud/test')).s, 409);
    ok('агент: без настроек включить нельзя, кривой адрес отклоняется, проверка без настроек даёт понятный отказ');

    const v = (await api('PUT', '/api/cloud', { endpoint, region: 'eu-test-1', bucket: 'bk', accessKey: AK, secretKey: SK, keep: 2, enabled: true })).j;
    assert(v.enabled && v.hasSecret && !JSON.stringify(v).includes(SK));
    assert((await api('POST', '/api/cloud/test')).s === 200);
    ok('агент: настройки сохранены, секретный ключ не возвращается, проверка подключения проходит');

    const sv = (await api('POST', '/api/servers', { game: 'custom', name: 'Облачный', settings: { command: 'node -e "setInterval(()=>{},1000)"', port: 15840 } })).j;
    fs.writeFileSync(path.join(data, 'servers', sv.id, 'world.txt'), 'мир v1');
    const names = [];
    for (let i = 0; i < 3; i++) {
      names.push((await api('POST', `/api/servers/${sv.id}/backups`, {})).j.name);
      await wait(1100);
    }
    for (let i = 0; i < 40 && [...objects.keys()].length < 2; i++) await wait(150);
    await wait(600);
    let remote = (await api('GET', `/api/servers/${sv.id}/cloud-backups`)).j;
    assert(remote.length === 2 && remote.every((r) => r.local), JSON.stringify(remote));
    assert(remote.every((r) => names.includes(r.name)) && !remote.some((r) => r.name === names[0]), 'в облаке две последние копии');
    ok('агент: каждый бэкап сам уходит в облако, в облаке остаются только последние keep=2');

    // потеря на ПК и возврат из облака
    const keepName = remote[0].name;
    fs.rmSync(path.join(data, 'backups', sv.id, keepName));
    remote = (await api('GET', `/api/servers/${sv.id}/cloud-backups`)).j;
    assert(remote.find((r) => r.name === keepName && !r.local));
    assert((await api('POST', `/api/servers/${sv.id}/cloud-backups/${encodeURIComponent(keepName)}/pull`)).s === 200);
    assert(fs.existsSync(path.join(data, 'backups', sv.id, keepName)));
    fs.writeFileSync(path.join(data, 'servers', sv.id, 'world.txt'), 'испорчено');
    assert((await api('POST', `/api/servers/${sv.id}/backups/${encodeURIComponent(keepName)}/restore`)).s === 200);
    assert.strictEqual(fs.readFileSync(path.join(data, 'servers', sv.id, 'world.txt'), 'utf8'), 'мир v1');
    ok('агент: бэкап удалён на ПК → «Вернуть на ПК» из облака → «Восстановить» возвращает мир');

    // ручная загрузка и удаление
    const man = (await api('POST', `/api/servers/${sv.id}/backups`, {})).j.name;
    for (let i = 0; i < 40 && !(await api('GET', `/api/servers/${sv.id}/cloud-backups`)).j.some((r) => r.name === man); i++) await wait(150);
    assert((await api('DELETE', `/api/servers/${sv.id}/cloud-backups/${encodeURIComponent(man)}`)).s === 200);
    assert(!(await api('GET', `/api/servers/${sv.id}/cloud-backups`)).j.some((r) => r.name === man));
    assert.strictEqual((await api('POST', `/api/servers/${sv.id}/cloud-backups`, { name: 'нет-такого.tar.gz' })).s, 404);
    ok('агент: удаление из облака, загрузка несуществующего бэкапа отклоняется');

    // сбой хранилища не ломает локальный бэкап
    await api('PUT', '/api/cloud', { secretKey: 'wrong-key' });
    const failName = (await api('POST', `/api/servers/${sv.id}/backups`, {})).j.name;
    assert(fs.existsSync(path.join(data, 'backups', sv.id, failName)), 'локальный бэкап создан');
    for (let i = 0; i < 40 && (await api('GET', '/api/cloud')).j.last.ok; i++) await wait(150);
    const st = (await api('GET', '/api/cloud')).j.last;
    assert(!st.ok && /403/.test(st.error), JSON.stringify(st));
    ok('агент: хранилище отвергло ключ — локальный бэкап цел, ошибка видна в настройках');
  } catch (e) {
    fail = e;
  }
  try { agent && agent.kill(); } catch {}
  s3.close();
  if (fail) {
    console.error('FAIL', fail.stack || fail);
    process.exit(1);
  }
  console.log(`\ncloud: ${n} проверок пройдено`);
  process.exit(0);
})();
