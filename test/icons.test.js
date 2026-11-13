'use strict';
// Значки игр: Steam CDN, Википедия, кэш, промахи, свой значок сервера. Внешние сайты заменены локальным сервером.
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

let n = 0;
const ok = (m) => console.log('  ✓', m, `(${++n})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.join(__dirname, '..');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 9)]);
const hits = [];
const mock = http.createServer((req, res) => {
  hits.push(req.url);
  const u = req.url.split('?')[0];
  const send = (type, body) => {
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  };
  if (u === '/steam/apps/105600/library_600x900.jpg') return send('image/jpeg', JPG); // Terraria
  if (u === '/steam/apps/730/header.jpg') return send('image/jpeg', JPG); // CS2: портретной обложки нет, есть широкая
  if (u === '/steam/apps/440/library_600x900.jpg') return send('image/jpeg', Buffer.from('<html>not an image at all, just text</html>')); // подмена: не картинка
  if (u === '/api/rest_v1/page/summary/Minecraft') return send('application/json', JSON.stringify({ thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/en/mc.png', width: 300 } }));
  if (u === '/wikipedia/en/mc.png') return send('image/png', PNG);
  if (u === '/steam/apps/570/library_600x900.jpg') return send('image/jpeg', JPG);
  if (u === '/api/storesearch/') return send('application/json', JSON.stringify({ items: [{ id: 570, name: 'Dota 2' }, { id: 1, name: 'Other' }] }));
  res.writeHead(404);
  res.end();
});

(async () => {
  await new Promise((r) => mock.listen(17180, '127.0.0.1', r));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-icons-'));
  const agent = spawn('node', [path.join(root, 'main.js')], { env: { ...process.env, DATA_DIR: data, PORT: '17181', NO_BROWSER: '1', HEARTH_NO_OPEN: '1', HEARTH_ICON_MOCK: 'http://127.0.0.1:17180' }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  agent.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 60 && !/token=/.test(out); i++) await wait(100);
  const token = /token=([0-9a-f]+)/.exec(out)[1];
  const raw = (p, o = {}) => fetch('http://127.0.0.1:17181' + p, { ...o, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } });
  const api = async (m, p, body) => {
    const r = await raw(p, { method: m, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
  try {
    let r = await raw('/api/games/terraria/icon');
    assert(r.status === 200 && r.headers.get('content-type') === 'image/jpeg' && Buffer.from(await r.arrayBuffer()).equals(JPG));
    assert(fs.existsSync(path.join(data, 'icons', 'game-terraria.jpg')));
    ok('Terraria: обложка Steam скачана, формат jpg, лежит в кэше на диске');

    const before = hits.length;
    r = await raw('/api/games/terraria/icon');
    assert(r.status === 200 && hits.length === before, 'второй запрос идёт из кэша');
    ok('повторный запрос обходится без сети');

    r = await raw('/api/games/cs2/icon');
    assert(r.status === 200 && hits.some((h) => h.includes('/730/library')) && hits.some((h) => h.includes('/730/header')));
    ok('CS2: нет портретной обложки, взята широкая (запасной вариант)');

    r = await raw('/api/games/minecraft-paper/icon');
    assert(r.status === 200 && r.headers.get('content-type') === 'image/png');
    ok('Minecraft: обложка из карточки статьи Википедии');

    r = await raw('/api/games/tf2/icon');
    assert.strictEqual(r.status, 404);
    assert(!fs.existsSync(path.join(data, 'icons', 'game-tf2.jpg')), 'текст под видом картинки не сохраняется');
    ok('ответ, который не картинка (подмена), отклонён по первым байтам');

    const h1 = hits.length;
    await raw('/api/games/tf2/icon');
    assert.strictEqual(hits.length, h1, 'промах запоминается на сутки');
    ok('промах запоминается: сайт не дёргается снова');

    assert.strictEqual((await raw('/api/games/custom/icon')).status, 404);
    assert.strictEqual((await raw('/api/games/нет-такой/icon')).status, 404);
    ok('у своего сервера и неизвестной игры настоящего значка нет (404, панель рисует плитку)');

    // значок сервера
    const sv = (await api('POST', '/api/servers', { game: 'custom', name: 'Mine', command: 'node -e 0', settings: { port: 15999 } })).j;
    assert.strictEqual((await raw(`/api/servers/${sv.id}/icon`)).status, 404);
    const bad = await api('PUT', `/api/servers/${sv.id}/icon`, { dataUrl: 'data:image/png;base64,' + Buffer.from('просто текст, не картинка').toString('base64') });
    assert.strictEqual(bad.s, 400);
    assert.strictEqual((await api('PUT', `/api/servers/${sv.id}/icon`, { dataUrl: 'мусор' })).s, 400);
    ok('свой значок: текст вместо картинки и мусор отклонены');

    const put = await api('PUT', `/api/servers/${sv.id}/icon`, { dataUrl: 'data:image/png;base64,' + PNG.toString('base64') });
    assert(put.s === 200 && put.j.iconRev === 1, JSON.stringify(put.j));
    r = await raw(`/api/servers/${sv.id}/icon`);
    assert(r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(PNG));
    ok('своя картинка сохранена, iconRev вырос (панель перерисует значок)');

    const s2 = (await api('GET', '/api/icons/search?term=dota')).j;
    assert(s2.length === 2 && s2[0].app === 570);
    const st = await api('PUT', `/api/servers/${sv.id}/icon`, { steamApp: 570 });
    assert(st.s === 200 && st.j.iconRev === 2);
    r = await raw(`/api/servers/${sv.id}/icon`);
    assert(Buffer.from(await r.arrayBuffer()).equals(JPG));
    assert.strictEqual((await api('PUT', `/api/servers/${sv.id}/icon`, { steamApp: 999999 })).s, 404);
    assert.strictEqual((await api('PUT', `/api/servers/${sv.id}/icon`, { steamApp: 'x' })).s, 400);
    ok('поиск игры в Steam и выбор её обложки для своего сервера');

    const rs = await api('DELETE', `/api/servers/${sv.id}/icon`);
    assert(rs.s === 200 && rs.j.iconRev === 3);
    assert.strictEqual((await raw(`/api/servers/${sv.id}/icon`)).status, 404);
    ok('сброс возвращает значок игры (у своего сервера: плитку)');

    const tn = (await api('POST', '/api/servers', { game: 'terraria', name: 'T', settings: { port: 15998 } })).j;
    assert.strictEqual((await raw(`/api/servers/${tn.id}/icon`)).status, 200);
    await api('PUT', `/api/servers/${tn.id}/icon`, { dataUrl: 'data:image/png;base64,' + PNG.toString('base64') });
    await api('DELETE', `/api/servers/${tn.id}?files=1`);
    assert(!fs.readdirSync(path.join(data, 'icons')).some((f) => f.startsWith('srv-' + tn.id)), 'свой значок удалён вместе с сервером');
    ok('сервер игры из каталога показывает значок игры; при удалении сервера его свой значок стирается');

    assert.strictEqual((await fetch('http://127.0.0.1:17181/api/games/terraria/icon')).status, 401);
    const viaQuery = await fetch('http://127.0.0.1:17181/api/games/terraria/icon?token=' + token);
    assert.strictEqual(viaQuery.status, 200);
    ok('без токена значок не отдаётся; <img> работает через ?token=');
    console.log(`\nicons: ${n} проверок пройдено`);
    agent.kill();
    mock.close();
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e);
    agent.kill();
    process.exit(1);
  }
})();
