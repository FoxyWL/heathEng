'use strict';
// Пересобирает блоки импортов в web/js/*.js: ищет, какие экспортируемые имена других модулей использует файл.
// Запуск: node scripts/web-imports.js (после добавления или переименования функций).
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'web', 'js');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
const strip = (t) => t.replace(/\/\/ @imports:start[\s\S]*?\/\/ @imports:end/, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const exp = {};
for (const f of files) for (const m of src[f].matchAll(/^export (?:async )?(?:function|const|let|class) ([\w$]+)/gm)) exp[m[1]] = f;
for (const f of files) {
  const body = strip(src[f]);
  const by = {};
  for (const [name, from] of Object.entries(exp)) {
    if (from === f) continue;
    if (new RegExp('^(?:export )?(?:async )?(?:function|const|let|class) ' + name + '\\b', 'm').test(body)) continue;
    const n = name.replace(/\$/g, '\\$');
    const used = body
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''")
      .replace(new RegExp('(?:const|let|var|function) ' + n + '\\b', 'g'), '');
    if (!new RegExp('(?<![\\w$.])' + n + '(?![\\w$])(?!\\s*:(?!:))').test(used)) continue;
    (by[from] = by[from] || []).push(name);
  }
  const lines = Object.entries(by).sort().map(([from, names]) => `import { ${names.sort().join(', ')} } from './${from}';`);
  const block = '// @imports:start\n' + (lines.length ? lines.join('\n') + '\n' : '') + '// @imports:end';
  let out = src[f];
  if (/\/\/ @imports:start/.test(out)) out = out.replace(/\/\/ @imports:start[\s\S]*?\/\/ @imports:end/, block);
  else out = out.replace('// @imports', block);
  if (out !== src[f]) fs.writeFileSync(path.join(dir, f), out);
}
console.log('imports updated for', files.length, 'modules');
