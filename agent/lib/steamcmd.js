'use strict';
// Установка и обновление серверов Steam-игр через SteamCMD (анонимный вход).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { paths } = require('./store');
const { downloadFile } = require('./download');
const { tarBin } = require('./winutil');

const isWin = process.platform === 'win32';
const BASE = 'https://steamcdn-a.akamaihd.net/client/installer/';
const ARCHIVE = isWin ? 'steamcmd.zip' : process.platform === 'darwin' ? 'steamcmd_osx.tar.gz' : 'steamcmd_linux.tar.gz';

function dir() {
  return path.join(paths.runtime, 'steamcmd');
}

function binary() {
  if (process.env.HEARTH_STEAMCMD) return process.env.HEARTH_STEAMCMD;
  return path.join(dir(), isWin ? 'steamcmd.exe' : 'steamcmd.sh');
}

function runRaw(args, onLine, cwd) {
  return new Promise((resolve) => {
    let child;
    try {
      const wd = cwd || dir();
      fs.mkdirSync(wd, { recursive: true });
      child = spawn(binary(), args, { cwd: wd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out: e.message });
    }
    let out = '';
    let rest = '';
    const feed = (d) => {
      const text = String(d);
      out += text;
      if (out.length > 200000) out = out.slice(-100000);
      rest += text;
      const parts = rest.split(/\r\n|\r|\n/);
      rest = parts.pop();
      for (const line of parts) if (line.trim() && onLine) onLine(line.trim());
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => resolve({ code: -1, out: out + e.message }));
    child.on('close', (code) => {
      if (rest.trim() && onLine) onLine(rest.trim());
      resolve({ code, out });
    });
  });
}

async function ensure(log) {
  if (process.env.HEARTH_STEAMCMD) return;
  if (fs.existsSync(binary())) return;
  fs.mkdirSync(dir(), { recursive: true });
  const archive = path.join(dir(), ARCHIVE);
  log('Скачиваю SteamCMD…');
  await downloadFile(BASE + ARCHIVE, archive, (g, t) => log(`SteamCMD: ${Math.round(g / 1024)} КБ`, t ? g / t : undefined));
  await new Promise((res, rej) => {
    const p = spawn(tarBin(), ['-xf', archive, '-C', dir()], { windowsHide: true });
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error('не удалось распаковать SteamCMD'))));
  });
  fs.rmSync(archive, { force: true });
  if (!isWin) {
    try {
      fs.chmodSync(binary(), 0o755);
    } catch {}
  }
  log('SteamCMD обновляет себя при первом запуске…');
  await runRaw(['+quit'], null); // первый запуск скачивает свои компоненты; код выхода тут не важен
}

// Прогресс из строк вида: "Update state (0x61) downloading, progress: 53.53 (123 / 456)"
function parseLine(line) {
  let m = /Update state \(0x[0-9a-f]+\) ([a-z ]+), progress: ([\d.]+)/i.exec(line);
  if (m) return { kind: 'progress', phase: m[1].trim(), frac: Math.min(1, +m[2] / 100) };
  m = /^(?:ERROR|Error)!?\s*(.*)$/.exec(line);
  if (m) return { kind: 'error', text: m[1] || line };
  if (/^Success!/.test(line)) return { kind: 'ok' };
  return null;
}

const PHASE = { downloading: 'Скачивание', validating: 'Проверка файлов', 'verifying install': 'Проверка', preallocating: 'Подготовка диска', committing: 'Запись на диск', 'reconfiguring': 'Настройка' };

async function appUpdate({ appId, installDir, branch, extra, log }) {
  await ensure(log);
  fs.mkdirSync(installDir, { recursive: true });
  const args = ['+force_install_dir', installDir, '+login', 'anonymous'];
  for (const e of extra || []) args.push(...String(e).split(' '));
  args.push('+app_update', String(appId));
  if (branch && branch !== 'public') args.push('-beta', branch);
  args.push('validate', '+quit');
  log(`SteamCMD: app_update ${appId}${branch && branch !== 'public' ? ' (ветка ' + branch + ')' : ''}`);
  let ok = false;
  let err = '';
  let lastPct = -1;
  // SteamCMD иногда завершается с кодом 8 из-за обновления самого клиента: пробуем до трёх раз
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    err = '';
    const r = await runRaw(args, (line) => {
      const p = parseLine(line);
      if (!p) return;
      if (p.kind === 'progress') {
        const pct = Math.floor(p.frac * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          log(`${PHASE[p.phase] || p.phase}: ${pct}%`, p.frac);
          if (pct % 25 === 0) log(`${PHASE[p.phase] || p.phase}: ${pct}%`); // в журнал — только вехи
        }
      } else if (p.kind === 'ok') ok = true;
      else if (p.kind === 'error') err = p.text;
    });
    if (!ok && attempt < 3 && !/No subscription|Invalid Platform|Failed to install app/.test(err + r.out)) log(`SteamCMD: повтор ${attempt + 1}/3…`);
    else if (!ok) break;
  }
  if (!ok) throw new Error('SteamCMD не смог установить сервер' + (err ? ': ' + err : '') + '. Для части игр нужен вход в Steam: используйте вариант «Свой сервер» и установите сервер вручную.');
}

module.exports = { appUpdate, binary };
