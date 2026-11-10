'use strict';
// Проверка нативного ядра (Rust): CPU и память дерева процессов, исчезновение процесса, запасной режим.
const { spawn } = require('child_process');
const assert = require('assert');
const { Core } = require('../agent/lib/core');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (m) => console.log('  ✓', m, `(${++n})`);

(async () => {
  process.env.HEARTH_STATS_MS = '500';
  // дерево: sh → (цикл + node с 60 МБ)
  const p = spawn('sh', ['-c', '(while :; do :; done) & node -e "const b=Buffer.alloc(60*1024*1024,1);setTimeout(()=>{},20000)"; wait'], { stdio: 'ignore' });
  const core = new Core(require('os').tmpdir());
  core.start();
  assert(core.ok, 'ядро должно запуститься');
  ok('ядро запущено');
  const got = [];
  core.on('stats', (items) => got.push(...items));
  core.watch([p.pid, 2147483000]);
  await wait(3500);
  const mine = got.filter((i) => i.pid === p.pid && !i.gone);
  assert(mine.length >= 3, 'ожидали несколько замеров, получили ' + mine.length);
  const last = mine[mine.length - 1];
  assert(last.procs >= 3, 'в дереве должно быть ≥3 процессов, а не ' + last.procs);
  ok('считает всё дерево процессов: ' + last.procs + ' шт.');
  assert(last.rss > 60 * 1024 * 1024, 'память дерева > 60 МБ: ' + last.rss);
  ok('память дерева: ' + Math.round(last.rss / 1048576) + ' МБ');
  const cores = (core.sys && core.sys.cores) || 1;
  assert(last.cpu > 40 / cores && last.cpu <= 100, `CPU занятого ядра ≈ ${(100 / cores).toFixed(0)}%, получили ${last.cpu}`);
  ok(`CPU: ${last.cpu}% из 100% (ядер: ${cores})`);
  assert(got.some((i) => i.pid === 2147483000 && i.gone), 'несуществующий PID помечается gone');
  ok('несуществующий процесс помечен gone');
  p.kill('SIGKILL');
  try { require('child_process').execSync('pkill -f "while :" || true'); } catch {}
  got.length = 0;
  await wait(1800);
  assert(got.some((i) => i.pid === p.pid && i.gone), 'завершённый процесс помечается gone');
  ok('завершённый процесс помечен gone');
  core.stop();
  await wait(300);
  assert(!core.child, 'ядро остановлено');
  ok('ядро останавливается');

  // запасной режим: ядра нет — Core не должен падать
  process.env.HEARTH_CORE = 'off';
  const off = new Core(require('os').tmpdir());
  off.start();
  assert.strictEqual(off.ok, false);
  off.watch([1]);
  ok('без ядра: тихо переключается на запасной режим');
  console.log(`\ncore: ${n} проверок пройдено`);
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
