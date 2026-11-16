'use strict';
// Обновление Hearth: ищет новую версию на GitHub, скачивает установщик, сверяет SHA-256 и ставит тихо (без вопросов, данные сохраняются).
// Источники по порядку: последний Release (assets) и, если релиза нет или API недоступен, файлы в ветке main (package.json и dist/).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { getJson, downloadFile } = require('./download');
const runtime = require('./runtime');

const REPO = process.env.HEARTH_UPDATE_REPO || 'FoxyWL/heathEng';
const API = () => process.env.HEARTH_UPDATE_API || `https://api.github.com/repos/${REPO}/releases/latest`;
const RAW = () => process.env.HEARTH_UPDATE_RAW || `https://raw.githubusercontent.com/${REPO}/main`;

/** 1 если a новее b; -1 если старее; 0 если равны. Понимает 1.6.0, v1.6.0, 1.6.0-beta (суффикс старше релиза). */
function cmpVer(a, b) {
  const p = (v) => String(v).replace(/^v/i, '').split('-');
  const [va, sa] = p(a);
  const [vb, sb] = p(b);
  const na = va.split('.').map((x) => +x || 0);
  const nb = vb.split('.').map((x) => +x || 0);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] || 0) - (nb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (sa && !sb) return -1;
  if (!sa && sb) return 1;
  return 0;
}

const sumOf = (text) => {
  const m = /\b([0-9a-f]{64})\b/i.exec(String(text || ''));
  return m ? m[1].toLowerCase() : '';
};

class Updater {
  constructor({ store, emit, version, quit }) {
    this.store = store;
    this.emit = emit;
    this.version = version;
    this.quit = quit; // корректно завершить Hearth перед установкой
    this.s = { checking: false, available: null, error: '', lastCheck: 0, stage: '', pct: 0, source: '' };
    this.timer = null;
    this.dry = null; // для проверок: последняя команда установки
  }

  get cfg() {
    const c = this.store.config;
    c.update = { auto: true, skipped: '', ...(c.update || {}) };
    return c.update;
  }

  view() {
    const s = this.s;
    return { current: this.version, auto: this.cfg.auto !== false, canInstall: runtime.packed || process.env.HEARTH_UPDATE_FORCE === '1', ...s, available: s.available && { version: s.available.version, notes: s.available.notes, size: s.available.size, skipped: s.available.version === this.cfg.skipped } };
  }

  push() {
    this.emit('update', this.view());
  }

  async fromRelease() {
    const rel = await getJson(API());
    const ver = String(rel.tag_name || rel.name || '').replace(/^v/i, '');
    if (!/^\d+\.\d+/.test(ver)) throw new Error('в релизе нет номера версии');
    const assets = rel.assets || [];
    const exe = assets.find((a) => /^Hearth-Setup-.*\.exe$/i.test(a.name));
    if (!exe) throw new Error('в релизе нет установщика Hearth-Setup-*.exe');
    const sum = assets.find((a) => a.name === exe.name + '.sha256');
    return { version: ver, notes: String(rel.body || '').slice(0, 2000), url: exe.browser_download_url, sumUrl: sum && sum.browser_download_url, size: exe.size || 0, source: 'release' };
  }

  async fromRaw() {
    const pkg = await getJson(RAW() + '/package.json');
    const ver = String(pkg.version || '');
    if (!/^\d+\.\d+/.test(ver)) throw new Error('в репозитории нет номера версии');
    const name = `Hearth-Setup-${ver}.exe`;
    return { version: ver, notes: '', url: `${RAW()}/dist/${name}`, sumUrl: `${RAW()}/dist/${name}.sha256`, size: 0, source: 'main' };
  }

  async check({ silent = false } = {}) {
    if (this.s.checking) return this.view();
    Object.assign(this.s, { checking: true, error: '' });
    if (!silent) this.push();
    try {
      let info;
      try {
        info = await this.fromRelease();
      } catch (e1) {
        try {
          info = await this.fromRaw();
        } catch (e2) {
          throw new Error(`не удалось проверить обновления (${e1.message}; ${e2.message})`);
        }
      }
      this.s.available = cmpVer(info.version, this.version) > 0 ? info : null;
      this.s.source = info.source;
    } catch (e) {
      this.s.error = e.message;
    }
    this.s.checking = false;
    this.s.lastCheck = Date.now();
    this.push();
    return this.view();
  }

  /** Фоновая проверка: через минуту после запуска и затем раз в несколько часов, если не выключена. */
  start() {
    const every = +process.env.HEARTH_UPDATE_EVERY_MS || 6 * 3600 * 1000;
    const first = +process.env.HEARTH_UPDATE_FIRST_MS || 60000;
    const tick = () => {
      if (this.cfg.auto !== false) this.check({ silent: true }).catch(() => {});
    };
    this.timer = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, every);
      this.timer.unref();
    }, first);
    this.timer.unref();
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.timer);
  }

  setAuto(on) {
    this.cfg.auto = !!on;
    this.store.saveConfig();
    this.push();
    return this.view();
  }

  skip(version) {
    this.cfg.skipped = String(version || '');
    this.store.saveConfig();
    this.push();
    return this.view();
  }

  async install() {
    const info = this.s.available;
    if (!info) throw Object.assign(new Error('новой версии нет: сначала проверьте обновления'), { status: 409 });
    if (!(runtime.packed || process.env.HEARTH_UPDATE_FORCE === '1')) throw Object.assign(new Error('обновление ставится только в установленной версии (Hearth-Setup). Скачайте новую версию вручную.'), { status: 409 });
    if (this.s.stage) throw Object.assign(new Error('обновление уже идёт'), { status: 409 });
    const dir = path.join(this.store.paths.data, 'updates');
    const dest = path.join(dir, `Hearth-Setup-${info.version}.exe`);
    try {
      this.s.stage = 'sum';
      this.push();
      let sum = '';
      if (info.sumUrl) {
        const r = await fetch(info.sumUrl, { headers: { 'user-agent': 'hearth' }, redirect: 'follow' });
        if (r.ok) sum = sumOf(await r.text());
      }
      if (!sum) throw new Error('нет файла контрольной суммы SHA-256: без него обновление не ставится');
      this.s.stage = 'download';
      this.push();
      let last = 0;
      await downloadFile(info.url, dest, (got, total) => {
        const pct = total ? Math.round((got / total) * 100) : 0;
        if (pct !== last) {
          last = pct;
          this.s.pct = pct;
          this.push();
        }
      }, sum);
      // повторная сверка уже записанного файла: не доверяем промежуточному состоянию
      const h = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
      if (h !== sum) {
        fs.unlinkSync(dest);
        throw new Error('контрольная сумма скачанного файла не совпала');
      }
      this.s.stage = 'install';
      this.push();
      this.launch(dest);
    } catch (e) {
      this.s.stage = '';
      this.s.pct = 0;
      this.s.error = e.message;
      this.push();
      throw Object.assign(e, { status: e.status || 502 });
    }
    return this.view();
  }

  /** Установщик запускается после выхода Hearth (иначе файлы заняты) и затем открывает обновлённый Hearth. */
  launch(setupExe) {
    const hearth = process.execPath;
    const cmd = `ping -n 4 127.0.0.1 >nul & "${setupExe}" /S & start "" "${hearth}"`;
    this.dry = { setupExe, cmd };
    if (process.env.HEARTH_UPDATE_DRY === '1') return;
    spawn('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
    setTimeout(() => this.quit && this.quit(), 300);
  }
}

module.exports = { Updater, cmpVer, sumOf };
