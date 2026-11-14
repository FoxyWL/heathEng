'use strict';
// Установщик релея для VPS (relay/install.sh): без systemd и без интернета, из локальных файлов. Проверка: установка, ссылка, настоящий клиент, повтор, удаление.
const { spawnSync } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const { TunnelClient } = require(path.join(root, 'agent/lib/tunnel'));
const { parseLink } = require(path.join(root, 'agent/lib/relaydisc'));
let n = 0;
const ok = (m) => console.log('  ✓', m, `(${++n})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.getuid && process.getuid() !== 0) {
  console.log('SKIP relay-install: нужны права root (скрипт устанавливает как на VPS)');
  process.exit(0);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-inst-'));
const env = { ...process.env, HEARTH_RELAY_DIR: path.join(tmp, 'opt'), HEARTH_RELAY_ENV: path.join(tmp, 'relay.env'), HEARTH_NO_SYSTEMD: '1', HEARTH_RELAY_SRC: root, PUBLIC_HOST: '127.0.0.1', CONTROL_PORT: '17620', PORT_MIN: '17621', PORT_MAX: '17625', DISCOVERY_PORT: '0' };
delete env.RELAY_TOKEN;
const run = (args = []) => spawnSync('bash', [path.join(root, 'relay/install.sh'), ...args], { env, encoding: 'utf8', timeout: 60000 });
const tokenOf = (s) => (/token=([0-9a-f]+)/.exec(s) || [])[1];

(async () => {
  let fail = null;
  try {
    let r = run();
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const link = /hearth-relay:\/\/\S+/.exec(r.stdout)[0];
    const p = parseLink(link);
    assert(p.host === '127.0.0.1' && p.port === 17620 && p.token.length === 24, link);
    assert(fs.existsSync(path.join(tmp, 'opt/relay/relay.js')) && fs.existsSync(path.join(tmp, 'opt/shared/util.js')));
    assert.strictEqual((fs.statSync(path.join(tmp, 'relay.env')).mode & 0o777).toString(8), '600', 'файл с токеном закрыт для других');
    ok('одна команда: релей установлен и запущен, напечатана ссылка hearth-relay://, файл с токеном доступен только root');

    const c = new TunnelClient();
    c.configure({ host: '127.0.0.1', port: p.port, token: p.token, name: 'friend' });
    c.add({ id: 'a', proto: 'tcp', localPort: 1 });
    c.start();
    for (let i = 0; i < 40 && !(c.status === 'online' && c.list()[0].info); i++) await wait(150);
    assert(c.status === 'online' && c.list()[0].info, 'клиент не подключился: ' + c.status);
    const port = c.list()[0].info.port;
    assert(port >= 17621 && port <= 17625, 'порт в выданном диапазоне: ' + port);
    c.stop();
    ok('Hearth подключается по напечатанной ссылке и получает порт из диапазона');

    r = run();
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(tokenOf(r.stdout), p.token, 'повторный запуск оставляет прежний токен');
    ok('повторный запуск: релей обновлён, токен прежний (ссылки у друзей не ломаются)');

    r = run(['--uninstall']);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    await wait(500);
    assert(!fs.existsSync(path.join(tmp, 'opt')) && !fs.existsSync(path.join(tmp, 'relay.env')), 'файлы удалены');
    const bad = new TunnelClient();
    bad.configure({ host: '127.0.0.1', port: p.port, token: p.token, name: 'x' });
    bad.add({ id: 'a', proto: 'tcp', localPort: 1 });
    bad.start();
    await wait(1500);
    assert(bad.status !== 'online', 'релей остановлен');
    bad.stop();
    ok('--uninstall: релей остановлен, файлы удалены');

    r = spawnSync('bash', [path.join(root, 'relay/install.sh')], { env: { ...env, HEARTH_RELAY_DIR: path.join(tmp, 'o2'), HEARTH_RELAY_ENV: path.join(tmp, 'e2'), HEARTH_RELAY_SRC: path.join(tmp, 'нет-такой-папки') }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, 'без исходников установка должна упасть, а не сделать вид');
    ok('ошибка скачивания останавливает установку, а не печатает ложный «Релей работает»');
  } catch (e) {
    fail = e;
  }
  spawnSync('pkill', ['-f', 'hearth-inst-.*relay.js']);
  if (fail) {
    console.log('FAIL', fail.stack || fail);
    process.exit(1);
  }
  console.log(`\nrelay-install: ${n} проверок пройдено`);
  process.exit(0);
})();
