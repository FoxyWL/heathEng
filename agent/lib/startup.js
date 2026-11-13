'use strict';
// Автозапуск Hearth вместе с Windows: запись в HKCU\...\Run (права администратора не нужны).
// Hearth стартует без окна (--startup), серверы с галочкой «автозапуск» поднимаются сами.
const { execFile } = require('child_process');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const NAME = 'Hearth';
const isWin = () => process.platform === 'win32';
const command = () => `"${process.execPath}" --startup`;

const reg = (args) => new Promise((resolve) => {
  execFile('reg', args, { windowsHide: true, timeout: 8000 }, (err, out) => resolve({ ok: !err, out: String(out || '') }));
});

/** Только в собранном exe: из исходников process.execPath указывал бы на node. */
const supported = () => isWin() && require('./runtime').packed;

async function status() {
  if (!supported()) return { supported: false, enabled: false };
  const r = await reg(['query', KEY, '/v', NAME]);
  return { supported: true, enabled: r.ok && /--startup/.test(r.out) };
}

async function set(enabled) {
  if (!supported()) throw Object.assign(new Error('автозапуск доступен в Windows в собранной версии Hearth'), { status: 400 });
  const r = enabled ? await reg(['add', KEY, '/v', NAME, '/t', 'REG_SZ', '/d', command(), '/f']) : await reg(['delete', KEY, '/v', NAME, '/f']);
  if (!r.ok && enabled) throw new Error('не удалось записать автозапуск в реестр');
  return status();
}

module.exports = { status, set, command, KEY, NAME };
