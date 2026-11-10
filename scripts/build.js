'use strict';
// Сборка Windows-версии одной командой: npm run build
//   1. значок (если его ещё нет)         — scripts/make-icon.js
//   2. базовый node.exe с именем Hearth  — scripts/patch-base.js
//   3. dist/hearth.exe (без консоли)     — pkg
//   4. dist/Hearth-Setup-<версия>.exe    — NSIS (если установлен makensis)
// Rust-ядро собирается отдельно: npm run build:core (нужны rust и mingw-w64 при сборке с Linux).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const exists = (...p) => fs.existsSync(path.join(root, ...p));
const run = (cmd, args, env = {}) => {
  console.log('\n> ' + [cmd, ...args].join(' '));
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error('Сборка остановлена: шаг завершился с кодом ' + r.status);
    process.exit(r.status || 1);
  }
};

if (!exists('build', 'hearth-core.exe')) {
  console.error('Нет build/hearth-core.exe. Соберите ядро: npm run build:core (без него Hearth работает, но на запасном режиме Node).');
}
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
if (!exists('build', 'hearth.ico')) run('node', ['scripts/make-icon.js']);

const pkgBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'pkg.cmd' : 'pkg');
// Первый запуск скачивает базовый node для pkg в кэш; patch-base.js работает с этим кэшем.
if (!fs.existsSync(path.join(root, 'build', 'node-win-x64.exe'))) {
  try {
    run(pkgBin, ['.', '--targets', 'node22-win-x64', '--no-bytecode', '--output', 'dist/_warmup.exe']);
  } catch {}
  fs.rmSync(path.join(root, 'dist', '_warmup.exe'), { force: true });
}
run('node', ['scripts/patch-base.js']);
// --no-bytecode: байт-код V8 привязан к платформе сборки, а exe для Windows собирается и на Linux
run(pkgBin, ['.', '--targets', 'node22-win-x64', '--no-bytecode', '--public', '--public-packages', '*', '--compress', 'GZip', '--output', 'dist/hearth.exe'], { PKG_NODE_PATH: path.join(root, 'build', 'node-win-x64.exe') });

const mk = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['makensis'], { encoding: 'utf8' });
if (mk.status === 0) {
  run('makensis', ['-V2', `-DVER=${pkg.version}`, `-DSRC=${path.join(root, 'dist')}`, `-DOUT=${path.join(root, 'dist', `Hearth-Setup-${pkg.version}.exe`)}`, 'installer/hearth.nsi']);
} else {
  console.log('\nmakensis не найден: установщик не собран (exe лежит в dist/hearth.exe).');
}
console.log('\nГотово: dist/');
