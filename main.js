'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isGuiExe, messageBox } = require('./agent/lib/winutil');

const arg = process.argv[2];
let lastLog = '';

function logFatal(err) {
  const text = `[${new Date().toISOString()}] ${err && err.stack ? err.stack : err}\n`;
  let where = '';
  for (const dir of [process.env.DATA_DIR, process.pkg ? path.join(path.dirname(process.execPath), 'data') : path.join(process.cwd(), 'data'), os.tmpdir()]) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      where = path.join(dir, 'hearth-error.log');
      fs.appendFileSync(where, text);
      break;
    } catch {
      where = '';
    }
  }
  console.error('\n  Hearth не смог запуститься или остановился из-за ошибки:\n');
  console.error('  ' + String(err && err.message ? err.message : err));
  if (where) console.error('\n  Подробности записаны в ' + where);
  lastLog = where;
  return text;
}

function holdWindow(err) {
  if (isGuiExe()) {
    // Окна консоли нет: показываем ошибку в окне Windows.
    const msg = String(err && err.message ? err.message : err || 'неизвестная ошибка');
    messageBox('Hearth не смог запуститься:\n\n' + msg + (lastLog ? '\n\nПодробности: ' + lastLog : ''), 'Hearth', 'OK', 'Error').then(() => process.exit(1));
    return;
  }
  if (!process.pkg || !process.stdin.isTTY) return process.exit(1);
  console.error('\n  Нажмите Enter, чтобы закрыть это окно.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
}

let fatalShown = false;
process.on('uncaughtException', (e) => {
  if (fatalShown) return;
  fatalShown = true;
  logFatal(e);
  holdWindow(e);
});
// Случайная необработанная ошибка в фоне (например, обрыв сети) не должна останавливать серверы игроков.
process.on('unhandledRejection', (e) => {
  console.error('[hearth] необработанная ошибка: ' + (e && e.stack ? e.stack : e));
});

if (arg === 'relay') {
  process.argv.splice(2, 1);
  require('./relay/relay.js');
} else if (arg === '--help' || arg === '-h') {
  console.log('hearth            запустить Hearth (окно приложения)\nhearth relay      запустить релей-сервер (на VPS)\nпеременные окружения описаны в README.md');
} else {
  require('./agent/server.js')
    .start()
    .catch((e) => {
      logFatal(e);
      holdWindow(e);
    });
}
