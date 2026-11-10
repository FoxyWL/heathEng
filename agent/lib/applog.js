'use strict';
// Дублирует вывод консоли в data/hearth.log. Нужен, когда у программы нет окна консоли (установленная версия).
const fs = require('fs');
const path = require('path');
const util = require('util');

function init(dataDir) {
  const file = path.join(dataDir, 'hearth.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + '.old');
  } catch {}
  let broken = false;
  const write = (line) => {
    if (broken) return;
    try {
      fs.appendFileSync(file, line);
    } catch {
      broken = true;
    }
  };
  for (const k of ['log', 'error', 'warn']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => {
      try {
        write(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${util.format(...a)}\n`);
      } catch {}
      try {
        orig(...a);
      } catch {}
    };
  }
  return file;
}

module.exports = { init };
