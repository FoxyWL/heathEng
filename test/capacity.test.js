'use strict';
// Бюджет мощностей: пресеты, проверка памяти при запуске, привязка к ядрам и приоритет, диск, автораспределение,
// наблюдатель памяти, каталоги модов и безопасное открытие ссылок.
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const PORT = '17140';
const base = `http://127.0.0.1:${PORT}`;
let n = 0;
const ok = (m) => console.log('  ✓', m, `(${++n})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-cap-'));
const mkMc = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-capmc-'));
  fs.writeFileSync(path.join(d, 'server.jar'), 'x');
  return d;
};

const agent = spawn('node', [path.join(root, 'main.js')], {
  env: { ...process.env, DATA_DIR: data, PORT, NO_BROWSER: '1', HEARTH_NO_OPEN: '1', HEARTH_STATS_MS: '500', PATH: path.join(__dirname, 'fakebin') + path.delimiter + process.env.PATH },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let out = '';
agent.stdout.on('data', (d) => (out += d));

async function api(method, p, body) {
  const token = /token=([0-9a-f]+)/.exec(out)[1];
  const r = await fetch(base + p, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { s: r.status, j };
}
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('таймаут: ' + what);
    await wait(150);
  }
}
const maskOf = (pid) => parseInt(/mask: (\w+)/.exec(execFileSync('taskset', ['-p', String(pid)]).toString())[1], 16);
const niceOf = (pid) => +execFileSync('ps', ['-o', 'ni=', '-p', String(pid)]).toString().trim();

(async () => {
  try {
    await until(() => /token=/.test(out), 8000, 'запуск агента');

    // ---- обзор и пресеты
    const c0 = (await api('GET', '/api/capacity')).j;
    assert(c0.pc.cores >= 1 && c0.pc.totalMb > 0, 'сведения о ПК');
    assert.strictEqual(c0.budget.enabled, false);
    ok('бюджет по умолчанию выключен, сведения о ПК есть');

    const pc = c0.pc;
    for (const pct of [25, 50, 100]) {
      const want = { enabled: true, cpuCores: Math.max(1, Math.round((pc.cores * pct) / 100)), ramMb: Math.min(pc.totalMb, Math.max(512, Math.round((pc.totalMb * pct) / 100 / 256) * 256)), diskGb: 0 };
      const r = await api('PUT', '/api/capacity', { budget: want });
      assert.strictEqual(r.s, 200);
      assert.strictEqual(r.j.budget.cpuCores, want.cpuCores);
      assert.strictEqual(r.j.budget.ramMb, want.ramMb);
      assert.strictEqual(r.j.budget.enabled, true);
    }
    ok('пресеты 25 / 50 / 100% сохраняются и читаются обратно');

    assert.strictEqual((await api('PUT', '/api/capacity', { budget: { priority: 'turbo' } })).s, 400);
    const huge = (await api('PUT', '/api/capacity', { budget: { ramMb: 99999999, cpuCores: 9999 } })).j;
    assert(huge.budget.ramMb <= pc.totalMb && huge.budget.cpuCores <= pc.cores);
    ok('неверные значения: приоритет отклоняется, числа ограничиваются размерами ПК');

    // ---- два Minecraft-сервера и проверка памяти
    const mk = async (name, memory) => (await api('POST', '/api/servers', { game: 'minecraft-paper', name, importDir: mkMc(), settings: { acceptEula: true, memory } })).j;
    const a = await mk('A', 2048);
    const b = await mk('B', 2048);
    await api('PUT', '/api/capacity', { budget: { enabled: true, ramMb: Math.min(3072, pc.totalMb), cpuCores: 1, priority: 'below', diskGb: 0 } });
    if (pc.totalMb >= 3072) {
      assert.strictEqual((await api('POST', `/api/servers/${a.id}/start`)).s, 200);
      const r = await api('POST', `/api/servers/${b.id}/start`);
      assert.strictEqual(r.s, 409);
      assert(/Не хватает выделенной памяти/.test(r.j.error || r.j.message || JSON.stringify(r.j)), JSON.stringify(r.j));
      ok('второй сервер не запускается сверх бюджета памяти (409 с понятным текстом)');
    } else ok('бюджет памяти: пропущено, мало памяти на машине');

    // ---- привязка к ядрам и приоритет у запущенного
    await until(async () => (await api('GET', `/api/servers/${a.id}`)).j.state === 'running', 20000, 'сервер A запущен');
    const lastCore = pc.cores - 1;
    if (pc.cores > 1) {
      const pid = (await api('GET', `/api/servers/${a.id}`)).j.pid;
      await until(() => maskOf(pid) === 1 << lastCore, 10000, 'маска ядер = последнее ядро');
      const view = (await api('GET', `/api/servers/${a.id}`)).j;
      assert.deepStrictEqual(view.cpuSet, [lastCore]);
      assert.strictEqual(niceOf(pid), 10);
      ok(`сервер привязан к ядру ${lastCore}, приоритет «ниже обычного» (nice 10)`);
      await api('PUT', '/api/capacity', { budget: { enabled: false } });
      await until(() => maskOf(pid) === (1 << pc.cores) - 1, 10000, 'маска снята');
      ok('при выключении бюджета привязка к ядрам снимается');
    } else ok('привязка к ядрам: пропущено, одно ядро');

    // ---- распределение
    await api('PUT', '/api/capacity', { budget: { enabled: true, ramMb: Math.min(3072, pc.totalMb), cpuCores: 1 } });
    await api('POST', `/api/servers/${a.id}/stop`);
    await until(async () => (await api('GET', `/api/servers/${a.id}`)).j.state === 'stopped', 20000, 'A остановлен');
    const auto = (await api('POST', '/api/capacity/auto')).j;
    const sum = auto.servers.reduce((x, s) => x + s.ramMb, 0);
    assert(sum <= auto.budget.ramMb, `сумма ${sum} должна уложиться в ${auto.budget.ramMb}`);
    assert(auto.servers.every((s) => s.ramMb >= 512));
    ok('автораспределение укладывается в бюджет памяти');

    // после освобождения памяти запуск B проходит
    if (pc.totalMb >= 3072) {
      assert.strictEqual((await api('POST', `/api/servers/${b.id}/start`)).s, 200);
      ok('после остановки A сервер B запускается');
      await api('POST', `/api/servers/${b.id}/kill`);
    }

    // ---- диск
    await api('PUT', '/api/capacity', { budget: { enabled: true, diskGb: 1 } });
    const spec = { game: 'custom', name: 'Big', command: 'node -e 0' };
    const first = await api('POST', '/api/servers', spec);
    assert.strictEqual(first.s, 200, JSON.stringify(first.j));
    fs.writeFileSync(path.join(data, 'servers', first.j.id, 'big.bin'), '');
    fs.truncateSync(path.join(data, 'servers', first.j.id, 'big.bin'), 1200 * 1048576);
    const blocked = await api('POST', '/api/servers', spec);
    assert.strictEqual(blocked.s, 409);
    assert(/Выделенное место на диске исчерпано/.test(JSON.stringify(blocked.j)));
    const afterView = (await api('GET', '/api/capacity')).j;
    assert(afterView.totals.diskUsedMb >= 1200 && afterView.warnings.some((w) => w.code === 'disk-over'));
    ok('диск: сервер сверх выделенного места не создаётся, предупреждение показано');
    await api('PUT', '/api/capacity', { budget: { diskGb: 0 } });
    assert.strictEqual((await api('POST', '/api/servers', spec)).s, 200);
    ok('без лимита диска создание снова работает');

    // ---- каталоги и ссылки
    const cat = (await api('GET', '/api/catalog')).j;
    assert(cat.every((g) => Array.isArray(g.sources) && g.sources.length), 'у каждой игры есть каталоги');
    const paper = cat.find((g) => g.id === 'minecraft-paper');
    assert(paper.sources[0].id === 'modrinth' && paper.sources[0].primary && /modrinth\.com/.test(paper.sources[0].url));
    assert(cat.find((g) => g.id === 'valheim').sources.some((s) => /thunderstore/.test(s.url)));
    assert(cat.find((g) => g.id === 'rust').sources.some((s) => /umod\.org/.test(s.url)));
    ok('у всех 26 игр есть каталоги: Modrinth для Minecraft, Thunderstore для Valheim, uMod для Rust');
    assert.strictEqual((await api('POST', '/api/open-url', { url: paper.sources[0].url })).s, 200);
    for (const bad of ['https://evil.example/', 'file:///etc/passwd', 'javascript:alert(1)', 'https://modrinth.com/plugins&calc']) {
      assert.strictEqual((await api('POST', '/api/open-url', { url: bad })).s, 400, bad);
    }
    ok('открываются только ссылки из списка каталогов');

    agent.kill();
    // ---- наблюдатель памяти (без запуска процессов)
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-capw-'));
    const store = require('../agent/lib/store');
    const { Capacity } = require('../agent/lib/capacity');
    const logs = [];
    const stops = [];
    const s = { id: 'srv-w', game: 'rust', settings: {}, limits: { ramMb: 1000 } };
    store.config.capacity = { enabled: true, ramMb: 4096, hardRam: true };
    const mgr = { rt: new Map(), _log: (x, k, t) => logs.push(t), stop: (id) => stops.push(id), emit() {} };
    const cap = new Capacity(mgr);
    const r = { state: 'running' };
    cap.watch(s, r, 1150);
    assert(logs.length === 1 && /1150/.test(logs[0]), 'предупреждение о превышении');
    cap.watch(s, r, 1160);
    assert.strictEqual(logs.length, 1, 'предупреждение один раз');
    for (let i = 0; i < 2; i++) cap.watch(s, r, 1400);
    assert.strictEqual(stops.length, 0, 'две выборки ещё не повод останавливать');
    cap.watch(s, r, 1400);
    assert.deepStrictEqual(stops, ['srv-w']);
    r.ramOver = 0;
    cap.watch(s, r, 1400);
    cap.watch(s, r, 900);
    cap.watch(s, r, 1400);
    cap.watch(s, r, 1400);
    assert.strictEqual(stops.length, 1, 'всплеск прерывается нормальным замером');
    store.config.capacity = { enabled: true, ramMb: 4096, hardRam: false };
    for (let i = 0; i < 5; i++) cap.watch(s, { state: 'running' }, 5000);
    assert.strictEqual(stops.length, 1, 'без строгого режима сервер не трогаем');
    ok('наблюдатель памяти: предупреждает, останавливает после трёх подряд, не срабатывает на всплеск и без строгого режима');

    console.log(`\ncapacity: ${n} проверок пройдено`);
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e);
    agent.kill();
    process.exit(1);
  }
})();
