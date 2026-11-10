'use strict';
// Подготавливает базовый node.exe для pkg: значок Hearth, имя и версия в свойствах файла
// (диспетчер задач показывает "Hearth", а не "Node.js"), режим "окно без консоли".
// Оригинал из кэша pkg не меняется (pkg проверяет его хеш); результат кладётся в build/node-win-x64.exe
// и подключается переменной PKG_PRECOMPILED_BINARY.
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('resedit');

const pkg = require('../package.json');
const gui = process.argv.includes('--console') ? false : true;

function findBase() {
  const root = process.env.PKG_CACHE_PATH || path.join(os.homedir(), '.pkg-cache');
  for (const v of fs.readdirSync(root)) {
    const d = path.join(root, v);
    for (const f of fs.readdirSync(d)) if (/^fetched-v22.*-win-x64$/.test(f)) return path.join(d, f);
  }
  throw new Error('не найден базовый node для win-x64: сначала запустите pkg один раз');
}

const base = findBase();
const orig = base + '.orig';
if (!fs.existsSync(orig)) fs.copyFileSync(base, orig);
const outFile = path.join(__dirname, '..', 'build', 'node-win-x64.exe');

const exe = R.NtExecutable.from(fs.readFileSync(orig), { ignoreCert: true });
const res = R.NtExecutableResource.from(exe);
const ico = R.Data.IconFile.from(fs.readFileSync(path.join(__dirname, '..', 'build', 'hearth.ico')));
const groups = R.Resource.IconGroupEntry.fromEntries(res.entries);
const gid = groups.length ? groups[0].id : 1;
const glang = groups.length ? groups[0].lang : 1033;
R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, gid, glang, ico.icons.map((i) => i.data));

const vis = R.Resource.VersionInfo.fromEntries(res.entries);
const vi = vis.length ? vis[0] : R.Resource.VersionInfo.createEmpty();
const [maj, min, pat] = pkg.version.split('.').map(Number);
vi.setFileVersion(maj, min, pat || 0, 0);
vi.setProductVersion(maj, min, pat || 0, 0);
vi.setStringValues(
  { lang: 1033, codepage: 1200 },
  {
    FileDescription: 'Hearth — менеджер игровых серверов',
    ProductName: 'Hearth',
    CompanyName: 'Hearth',
    LegalCopyright: 'MIT License',
    OriginalFilename: 'hearth.exe',
    InternalName: 'hearth',
    FileVersion: pkg.version,
    ProductVersion: pkg.version,
  }
);
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
let out = Buffer.from(exe.generate());
const pe = out.readUInt32LE(0x3c);
out.writeUInt16LE(gui ? 2 : 3, pe + 24 + 68); // Subsystem: 2 = GUI, 3 = CUI
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, out);
console.log(`базовый node.exe подготовлен (${gui ? 'без консоли' : 'с консолью'}): ${outFile}`);
