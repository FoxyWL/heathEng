'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test-' + process.pid);
    fs.writeFileSync(probe, '1');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function pickDataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  const packed = require('./runtime').packed;
  const baseDir = packed ? path.dirname(process.execPath) : process.cwd();
  const appData = process.platform === 'win32' ? path.join(process.env.APPDATA || require('os').homedir(), 'Hearth') : path.join(require('os').homedir(), '.hearth');
  // Установленная версия (файл installed.flag кладёт установщик) хранит данные в профиле пользователя,
  // чтобы они переживали обновление и удаление программы.
  if (packed && fs.existsSync(path.join(baseDir, 'installed.flag'))) return path.resolve(appData);
  const beside = path.join(baseDir, 'data');
  if (writable(beside)) return beside;
  return path.resolve(appData);
}

const DATA_DIR = pickDataDir();
fs.mkdirSync(DATA_DIR, { recursive: true });

const paths = {
  data: DATA_DIR,
  config: path.join(DATA_DIR, 'config.json'),
  state: path.join(DATA_DIR, 'state.json'),
  servers: path.join(DATA_DIR, 'servers'),
  backups: path.join(DATA_DIR, 'backups'),
  runtime: path.join(DATA_DIR, 'runtime'),
};
for (const k of ['servers', 'backups', 'runtime']) fs.mkdirSync(paths[k], { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

const config = readJson(paths.config, {});
config.panelToken = config.panelToken || crypto.randomBytes(16).toString('hex');
config.lang = config.lang || 'ru';
config.relay = { enabled: false, host: '', port: 7000, token: '', name: 'hearth', autoDiscover: true, srvName: '', ...(config.relay || {}) };
config.beta = { anyZone: true, ...(config.beta || {}) }; // бета для администратора (пока им считается владелец этого ПК): свои зоны вроде .mc
config.net = { lastIp: '', preferred: '', ...(config.net || {}) };
config.ai = config.ai || { enabled: false, apiKey: '', model: 'claude-sonnet-5-5' };

const state = readJson(paths.state, { servers: [], tasks: [], tunnels: [] });
state.servers = state.servers || [];
state.tasks = state.tasks || [];
state.tunnels = state.tunnels || [];

let saveTimer = null;
function saveConfig() {
  writeJson(paths.config, config);
}
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson(paths.state, state), 150);
}
function flush() {
  clearTimeout(saveTimer);
  writeJson(paths.state, state);
  saveConfig();
}
saveConfig();

function uid(prefix) {
  return prefix + '-' + crypto.randomBytes(4).toString('hex');
}

module.exports = { paths, config, state, saveConfig, saveState, flush, uid };
