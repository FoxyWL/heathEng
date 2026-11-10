'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { paths } = require('./store');
const { downloadFile } = require('./download');
const { tarBin } = require('./winutil');

const isWin = process.platform === 'win32';
const exe = isWin ? 'java.exe' : 'java';

function run(cmd, args) {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err, so, se) =>
      res({ err, out: (so || '') + (se || '') }),
    );
  });
}

async function majorOf(javaBin) {
  const { err, out } = await run(javaBin, ['-version']);
  if (err && !out) return 0;
  const m = /version "(\d+)(?:\.(\d+))?/.exec(out);
  if (!m) return 0;
  return m[1] === '1' ? +m[2] : +m[1];
}

function findInRuntime(major) {
  const root = path.join(paths.runtime, 'java-' + major);
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {}
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === exe && path.basename(d) === 'bin') return p;
    }
  }
  return null;
}

function requiredMajor(mcVersion) {
  // Новая схема версий Minecraft (26.x и выше) требует Java 25
  const nv = /^(\d+)\.(\d+)/.exec(mcVersion || '');
  if (nv && +nv[1] >= 26) return 25;
  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(mcVersion || '');
  if (!m) return 21;
  const minor = +m[1];
  const patch = +(m[2] || 0);
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 17) return 17;
  return 8;
}

async function ensureJava(major, onStatus) {
  const log = onStatus || (() => {});
  const local = findInRuntime(major);
  if (local) return local;
  const sys = await majorOf('java');
  if (sys >= major) return 'java';
  const osName = isWin ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = os.arch() === 'arm64' ? 'aarch64' : 'x64';
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${osName}/${arch}/jre/hotspot/normal/eclipse`;
  const archive = path.join(paths.runtime, `java-${major}.${isWin ? 'zip' : 'tar.gz'}`);
  log(`Скачиваю Java ${major}…`);
  await downloadFile(url, archive, (g, t) => log(`Java ${major}: ${Math.round(g / 1048576)} МБ` + (t ? ` из ${Math.round(t / 1048576)}` : ''), t ? g / t : undefined));
  const target = path.join(paths.runtime, 'java-' + major);
  fs.mkdirSync(target, { recursive: true });
  const r = await run(tarBin(), ['-xf', archive, '-C', target]);
  if (r.err) throw new Error('не удалось распаковать Java: ' + (r.out || r.err.message));
  fs.rmSync(archive, { force: true });
  const bin = findInRuntime(major);
  if (!bin) throw new Error('Java распакована, но java не найдена');
  if (!isWin) fs.chmodSync(bin, 0o755);
  return bin;
}

async function systemJava() {
  const major = await majorOf('java');
  return major ? { found: true, major } : { found: false, major: 0 };
}

module.exports = { ensureJava, requiredMajor, systemJava };
