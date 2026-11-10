'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function winCandidates() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  return [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Yandex', 'YandexBrowser', 'Application', 'browser.exe'),
    path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ].filter(Boolean);
}

function macCandidates() {
  return [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
}

function onPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const out = [];
  for (const n of names) for (const d of dirs) out.push(path.join(d, n));
  return out;
}

function findBrowser() {
  if (process.env.HEARTH_BROWSER && fs.existsSync(process.env.HEARTH_BROWSER)) return process.env.HEARTH_BROWSER;
  const list =
    process.platform === 'win32'
      ? winCandidates()
      : process.platform === 'darwin'
        ? macCandidates()
        : onPath(['microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);
  for (const p of list) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return '';
}

function openInDefaultBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
    return true;
  } catch {
    return false;
  }
}

function openAppWindow(url, profileDir) {
  const exe = findBrowser();
  if (exe) {
    try {
      fs.mkdirSync(profileDir, { recursive: true });
      const args = [`--app=${url}`, `--user-data-dir=${profileDir}`, '--window-size=1280,860', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,TranslateUI,TranslateRecentTarget', '--lang=ru'];
      if (process.platform === 'linux' && process.getuid && process.getuid() === 0) args.push('--no-sandbox');
      const child = spawn(exe, args, { stdio: 'ignore', detached: true, windowsHide: false });
      child.on('error', () => {});
      child.unref();
      return { mode: 'app', browser: exe };
    } catch {}
  }
  return { mode: openInDefaultBrowser(url) ? 'browser' : 'none', browser: '' };
}

module.exports = { openAppWindow, openInDefaultBrowser };
