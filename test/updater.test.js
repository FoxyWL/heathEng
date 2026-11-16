'use strict';
// Обновление: сравнение версий, Release и запасной путь через main, SHA-256, отказ без суммы, подмена файла, режим «не установленная версия».
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

process.env.HEARTH_UPDATE_DRY = '1';
const { Updater, cmpVer, sumOf } = require('../agent/lib/updater');
let n = 0;
const ok = (m) => console.log('  ✓', m, `(${++n})`);

const exe = crypto.randomBytes(5000);
const good = crypto.createHash('sha256').update(exe).digest('hex');
let mode = 'release'; // release | main | down | badsum | nosum | tampered
let srv;
const base = () => `http://127.0.0.1:${srv.address().port}`;

(async () => {
  let fail = null;
  try {
    assert(cmpVer('1.7.0', '1.6.0') === 1 && cmpVer('v1.6.0', '1.6.0') === 0 && cmpVer('1.6.0', '1.10.0') === -1 && cmpVer('2.0', '1.9.9') === 1 && cmpVer('1.7.0-beta', '1.7.0') === -1);
    assert(sumOf(`${good}  Hearth-Setup-9.0.0.exe\n`) === good && sumOf('мусор') === '');
    ok('версии сравниваются верно (1.10 новее 1.9, бета старше релиза), сумма читается из .sha256');

    srv = http.createServer((q, r) => {
      const u = q.url;
      if (u === '/api/releases/latest') {
        if (mode === 'main' || mode === 'down') return (r.statusCode = mode === 'down' ? 500 : 404), r.end('{}');
        const assets = [{ name: 'Hearth-Setup-9.0.0.exe', browser_download_url: base() + '/dl/Hearth-Setup-9.0.0.exe', size: exe.length }];
        if (mode !== 'nosum') assets.push({ name: 'Hearth-Setup-9.0.0.exe.sha256', browser_download_url: base() + '/dl/sum' });
        return r.end(JSON.stringify({ tag_name: 'v9.0.0', body: 'Что нового: имена и обновления', assets }));
      }
      if (u === '/raw/package.json') return mode === 'down' ? ((r.statusCode = 500), r.end()) : r.end(JSON.stringify({ version: '9.0.0' }));
      if (u === '/raw/dist/Hearth-Setup-9.0.0.exe.sha256' || u === '/dl/sum') return r.end(`${mode === 'badsum' ? '0'.repeat(64) : good}  Hearth-Setup-9.0.0.exe\n`);
      if (u === '/raw/dist/Hearth-Setup-9.0.0.exe' || u === '/dl/Hearth-Setup-9.0.0.exe') return r.end(mode === 'tampered' ? Buffer.concat([exe, Buffer.from('x')]) : exe);
      r.statusCode = 404;
      r.end();
    });
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    process.env.HEARTH_UPDATE_API = base() + '/api/releases/latest';
    process.env.HEARTH_UPDATE_RAW = base() + '/raw';
    process.env.HEARTH_UPDATE_FORCE = '1';

    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-upd-'));
    const events = [];
    const make = (version = '1.6.0') => new Updater({ store: { config: {}, saveConfig() {}, paths: { data } }, emit: (t, p) => events.push([t, p]), version, quit: () => events.push(['quit']) });

    let u = make();
    let v = await u.check();
    assert(v.available && v.available.version === '9.0.0' && v.source === 'release' && /имена/.test(v.available.notes), JSON.stringify(v));
    ok('Release найден: версия, описание и источник');
    assert(events.some((e) => e[0] === 'update'), 'сообщение об обновлении отправлено в панель');

    v = await make('9.0.0').check();
    assert(!v.available, 'та же версия — обновления нет');
    ok('если версия уже последняя, обновление не предлагается');

    await u.install();
    assert(u.s.stage === 'install' && u.dry && /\/S/.test(u.dry.cmd) && u.dry.cmd.includes('start ""'), JSON.stringify(u.dry));
    assert(fs.readFileSync(u.dry.setupExe).equals(exe), 'файл на диске совпадает');
    ok('установка: скачано, сверено SHA-256, команда тихой установки и перезапуска собрана');

    u = make();
    mode = 'main';
    v = await u.check();
    assert(v.available && v.source === 'main', JSON.stringify(v));
    await u.install();
    ok('Release нет (404): версия берётся из main, установщик — из dist/');

    for (const [m, re] of [['badsum', /не совпала/], ['tampered', /не совпала/], ['nosum', /нет файла контрольной суммы/]]) {
      mode = m === 'nosum' ? 'release' : 'release';
      mode = m;
      u = make();
      if (m === 'nosum') await u.check();
      else {
        mode = 'release';
        await u.check();
        mode = m;
      }
      const dest = path.join(data, 'updates', 'Hearth-Setup-9.0.0.exe');
      fs.rmSync(dest, { force: true });
      await assert.rejects(() => u.install(), re, m);
      assert(!fs.existsSync(dest) && u.s.stage === '', 'испорченный файл не остаётся: ' + m);
    }
    ok('неверная сумма, подменённый файл, отсутствие суммы: обновление отклонено, файл удалён');

    mode = 'down';
    u = make();
    v = await u.check();
    assert(!v.available && /не удалось проверить/.test(v.error), v.error);
    ok('GitHub недоступен: понятная ошибка, ничего не ломается');

    mode = 'release';
    delete process.env.HEARTH_UPDATE_FORCE;
    u = make();
    await u.check();
    await assert.rejects(() => u.install(), /только в установленной версии/);
    ok('не из установщика (разработка): установка отклоняется с объяснением');

    u = make();
    u.skip('9.0.0');
    v = await u.check();
    assert(v.available.skipped === true);
    ok('«Пропустить версию» запоминается');
  } catch (e) {
    fail = e;
  }
  if (srv) srv.close();
  if (fail) {
    console.error('FAIL', fail.stack || fail);
    process.exit(1);
  }
  console.log(`\nupdater: ${n} проверок пройдено`);
  process.exit(0);
})();
