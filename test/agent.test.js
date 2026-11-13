'use strict';
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const base = 'http://127.0.0.1:17788';
let token = '';
const results = [];
const ok = (n, c, extra) => {
  results.push(!!c);
  console.log((c ? 'PASS ' : 'FAIL ') + n + (extra !== undefined ? '  ' + extra : ''));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, p, body) => {
  const r = await fetch(base + p, { method: m, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
};
const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await wait(150);
  }
  return false;
};

const relay = spawn('node', [path.join(root, 'relay/relay.js')], {
  env: { ...process.env, RELAY_TOKEN: 'rt', CONTROL_PORT: '17001', HTTP_PORT: '18081', RELAY_DOMAIN: 'tun.test', PUBLIC_HOST: '127.0.0.1', PORT_MIN: '32000', PORT_MAX: '32100', BIND: '127.0.0.1' },
  stdio: 'ignore',
});
const agent = spawn('node', [path.join(root, 'agent/server.js')], {
  env: { ...process.env, DATA_DIR: data, PORT: '17788' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let out = '';
agent.stdout.on('data', (d) => {
  out += d;
});

async function main() {
  await until(() => /token=([0-9a-f]+)/.test(out), 5000);
  token = /token=([0-9a-f]+)/.exec(out)[1];

  const noAuth = await fetch(base + '/api/servers');
  ok('api requires token', noAuth.status === 401);
  const hostStatus = await new Promise((res) => {
    const rq = require('http').request({ host: '127.0.0.1', port: 17788, path: '/', headers: { host: 'evil.example' } }, (r) => {
      r.resume();
      res(r.statusCode);
    });
    rq.on('error', () => res(0));
    rq.end();
  });
  ok('foreign Host header is refused (DNS-rebinding guard)', hostStatus === 403, 'status ' + hostStatus);
  const page = await fetch(base + '/');
  ok('static page served', page.status === 200 && (await page.text()).includes('/js/boot.js'));
  const js = await fetch(base + '/js/boot.js');
  ok('ES modules are served as JavaScript', js.status === 200 && /javascript/.test(js.headers.get('content-type') || ''));
  const trav = await fetch(base + '/..%2f..%2fpackage.json').catch(() => null);
  ok('path traversal outside web/ is refused', !trav || trav.status !== 200);

  const sys = await api('GET', '/api/system');
  ok('system info', sys.status === 200 && sys.j.version, JSON.stringify(sys.j.java));
  const cat = await api('GET', '/api/catalog');
  ok('catalog has games', cat.j.length >= 3, cat.j.map((g) => g.id).join(','));

  const created = await api('POST', '/api/servers', { game: 'custom', name: 'Fake', settings: { command: `node ${path.join(root, 'test/fake-game.js')} 15555`, port: 15555, protocol: 'tcp', stopCommand: 'stop' } });
  ok('create custom server', created.status === 200 && created.j.id, created.j.id);
  const id = created.j.id;

  await api('POST', `/api/servers/${id}/start`);
  ok('server reaches running', await until(async () => (await api('GET', `/api/servers/${id}`)).j.state === 'running'));
  await api('POST', `/api/servers/${id}/command`, { text: 'hello' });
  await wait(300);
  const logs = (await api('GET', `/api/servers/${id}/logs`)).j;
  ok('console captures stdout + input echo', logs.some((l) => l.text === 'echo hello') && logs.some((l) => l.k === 'in'));
  ok('stderr tagged as err', logs.some((l) => l.k === 'err' && /ERROR sample/.test(l.text)));
  const found = (await api('GET', `/api/servers/${id}/logs?search=ECHO`)).j;
  ok('log search is case-insensitive', found.length >= 1 && found.every((l) => /echo/i.test(l.text)));
  const errs = (await api('GET', `/api/servers/${id}/logs?errors=1`)).j;
  ok('errors filter', errs.length >= 1 && errs.every((l) => l.k === 'err' || /ERROR|Exception/.test(l.text)));

  await api('PATCH', `/api/servers/${id}`, { autoRestart: true });
  await api('POST', `/api/servers/${id}/command`, { text: 'crash' });
  ok('crash is detected', await until(async () => (await api('GET', `/api/servers/${id}`)).j.state === 'crashed', 5000));
  ok('auto-restart brings it back', await until(async () => (await api('GET', `/api/servers/${id}`)).j.state === 'running', 10000));

  const f1 = await api('PUT', `/api/servers/${id}/file?path=configs/a.txt`, { text: 'line1\nline2' });
  const f2 = await api('GET', `/api/servers/${id}/file?path=configs/a.txt`);
  ok('file write/read', f1.status === 200 && f2.j.text === 'line1\nline2');
  const ls = await api('GET', `/api/servers/${id}/files?path=`);
  ok('file listing', ls.j.items.some((i) => i.name === 'configs' && i.dir));
  const esc = await api('GET', `/api/servers/${id}/file?path=../../config.json`);
  ok('path traversal blocked', esc.status === 400, esc.j.error);
  await api('POST', `/api/servers/${id}/rename`, { from: 'configs/a.txt', to: 'configs/b.txt' });
  ok('rename', (await api('GET', `/api/servers/${id}/file?path=configs/b.txt`)).status === 200);
  await api('DELETE', `/api/servers/${id}/file?path=configs`);
  ok('delete', (await api('GET', `/api/servers/${id}/files?path=`)).j.items.every((i) => i.name !== 'configs'));

  const badCron = await api('POST', '/api/tasks', { serverId: id, cron: '*/x * * * *', action: 'backup' });
  ok('bad cron rejected', badCron.status === 400, badCron.j.error);
  const task = await api('POST', '/api/tasks', { serverId: id, cron: '*/5 3 * * 1-5', action: 'backup', name: 'Night', keep: 2 });
  ok('task created with next run', task.status === 200 && task.j.next > Date.now(), new Date(task.j.next).toISOString());
  await api('POST', `/api/tasks/${task.j.id}/run`);
  await api('POST', `/api/tasks/${task.j.id}/run`);
  await wait(200);
  await api('POST', `/api/tasks/${task.j.id}/run`);
  const bk = (await api('GET', `/api/servers/${id}/backups`)).j;
  ok('backups created and rotated to keep=2', bk.length === 2 && bk.every((b) => b.size > 0), bk.length + ' files');

  const rl = await api('PUT', '/api/relay', { enabled: true, host: '127.0.0.1', port: 17001, token: 'rt', name: 'tester' });
  ok('relay configured', rl.status === 200);
  await api('PATCH', `/api/servers/${id}`, { tunnel: { enabled: true, protocol: 'tcp' } });
  let addr = null;
  await until(async () => {
    const t = (await api('GET', '/api/tunnels')).j;
    addr = (t.tunnels.find((x) => x.serverId === id) || {}).info;
    return addr;
  }, 6000);
  ok('server tunnel gets public address', !!addr, addr && addr.url);
  if (addr) {
    const reply = await new Promise((res) => {
      const s = net.connect(addr.port, '127.0.0.1', () => s.write('ping'));
      s.on('data', (d) => {
        res(d.toString());
        s.destroy();
      });
      s.on('error', () => res('err'));
    });
    ok('game traffic flows through tunnel', reply === 'world:ping', reply);
  }

  const ext = await api('POST', '/api/tunnels', { proto: 'http', localPort: 15555, subdomain: 'dev', name: 'Dev site' });
  ok('standalone tunnel for any port', ext.j.tunnels.some((t) => t.kind === 'port'));
  const ai = await api('POST', '/api/ai/explain', { text: 'boom' });
  ok('AI off by default', ai.status === 403, ai.j.error);

  await api('POST', `/api/servers/${id}/stop`);
  ok('graceful stop', await until(async () => (await api('GET', `/api/servers/${id}`)).j.state === 'stopped', 8000));

  const imp = await api('POST', '/api/servers', { game: 'minecraft-paper', importDir: data, name: 'Imported' });
  ok('import existing folder keeps it in place', imp.status === 200 && imp.j.dir === data && imp.j.imported);
  const noEula = await api('POST', `/api/servers/${imp.j.id}/start`);
  ok('MC start blocked until EULA accepted', noEula.status === 400, noEula.j.error);

  const del = await api('DELETE', `/api/servers/${id}?files=1`);
  ok('delete server', del.status === 200 && fs.existsSync(path.join(data, 'servers', id)) === false);

  // ---- полное удаление: работающий сервер, папка, бэкапы, туннели
  {
    const sv = await api('POST', '/api/servers', { game: 'custom', name: 'ToDelete', command: 'node -e "setInterval(()=>{},1000)"', settings: { port: 15888 } });
    const rid = sv.j.id;
    const dir = path.join(data, 'servers', rid);
    fs.writeFileSync(path.join(dir, 'world.dat'), Buffer.alloc(2 * 1048576));
    fs.mkdirSync(path.join(data, 'backups', rid), { recursive: true });
    fs.writeFileSync(path.join(data, 'backups', rid, 'old.tar.gz'), Buffer.alloc(1048576));
    await api('POST', `/api/servers/${rid}/start`);
    await until(async () => (await api('GET', `/api/servers/${rid}`)).j.state === 'running');
    await api('POST', '/api/tunnels', { serverId: rid, name: 'extra', protocol: 'tcp', localPort: 15889 });
    const keep = await api('DELETE', `/api/servers/${rid}`);
    ok('delete without files keeps the folder and backups', keep.status === 200 && fs.existsSync(dir) && fs.existsSync(path.join(data, 'backups', rid)) && keep.j.kept.includes(dir));
    const sv2 = await api('POST', '/api/servers', { game: 'custom', name: 'ToDelete2', command: 'node -e "setInterval(()=>{},1000)"', settings: { port: 15890 } });
    const rid2 = sv2.j.id;
    const dir2 = path.join(data, 'servers', rid2);
    fs.writeFileSync(path.join(dir2, 'world.dat'), Buffer.alloc(3 * 1048576));
    fs.mkdirSync(path.join(data, 'backups', rid2), { recursive: true });
    fs.writeFileSync(path.join(data, 'backups', rid2, 'b.tar.gz'), Buffer.alloc(1048576));
    await api('POST', `/api/servers/${rid2}/start`);
    await until(async () => (await api('GET', `/api/servers/${rid2}`)).j.state === 'running');
    const full = await api('DELETE', `/api/servers/${rid2}?files=1`);
    ok('delete with files of a RUNNING server removes folder, backups and reports the freed space', full.status === 200 && !fs.existsSync(dir2) && !fs.existsSync(path.join(data, 'backups', rid2)) && full.j.freedMb >= 4 && full.j.leftover.length === 0, JSON.stringify(full.j).slice(0, 160));
    const left = (await api('GET', '/api/servers')).j.filter((x) => x.id === rid2 || x.id === rid);
    ok('removed servers disappear from the list', left.length === 0);
  }

  agent.kill('SIGINT');
  relay.kill();
  await wait(500);
  fs.rmSync(data, { recursive: true, force: true });
  console.log(results.filter(Boolean).length + '/' + results.length + ' passed');
  process.exit(results.every(Boolean) ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  agent.kill();
  relay.kill();
  process.exit(1);
});
