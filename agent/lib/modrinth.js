'use strict';
// Онлайн-поиск плагинов и модов Minecraft в каталоге Modrinth (api.modrinth.com, без ключа).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { downloadFile } = require('./download');

const API = () => process.env.HEARTH_MODRINTH_API || 'https://api.modrinth.com/v2';
const UA = 'hearth-game-server-manager/1.2 (self-hosted)';

// Какие загрузчики подходят каждой сборке сервера
const LOADERS = {
  'minecraft-paper': ['paper', 'spigot', 'bukkit'],
  'minecraft-purpur': ['purpur', 'paper', 'spigot', 'bukkit'],
  'minecraft-folia': ['folia'],
  'minecraft-fabric': ['fabric'],
};

async function get(pathAndQuery) {
  const r = await fetch(API() + pathAndQuery, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (r.status === 429) throw Object.assign(new Error('Modrinth просит подождать (слишком много запросов)'), { status: 429 });
  if (!r.ok) throw Object.assign(new Error('Modrinth ответил HTTP ' + r.status), { status: 502 });
  return r.json();
}

function supports(game) {
  return !!LOADERS[game];
}

// "1.21.4" → годится для фильтра версии; "26.2" и прочие схемы тоже передаются как есть
function gameVersion(v) {
  return /^\d+(\.\d+){1,2}$/.test(v || '') ? v : '';
}

async function search({ game, version, q }) {
  const loaders = LOADERS[game];
  if (!loaders) throw Object.assign(new Error('для этой сборки онлайн-каталог недоступен'), { status: 400 });
  const facets = [['project_type:mod'], loaders.map((l) => 'categories:' + l)];
  const gv = gameVersion(version);
  if (gv) facets.push(['versions:' + gv]);
  const qs = new URLSearchParams({ query: String(q || '').slice(0, 80), limit: '20', index: q ? 'relevance' : 'downloads', facets: JSON.stringify(facets) });
  const d = await get('/search?' + qs);
  return (d.hits || []).map((h) => ({
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    author: h.author,
    downloads: h.downloads,
    icon: h.icon_url || '',
    updated: h.date_modified || '',
    categories: (h.display_categories || h.categories || []).slice(0, 4),
  }));
}

// Скачивает свежую совместимую версию в папку плагинов; проверяет контрольную сумму SHA-1
async function install({ game, version, project, destDir }) {
  const loaders = LOADERS[game];
  if (!loaders) throw Object.assign(new Error('для этой сборки онлайн-каталог недоступен'), { status: 400 });
  if (!/^[A-Za-z0-9]{5,16}$/.test(project || '')) throw Object.assign(new Error('некорректный идентификатор проекта'), { status: 400 });
  const gv = gameVersion(version);
  const qs = new URLSearchParams({ loaders: JSON.stringify(loaders) });
  if (gv) qs.set('game_versions', JSON.stringify([gv]));
  const versions = await get(`/project/${project}/version?` + qs);
  if (!versions.length) throw Object.assign(new Error('нет версии, совместимой с вашим сервером' + (gv ? ' (' + gv + ')' : '')), { status: 404 });
  const pick = versions.find((v) => v.version_type === 'release') || versions[0];
  const file = (pick.files || []).find((f) => f.primary) || (pick.files || [])[0];
  if (!file || !file.url) throw Object.assign(new Error('у версии нет файла'), { status: 502 });
  const name = path.basename(String(file.filename || ''));
  if (!/\.jar$/i.test(name) || /[\\/:*?"<>|]/.test(name)) throw Object.assign(new Error('неподходящее имя файла: ' + name), { status: 502 });
  const u = new URL(file.url);
  if (u.protocol !== 'https:' && !process.env.HEARTH_MODRINTH_API) throw Object.assign(new Error('небезопасная ссылка на файл'), { status: 502 });
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, name);
  await downloadFile(file.url, dest);
  const want = file.hashes && file.hashes.sha1;
  if (want) {
    const got = crypto.createHash('sha1').update(fs.readFileSync(dest)).digest('hex');
    if (got !== want) {
      fs.rmSync(dest, { force: true });
      throw Object.assign(new Error('контрольная сумма файла не совпала: загрузка отменена'), { status: 502 });
    }
  }
  return { name, version: pick.version_number, size: fs.statSync(dest).size };
}

module.exports = { search, install, supports };
