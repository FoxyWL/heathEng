'use strict';
(function () {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const KW_JS = 'const|let|var|function|return|if|else|for|while|class|new|import|export|from|async|await|try|catch|throw|switch|case|break|continue|this|typeof|in|of';
  const rules = {
    json: [['s', /"(?:[^"\\\n]|\\.)*"(?=\s*:)/y, 'p'], ['s', /"(?:[^"\\\n]|\\.)*"/y, 's'], ['n', /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, 'n'], ['b', /\b(?:true|false|null)\b/y, 'b']],
    conf: [
      ['c', /(?:^|(?<=\n))[ \t]*[#;][^\n]*/y, 'c'],
      ['c', /\s#[^\n]*/y, 'c'],
      ['p', /(?:^|(?<=\n))[ \t]*[\w.\-\[\]"]+(?=[ \t]*[:=])/y, 'p'],
      ['s', /"(?:[^"\\\n]|\\.)*"|'[^'\n]*'/y, 's'],
      ['n', /-?\b\d+(?:\.\d+)?\b/y, 'n'],
      ['b', /\b(?:true|false|yes|no|on|off|null)\b/iy, 'b'],
    ],
    js: [
      ['c', /\/\/[^\n]*|\/\*[\s\S]*?\*\//y, 'c'],
      ['s', /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/y, 's'],
      ['n', /\b\d+(?:\.\d+)?\b/y, 'n'],
      ['k', new RegExp('\\b(?:' + KW_JS + ')\\b', 'y'), 'k'],
      ['b', /\b(?:true|false|null|undefined)\b/y, 'b'],
    ],
    sh: [
      ['c', /#[^\n]*|(?:^|(?<=\n))[ \t]*(?:rem|REM|::)[^\n]*/y, 'c'],
      ['s', /"(?:[^"\\\n]|\\.)*"|'[^'\n]*'/y, 's'],
      ['p', /\$\{?\w+\}?|%\w+%/y, 'p'],
      ['k', /\b(?:if|then|else|fi|for|do|done|while|case|esac|echo|exit|set|call|goto|java|cd)\b/y, 'k'],
      ['n', /\b\d+\b/y, 'n'],
    ],
    xml: [
      ['c', /<!--[\s\S]*?-->/y, 'c'],
      ['k', /<\/?[\w:-]+|\/?>/y, 'k'],
      ['p', /[\w:-]+(?=\=)/y, 'p'],
      ['s', /"[^"\n]*"|'[^'\n]*'/y, 's'],
    ],
    log: [
      ['b', /\b(?:ERROR|SEVERE|FATAL|Exception)\b/y, 'b'],
      ['n', /\bWARN(?:ING)?\b/y, 'n'],
      ['c', /\[\d{1,2}:\d{2}:\d{2}[^\]]*\]/y, 'c'],
      ['k', /\bINFO\b/y, 'k'],
    ],
  };
  const byExt = {
    json: 'json', mcmeta: 'json',
    yml: 'conf', yaml: 'conf', toml: 'conf', ini: 'conf', cfg: 'conf', conf: 'conf', properties: 'conf', env: 'conf', txt: 'conf', secret: 'conf',
    js: 'js', mjs: 'js', ts: 'js', java: 'js', c: 'js', cs: 'js', lua: 'js', css: 'js',
    sh: 'sh', bat: 'sh', cmd: 'sh', ps1: 'sh',
    xml: 'xml', html: 'xml', htm: 'xml',
    log: 'log',
  };

  function highlight(text, name) {
    const ext = (/\.([\w]+)$/.exec(name || '') || [])[1];
    const set = rules[byExt[(ext || '').toLowerCase()] || 'conf'];
    if (text.length > 200000) return esc(text);
    let out = '';
    let i = 0;
    let plainStart = 0;
    const flush = (to) => {
      if (to > plainStart) out += esc(text.slice(plainStart, to));
    };
    while (i < text.length) {
      let hit = null;
      for (const [, re, cls] of set) {
        re.lastIndex = i;
        const m = re.exec(text);
        if (m && m.index === i && m[0].length) {
          hit = { len: m[0].length, cls };
          break;
        }
      }
      if (hit) {
        flush(i);
        out += `<span class="tk-${hit.cls}">${esc(text.substr(i, hit.len))}</span>`;
        i += hit.len;
        plainStart = i;
      } else {
        i++;
      }
    }
    flush(text.length);
    return out;
  }
  window.Hl = { highlight, esc };
})();
