'use strict';
// Сборка Windows-версии одной командой: npm run build
//   1. значок (если его ещё нет)               — scripts/make-icon.js
//   2. Electron для Windows (кэш build/_el)    — скачивается один раз через npm
//   3. dist/win-unpacked/Hearth.exe + resources/app (код Hearth, без asar: ядро и web читаются как обычные файлы)
//   4. dist/Hearth-Setup-<версия>.exe          — NSIS (если установлен makensis)
// Rust-ядро собирается отдельно: npm run build:core (нужны rust и mingw-w64 при сборке с Linux).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const R = require('resedit');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const EL_VERSION = pkg.devDependencies.electron;
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

// --- Electron для Windows ---
const elDist = path.join(root, 'build', '_el', 'node_modules', 'electron', 'dist');
if (!fs.existsSync(path.join(elDist, 'electron.exe'))) {
  fs.mkdirSync(path.join(root, 'build', '_el'), { recursive: true });
  run('npm', ['install', '--prefix', 'build/_el', '--no-save', '--no-audit', '--no-fund', '--no-package-lock', `electron@${EL_VERSION}`], { npm_config_platform: 'win32', npm_config_arch: 'x64' });
}
if (!fs.existsSync(path.join(elDist, 'electron.exe'))) {
  console.error('Не удалось получить Electron для Windows (build/_el).');
  process.exit(1);
}

const out = path.join(root, 'dist', 'win-unpacked');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(elDist, out, { recursive: true });

// Лишнее из поставки: языки кроме русского и английского, список лицензий, стандартная заглушка Electron.
// vk_swiftshader.dll оставляем: это программная отрисовка для ПК без рабочей видеокарты (VM, удалённый стол).
for (const f of fs.readdirSync(path.join(out, 'locales'))) if (!/^(ru|en-US)\.pak$/.test(f)) fs.rmSync(path.join(out, 'locales', f));
for (const f of ['LICENSES.chromium.html']) fs.rmSync(path.join(out, f), { force: true });
fs.rmSync(path.join(out, 'resources', 'default_app.asar'), { force: true });

// --- код программы ---
const app = path.join(out, 'resources', 'app');
for (const d of ['agent', 'desktop', 'relay', 'shared', 'web']) fs.cpSync(path.join(root, d), path.join(app, d), { recursive: true });
fs.mkdirSync(path.join(app, 'build'), { recursive: true });
for (const f of ['hearth-core.exe', 'hearth.ico']) if (exists('build', f)) fs.copyFileSync(path.join(root, 'build', f), path.join(app, 'build', f));
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'hearth', version: pkg.version, description: pkg.description, license: pkg.license, main: 'desktop/main.js' }, null, 2) + '\n');

// --- Hearth.exe: имя, значок и версия в свойствах файла (диспетчер задач показывает «Hearth», а не «Electron») ---
const exePath = path.join(out, 'Hearth.exe');
fs.renameSync(path.join(out, 'electron.exe'), exePath);
{
  const exe = R.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = R.NtExecutableResource.from(exe);
  const ico = R.Data.IconFile.from(fs.readFileSync(path.join(root, 'build', 'hearth.ico')));
  const groups = R.Resource.IconGroupEntry.fromEntries(res.entries);
  R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groups.length ? groups[0].id : 1, groups.length ? groups[0].lang : 1033, ico.icons.map((i) => i.data));
  const vis = R.Resource.VersionInfo.fromEntries(res.entries);
  const vi = vis.length ? vis[0] : R.Resource.VersionInfo.createEmpty();
  const [maj, min, pat] = pkg.version.split('.').map(Number);
  vi.setFileVersion(maj, min, pat || 0, 0);
  vi.setProductVersion(maj, min, pat || 0, 0);
  vi.setStringValues(
    { lang: 1033, codepage: 1200 },
    { FileDescription: 'Hearth — менеджер игровых серверов', ProductName: 'Hearth', CompanyName: 'Hearth', LegalCopyright: 'MIT License', OriginalFilename: 'Hearth.exe', InternalName: 'Hearth', FileVersion: pkg.version, ProductVersion: pkg.version }
  );
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
}
fs.copyFileSync(path.join(root, 'README.md'), path.join(out, 'README.txt'));
console.log(`\nПриложение собрано: ${path.relative(root, out)}`);

const mk = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['makensis'], { encoding: 'utf8' });
if (mk.status === 0) {
  run('makensis', ['-V2', `-DVER=${pkg.version}`, `-DSRC=${out}`, `-DOUT=${path.join(root, 'dist', `Hearth-Setup-${pkg.version}.exe`)}`, 'installer/hearth.nsi']);
} else {
  console.log('\nmakensis не найден: установщик не собран (приложение лежит в dist/win-unpacked).');
}
console.log('\nГотово: dist/');
