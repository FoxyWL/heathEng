'use strict';
// Где запущен Hearth: из исходников (node) или установленное приложение Electron.
const path = require('path');

const electron = !!process.versions.electron;
// Электрон-приложение из установщика называется Hearth.exe; при разработке это electron(.exe)
const packedElectron = electron && !/^electron(\.exe)?$/i.test(path.basename(process.execPath));

module.exports = {
  electron,
  /** Программа поставляется готовым файлом: данные и автозапуск считаем от exe, а не от рабочей папки. */
  packed: packedElectron || process.env.HEARTH_PACKED === '1',
};
