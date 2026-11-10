'use strict';
// Мелочи, которые на Windows ведут себя иначе: системный tar, запуск .bat/.cmd,
// определение "приложения без консоли" и диалоговые окна.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const isWin = process.platform === 'win32';

function sys32(name) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', name);
}

// В PATH на Windows часто первым стоит tar из Git/MSYS: он принимает "C:\..." за адрес хоста.
// Системный bsdtar (Windows 10 1803+) работает с путями Windows и умеет zip.
function tarBin() {
  if (isWin) {
    const p = sys32('tar.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'tar';
}

// Node 22 не запускает .bat/.cmd без оболочки (ошибка EINVAL), поэтому такие команды идут через cmd.exe.
function viaCmd(cmd, args) {
  const q = (s) => (/[\s&()^|<>"%]/.test(s) || s === '' ? '"' + String(s).replace(/"/g, '""') + '"' : s);
  return {
    cmd: process.env.ComSpec || sys32('cmd.exe'),
    args: ['/d', '/s', '/c', '"' + [cmd, ...args].map(q).join(' ') + '"'],
    opts: { windowsVerbatimArguments: true },
  };
}

function findOnPath(name, cwd) {
  const dirs = [cwd, ...(process.env.PATH || '').split(path.delimiter)].filter(Boolean);
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const ext of exts) {
    for (const d of dirs) {
      const p = path.join(d, name + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return '';
}

// Возвращает {cmd, args, opts} для spawn с учётом особенностей Windows.
function resolveSpawn(cmd, args, cwd) {
  if (!isWin) return { cmd, args, opts: {} };
  const ext = path.extname(cmd).toLowerCase();
  if (ext === '.bat' || ext === '.cmd') return viaCmd(cmd, args);
  if (ext === '.exe' || ext === '.com') return { cmd, args, opts: {} };
  if (!ext) {
    const found = findOnPath(cmd, path.isAbsolute(cmd) || /[\\/]/.test(cmd) ? '' : cwd);
    if (/\.(bat|cmd)$/i.test(found)) return viaCmd(found, args);
  }
  return { cmd, args, opts: {} };
}

// Поле "Subsystem" в заголовке PE: 2 = окно без консоли, 3 = консольное приложение.
let guiCache = null;
function isGuiExe() {
  if (guiCache !== null) return guiCache;
  guiCache = false;
  if (!isWin || !process.pkg) return false;
  try {
    const fd = fs.openSync(process.execPath, 'r');
    const buf = Buffer.alloc(4096);
    fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const pe = buf.readUInt32LE(0x3c);
    guiCache = buf.readUInt16LE(pe + 24 + 68) === 2;
  } catch {}
  return guiCache;
}

// Окно сообщения Windows через PowerShell (есть в Windows 10/11).
// Возвращает 'OK' | 'Yes' | 'No' | 'Cancel' или '' если показать окно не удалось.
function messageBox(text, title, buttons = 'OK', icon = 'Information') {
  return new Promise((resolve) => {
    if (!isWin) return resolve('');
    const ps =
      "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; " +
      "$r = [System.Windows.Forms.MessageBox]::Show($f, $env:HEARTH_MSG, $env:HEARTH_TITLE, '" + buttons + "', '" + icon + "'); Write-Output $r";
    const exe = fs.existsSync(sys32('WindowsPowerShell\\v1.0\\powershell.exe')) ? sys32('WindowsPowerShell\\v1.0\\powershell.exe') : 'powershell.exe';
    let out = '';
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const p = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', ps], {
        windowsHide: true,
        env: { ...process.env, HEARTH_MSG: text, HEARTH_TITLE: title },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      p.stdout.on('data', (d) => (out += d));
      p.on('error', () => finish(''));
      p.on('close', () => finish(out.trim().split(/\r?\n/).pop() || ''));
    } catch {
      finish('');
    }
  });
}

module.exports = { isWin, tarBin, resolveSpawn, isGuiExe, messageBox };
