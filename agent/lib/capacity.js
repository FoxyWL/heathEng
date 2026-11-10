'use strict';
// Бюджет мощностей: какую часть ПК пользователь отдаёт серверам (ядра CPU, память, диск) и как это соблюдается.
// Память: Java получает -Xmx из настроек сервера, остальным игрового процесса следит наблюдатель; запуск сверх бюджета отклоняется.
// CPU: серверы привязываются к ядрам из выделенного набора (последние N ядер, нулевое остаётся системе) и получают сниженный приоритет.
// Диск: учитываются папки серверов, созданных в Hearth, и бэкапы; новые серверы сверх бюджета не создаются.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');
const { games } = require('./catalog');

const isWin = process.platform === 'win32';
const MB = 1048576;
const PRIORITY = { low: 19, below: 10, normal: 0 };
const MC_PER_PLAYER_MB = 150;

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+v || 0)));

function pcInfo() {
  const cores = os.cpus().length || 1;
  const totalMb = Math.round(os.totalmem() / MB);
  let diskTotalGb = 0;
  let diskFreeGb = 0;
  try {
    const st = fs.statfsSync(store.paths.data);
    diskTotalGb = Math.floor((st.blocks * st.bsize) / 1073741824);
    diskFreeGb = Math.floor((st.bavail * st.bsize) / 1073741824);
  } catch {}
  return { cores, totalMb, freeMb: Math.round(os.freemem() / MB), diskTotalGb, diskFreeGb };
}

function defaults() {
  return { enabled: false, cpuCores: 0, ramMb: 0, diskGb: 0, priority: 'below', hardRam: false };
}

function maskOf(cores) {
  let m = 0n;
  for (const c of cores) m |= 1n << BigInt(c);
  return m;
}

// Привязка к ядрам на стороне Node: нужна, когда нативное ядро не умеет `limit` (например, старая сборка).
function setAffinityNode(pid, mask) {
  return new Promise((resolve) => {
    if (!pid || !mask) return resolve(false);
    if (isWin) {
      const ps =
        '$m=[IntPtr][long]' + mask.toString() + ';function T($i){try{(Get-Process -Id $i -ErrorAction Stop).ProcessorAffinity=$m}catch{};' +
        'Get-CimInstance Win32_Process -Filter "ParentProcessId=$i" -ErrorAction SilentlyContinue|ForEach-Object{T $_.ProcessId}};T ' + (pid | 0);
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, timeout: 15000 }, (e) => resolve(!e));
    } else {
      execFile('taskset', ['-a', '-p', mask.toString(16), String(pid)], { timeout: 5000 }, (e) => resolve(!e));
    }
  });
}

async function dirSize(root, budgetMs = 8000) {
  const end = Date.now() + budgetMs;
  let total = 0;
  const stack = [root];
  while (stack.length && Date.now() < end) {
    const d = stack.pop();
    let items;
    try {
      items = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    await Promise.all(
      items.map(async (it) => {
        const p = path.join(d, it.name);
        if (it.isSymbolicLink()) return;
        if (it.isDirectory()) stack.push(p);
        else if (it.isFile()) {
          try {
            total += (await fs.promises.stat(p)).size;
          } catch {}
        }
      })
    );
  }
  return Math.round(total / MB);
}

class Capacity {
  constructor(mgr) {
    this.mgr = mgr;
    this.disk = { at: 0, busy: null, per: {}, backupsMb: 0 };
  }

  get cfg() {
    return { ...defaults(), ...(store.config.capacity || {}) };
  }

  budget() {
    const pc = pcInfo();
    const c = this.cfg;
    return {
      enabled: !!c.enabled,
      cpuCores: clampInt(c.cpuCores, 0, pc.cores),
      ramMb: c.ramMb ? clampInt(c.ramMb, 512, pc.totalMb) : 0,
      diskGb: clampInt(c.diskGb, 0, 1000000),
      priority: PRIORITY[c.priority] !== undefined ? c.priority : 'below',
      hardRam: !!c.hardRam,
    };
  }

  isMc(s) {
    return s.game.startsWith('minecraft');
  }

  /** Сколько памяти (МБ) занимает сервер по плану; 0 — неизвестно. */
  ramFor(s) {
    if (this.isMc(s)) return Math.max(512, +s.settings.memory || 2048);
    const lim = s.limits && +s.limits.ramMb;
    if (lim) return lim;
    const g = games[s.game];
    return g && g.ramGB ? g.ramGB * 1024 : 0;
  }

  /** Рекомендуемый минимум памяти для сервера. */
  recMb(s) {
    if (this.isMc(s)) return Math.max(2048, 1024 + MC_PER_PLAYER_MB * (+s.settings.maxPlayers || 10));
    const g = games[s.game];
    return g && g.ramGB ? g.ramGB * 1024 : 1024;
  }

  /** Примерное число игроков, которое потянет выделенная память (Minecraft), иначе null. */
  slots(s) {
    if (!this.isMc(s)) return null;
    return Math.max(0, Math.floor((this.ramFor(s) - 1024) / MC_PER_PLAYER_MB));
  }

  runningServers() {
    return store.state.servers.filter((s) => {
      const r = this.mgr.rt.get(s.id);
      return r && r.child && ['starting', 'running', 'stopping'].includes(r.state);
    });
  }

  /** Раскладка серверов по ядрам: id → { cores, mask, limited }. */
  layout() {
    const pc = pcInfo();
    const b = this.budget();
    const all = Array.from({ length: pc.cores }, (_, i) => i);
    const out = new Map();
    const N = b.enabled && b.cpuCores ? Math.min(b.cpuCores, pc.cores) : pc.cores;
    const limited = b.enabled && N < pc.cores;
    // Бюджет занимает последние N ядер: нулевое ядро остаётся системе и играм
    const set = limited ? all.slice(pc.cores - N) : all;
    let cursor = 0;
    const running = this.runningServers().sort((a, c) => (this.mgr.rt.get(a.id).startedAt || 0) - (this.mgr.rt.get(c.id).startedAt || 0));
    for (const s of running) {
      const k = b.enabled ? clampInt((s.limits && s.limits.cpuCores) || set.length, 1, set.length) : set.length;
      const cores = [];
      for (let j = 0; j < k; j++) cores.push(set[(cursor + j) % set.length]);
      cursor = (cursor + k) % set.length;
      cores.sort((x, y) => x - y);
      out.set(s.id, { cores, mask: maskOf(cores), limited: limited || (b.enabled && k < set.length) });
    }
    return out;
  }

  /** Проверка перед запуском: хватает ли выделенной памяти. */
  checkStart(s) {
    const b = this.budget();
    if (!b.enabled || !b.ramMb) return;
    const need = this.ramFor(s);
    if (!need) return;
    const used = this.runningServers().filter((x) => x.id !== s.id).reduce((a, x) => a + this.ramFor(x), 0);
    if (used + need > b.ramMb) {
      const free = Math.max(0, b.ramMb - used);
      throw Object.assign(
        new Error(`Не хватает выделенной памяти: серверу нужно ${need} МБ, свободно ${free} МБ из ${b.ramMb} МБ. Остановите другой сервер, уменьшите память сервера или увеличьте бюджет на экране «Мощности»`),
        { status: 409 }
      );
    }
  }

  async checkCreate() {
    const b = this.budget();
    if (!b.enabled || !b.diskGb) return;
    await this.refreshDisk(true);
    const used = Object.values(this.disk.per).reduce((a, x) => a + x, 0) + this.disk.backupsMb;
    if (used / 1024 >= b.diskGb) {
      throw Object.assign(new Error(`Выделенное место на диске исчерпано (${(used / 1024).toFixed(1)} из ${b.diskGb} ГБ). Освободите место или увеличьте бюджет на экране «Мощности»`), { status: 409 });
    }
  }

  /** Применяет привязку к ядрам и приоритет к одному запущенному серверу. */
  async applyTo(s) {
    const r = this.mgr.rt.get(s.id);
    if (!r || !r.child) return;
    const pid = r.child.pid;
    const b = this.budget();
    const lay = this.layout().get(s.id);
    if (!lay) return;
    r.cpuSet = lay.limited ? lay.cores : [];
    try {
      os.setPriority(pid, b.enabled ? PRIORITY[b.priority] : 0);
    } catch {}
    const pc = pcInfo();
    const full = maskOf(Array.from({ length: pc.cores }, (_, i) => i));
    const mask = lay.limited ? lay.mask : full;
    this.mgr.core.limit(pid, lay.limited ? mask : 0);
    if (!this.mgr.core.affSupported || !lay.limited) await setAffinityNode(pid, mask);
    this.mgr.emit('state', this.mgr.view(s));
  }

  applyAll() {
    // раскладка зависит от набора запущенных серверов, поэтому пересчитываем для всех
    for (const s of this.runningServers()) this.applyTo(s).catch(() => {});
  }

  /** Вызывается при каждом замере: следит за превышением памяти сверх выделенной. */
  watch(s, r, rssMb) {
    const b = this.budget();
    if (!b.enabled) return;
    const limit = this.ramFor(s);
    if (!limit || !rssMb) return;
    const factor = this.isMc(s) ? 1.4 : 1.25;
    if (rssMb > limit * 1.1 && !r.ramWarned) {
      r.ramWarned = true;
      this.mgr._log(s, 'sys', `Сервер занимает ${rssMb} МБ при выделенных ${limit} МБ`);
    }
    if (b.hardRam && rssMb > limit * factor) {
      r.ramOver = (r.ramOver || 0) + 1;
      if (r.ramOver >= 3 && r.state === 'running') {
        r.ramOver = 0;
        this.mgr._log(s, 'err', `Превышена выделенная память (${rssMb} МБ при лимите ${limit} МБ), останавливаю сервер`);
        this.mgr.stop(s.id);
      }
    } else r.ramOver = 0;
  }

  async refreshDisk(force) {
    if (this.disk.busy) return this.disk.busy;
    if (!force && Date.now() - this.disk.at < 60000) return;
    this.disk.busy = (async () => {
      const per = {};
      for (const s of store.state.servers) per[s.id] = s.imported ? 0 : await dirSize(s.dir);
      const imported = {};
      for (const s of store.state.servers) if (s.imported) imported[s.id] = await dirSize(s.dir, 3000);
      this.disk = { at: Date.now(), busy: null, per, imported, backupsMb: await dirSize(store.paths.backups, 3000) };
    })().catch(() => {
      this.disk.busy = null;
    });
    return this.disk.busy;
  }

  diskMb(s) {
    return (this.disk.per && this.disk.per[s.id]) || (this.disk.imported && this.disk.imported[s.id]) || 0;
  }

  async view() {
    if (!this.disk.at) await Promise.race([this.refreshDisk(true), new Promise((r) => setTimeout(r, 4000))]);
    else this.refreshDisk().catch(() => {});
    const pc = pcInfo();
    const b = this.budget();
    const lay = this.layout();
    const list = store.state.servers.map((s) => {
      const v = this.mgr.view(s);
      const l = lay.get(s.id);
      return {
        id: s.id,
        name: s.name,
        game: s.game,
        state: v.state,
        mc: this.isMc(s),
        ramMb: this.ramFor(s),
        ramKnown: !!this.ramFor(s),
        recMb: this.recMb(s),
        slots: this.slots(s),
        maxPlayers: v.maxPlayers,
        cpuCores: (s.limits && +s.limits.cpuCores) || 0,
        cpuSet: l && l.limited ? l.cores : [],
        rssMb: v.mem || 0,
        cpu: v.cpu || 0,
        diskMb: this.diskMb(s),
        imported: !!s.imported,
      };
    });
    const running = list.filter((x) => ['starting', 'running', 'stopping'].includes(x.state));
    const allocMb = list.reduce((a, x) => a + x.ramMb, 0);
    const runMb = running.reduce((a, x) => a + x.ramMb, 0);
    const usedMb = running.reduce((a, x) => a + x.rssMb, 0);
    const N = b.enabled && b.cpuCores ? b.cpuCores : pc.cores;
    const cpuOfBudget = Math.min(100, Math.round(running.reduce((a, x) => a + x.cpu, 0) * (pc.cores / N)));
    const diskUsedMb = list.reduce((a, x) => a + (x.imported ? 0 : x.diskMb), 0) + (this.disk.backupsMb || 0);
    const warnings = [];
    if (b.enabled) {
      if (b.ramMb && pc.totalMb - b.ramMb < 2048) warnings.push({ code: 'ram-system', text: 'Системе остаётся меньше 2 ГБ памяти: Windows и другие программы могут тормозить. Уменьшите бюджет памяти.' });
      if (b.ramMb && allocMb > b.ramMb) warnings.push({ code: 'ram-alloc', text: `Серверам выделено ${allocMb} МБ при бюджете ${b.ramMb} МБ: все сразу они не запустятся.` });
      if (b.cpuCores && b.cpuCores >= pc.cores && pc.cores > 2) warnings.push({ code: 'cpu-all', text: 'Выделены все ядра: оставьте хотя бы одно для системы и игр.' });
      if (b.diskGb && pc.diskFreeGb && b.diskGb > pc.diskFreeGb + diskUsedMb / 1024) warnings.push({ code: 'disk-free', text: `На диске свободно ${pc.diskFreeGb} ГБ, это меньше выделенных ${b.diskGb} ГБ.` });
      if (b.diskGb && diskUsedMb / 1024 > b.diskGb) warnings.push({ code: 'disk-over', text: 'Серверы и бэкапы занимают больше выделенного места.' });
    }
    if (list.some((x) => !x.ramKnown)) warnings.push({ code: 'ram-unknown', text: 'Для части серверов потребление памяти неизвестно: укажите лимит вручную, чтобы бюджет учитывал их.' });
    return {
      pc,
      budget: b,
      servers: list,
      totals: { allocMb, runMb, usedMb, cpuOfBudget, diskUsedMb, backupsMb: this.disk.backupsMb || 0, budgetCores: N },
      warnings,
      core: { affinity: !!this.mgr.core.affSupported, platform: process.platform },
    };
  }

  /** Сохраняет бюджет и лимиты серверов. */
  set(body) {
    const pc = pcInfo();
    if (body.budget && typeof body.budget === 'object') {
      const c = { ...defaults(), ...(store.config.capacity || {}) };
      const b = body.budget;
      if (typeof b.enabled === 'boolean') c.enabled = b.enabled;
      if (b.cpuCores !== undefined) c.cpuCores = clampInt(b.cpuCores, 0, pc.cores);
      if (b.ramMb !== undefined) c.ramMb = +b.ramMb ? clampInt(b.ramMb, 512, pc.totalMb) : 0;
      if (b.diskGb !== undefined) c.diskGb = clampInt(b.diskGb, 0, 1000000);
      if (b.priority !== undefined) {
        if (PRIORITY[b.priority] === undefined) throw Object.assign(new Error('неизвестный приоритет'), { status: 400 });
        c.priority = b.priority;
      }
      if (typeof b.hardRam === 'boolean') c.hardRam = b.hardRam;
      store.config.capacity = c;
      store.saveConfig();
    }
    if (body.servers && typeof body.servers === 'object') {
      for (const [id, lim] of Object.entries(body.servers)) {
        const s = this.mgr.rec(id);
        s.limits = s.limits || {};
        if (lim.cpuCores !== undefined) s.limits.cpuCores = clampInt(lim.cpuCores, 0, pc.cores);
        if (lim.ramMb !== undefined) {
          const mb = +lim.ramMb ? clampInt(lim.ramMb, 256, pc.totalMb) : 0;
          if (this.isMc(s)) {
            if (mb) this.mgr.update(id, { settings: { memory: Math.max(512, mb) } });
          } else s.limits.ramMb = mb;
        }
      }
      store.saveState();
    }
    this.applyAll();
    for (const s of store.state.servers) this.mgr.emit('state', this.mgr.view(s));
  }

  /** Раскладывает бюджет по серверам пропорционально рекомендуемой памяти. */
  auto() {
    const b = this.budget();
    const pc = pcInfo();
    const servers = store.state.servers;
    if (!servers.length) return;
    const ram = b.enabled && b.ramMb ? b.ramMb : Math.floor(pc.totalMb / 2);
    const N = b.enabled && b.cpuCores ? b.cpuCores : Math.max(1, Math.floor(pc.cores / 2));
    const rec = servers.map((s) => this.recMb(s));
    const sum = rec.reduce((a, x) => a + x, 0);
    const patch = {};
    servers.forEach((s, i) => {
      let mb = Math.floor(((rec[i] / sum) * ram) / 256) * 256;
      mb = Math.max(this.isMc(s) ? 512 : 256, Math.min(mb, rec[i] * 2));
      const share = Math.max(1, Math.min(N, Math.round((rec[i] / sum) * N)));
      patch[s.id] = { ramMb: mb, cpuCores: share };
    });
    this.set({ servers: patch });
  }
}

module.exports = { Capacity };
