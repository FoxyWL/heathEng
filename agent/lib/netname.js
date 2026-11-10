'use strict';
// Имя вместо IP: IPv4-адрес кодируется в короткое произносимое слово вида kabeno-zuli и обратно.
// 32 бита адреса и 10 бит контрольной суммы (ловит опечатки) дают 6 слогов по 7 бит: согласная (16) + гласный звук (8).
// Это не запись DNS: имя вычисляется из адреса и им же однозначно расшифровывается, поэтому не нужен ни сервер имён, ни регистрация.
const SUFFIX = 'hearth';
const CONS = ['b', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'z'];
const VOW = ['a', 'e', 'i', 'o', 'u', 'ai', 'ou', 'ee'];
const SYL = 6;
const SPLIT = 3; // дефис после третьего слога: kabeno-zuli

function parseIp(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x >= 0 && x <= 255) ? b : null;
}

// FNV-1a по четырём байтам, 10 младших бит
function checksum(b) {
  let h = 0x811c9dc5;
  for (const x of b) h = Math.imul(h ^ x, 0x01000193) >>> 0;
  return (h ^ (h >>> 15)) & 1023;
}

function ipToName(ip) {
  const b = parseIp(ip);
  if (!b) throw new Error('нужен IPv4-адрес вида 192.168.1.10');
  // 42 бита помещаются в число без потери точности (меньше 2^53)
  let v = (b[0] * 16777216 + b[1] * 65536 + b[2] * 256 + b[3]) * 1024 + checksum(b);
  const out = [];
  for (let i = SYL - 1; i >= 0; i--) {
    const part = v % 128;
    v = Math.floor(v / 128);
    out[i] = CONS[part >> 3] + VOW[part & 7];
  }
  return out.slice(0, SPLIT).join('') + '-' + out.slice(SPLIT).join('');
}

function nameToIp(name) {
  let s = String(name || '').trim().toLowerCase();
  if (s.endsWith('.' + SUFFIX)) s = s.slice(0, -(SUFFIX.length + 1));
  s = s.replace(/-/g, '');
  const syl = [];
  let i = 0;
  while (i < s.length) {
    const c = CONS.indexOf(s[i]);
    if (c < 0) throw new Error('в имени есть недопустимая буква «' + s[i] + '»');
    let j = i + 1;
    while (j < s.length && 'aeiou'.includes(s[j])) j++;
    const v = VOW.indexOf(s.slice(i + 1, j));
    if (v < 0) throw new Error('в имени есть недопустимое сочетание гласных');
    syl.push((c << 3) | v);
    i = j;
  }
  if (syl.length !== SYL) throw new Error('в имени должно быть ' + SYL + ' слогов');
  let v = 0;
  for (const part of syl) v = v * 128 + part;
  const chk = v % 1024;
  v = Math.floor(v / 1024);
  const b = [Math.floor(v / 16777216) % 256, Math.floor(v / 65536) % 256, Math.floor(v / 256) % 256, v % 256];
  if (checksum(b) !== chk) throw new Error('имя набрано с ошибкой: контрольная сумма не сошлась');
  return b.join('.');
}

const fqdn = (ip) => ipToName(ip) + '.' + SUFFIX;

// Своё имя сервера: soskacraft или soskacraft.hearth[:порт] (всем), soskacraft.mc[:порт] (бета, администратор). Имя пишется в hosts, поэтому разбор строгий.
// Популярные «настоящие» зоны запрещены: запись в hosts перекрыла бы на этом ПК настоящий сайт.
const REAL_TLD = new Set(['com', 'net', 'org', 'ru', 'io', 'gg', 'tv', 'me', 'info', 'biz', 'xyz', 'dev', 'app', 'edu', 'gov', 'su', 'ua', 'by', 'kz', 'de', 'uk', 'us', 'co', 'cc', 'to', 'ly']);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// anyZone=false (обычный пользователь): только зона .hearth, голое слово получает её само. anyZone=true (бета, администратор): любая зона вроде .mc.
function parseCustom(input, { anyZone = false } = {}) {
  let v = String(input || '').trim().toLowerCase();
  if (!v) throw new Error('введите имя, например soskacraft.mc');
  if (/[/\\@\s]/.test(v)) throw new Error('имя без пробелов, схемы и путей: только буквы, цифры, дефис и точки');
  let port = null;
  const m = /^(.*):(\d{1,5})$/.exec(v);
  if (m) {
    v = m[1];
    port = +m[2];
    if (port < 1 || port > 65535) throw new Error('порт должен быть от 1 до 65535');
  } else if (v.includes(':')) throw new Error('после двоеточия нужен порт, например soskacraft.mc:25565');
  if (v.length > 100) throw new Error('имя слишком длинное (до 100 знаков)');
  if (!v.includes('.')) v += '.' + SUFFIX;
  const labels = v.split('.');
  if (!labels.every((l) => LABEL.test(l))) throw new Error('допустимы латинские буквы, цифры и дефис (не в начале и не в конце части имени)');
  if (labels.every((l) => /^\d+$/.test(l))) throw new Error('это похоже на IP-адрес, введите имя из букв');
  const tld = labels[labels.length - 1];
  if (tld === SUFFIX) {
    try {
      if (labels.length === 2) {
        nameToIp(v);
        throw new Error('это имя совпадает с автоматическим именем какого-то IP, придумайте другое');
      }
    } catch (e) {
      if (/совпадает/.test(e.message)) throw e;
    }
  } else if (!anyZone) throw new Error(`обычным пользователям доступна зона .${SUFFIX}, например soskacraft.${SUFFIX}. Свои зоны (.mc и другие) — бета для администратора`);
  if (tld === 'localhost' || v === 'localhost') throw new Error('имя localhost занято системой');
  if (REAL_TLD.has(tld)) throw new Error(`зона .${tld} принадлежит настоящим сайтам: имя перекрыло бы их на этом ПК. Возьмите, например, .mc, .game, .lan или .srv`);
  return { host: v, port };
}

module.exports = { ipToName, nameToIp, fqdn, parseIp, parseCustom, SUFFIX };
