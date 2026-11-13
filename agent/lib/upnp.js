'use strict';
// Публичный адрес без ручного проброса портов: UPnP IGD. Hearth находит роутер, узнаёт внешний IP и открывает порты сервера одной кнопкой.
// Если роутер не поддерживает UPnP или внешний адрес «серый» (CGNAT), честно советуем туннель.
const dgram = require('dgram');
const os = require('os');
const { kindOf } = require('./netaccess');

const ST = 'urn:schemas-upnp-org:device:InternetGatewayDevice:1';
const SERVICES = ['urn:schemas-upnp-org:service:WANIPConnection:2', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1'];

const tag = (xml, name) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? m[1].trim() : '';
};

function ssdp(ms = 2500) {
  const target = process.env.HEARTH_SSDP_TARGET; // тесты: «роутер» на локальном адресе
  const dests = target ? [[target.split(':')[0], +target.split(':')[1]]] : [['239.255.255.250', 1900]];
  const ifaces = target ? [null] : Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  const msg = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${ST}\r\n\r\n`);
  return new Promise((resolve) => {
    const found = new Set();
    const socks = [];
    for (const ip of ifaces.length ? ifaces : [null]) {
      const s = dgram.createSocket('udp4');
      s.on('error', () => {});
      s.on('message', (m) => {
        const loc = /^location:\s*(\S+)/im.exec(m.toString());
        if (loc) found.add(loc[1]);
      });
      s.bind(0, ip || undefined, () => {
        try {
          if (ip) s.setMulticastInterface(ip);
        } catch {}
        for (const [h, p] of dests) s.send(msg, p, h, () => {});
      });
      socks.push(s);
    }
    setTimeout(() => {
      for (const s of socks) {
        try {
          s.close();
        } catch {}
      }
      resolve([...found]);
    }, ms);
  });
}

async function describe(location) {
  const r = await fetch(location, { signal: AbortSignal.timeout(4000) });
  const xml = await r.text();
  for (const type of SERVICES) {
    const i = xml.indexOf(`<serviceType>${type}</serviceType>`);
    if (i < 0) continue;
    const block = xml.slice(i, xml.indexOf('</service>', i));
    const ctl = tag(block, 'controlURL');
    if (!ctl) continue;
    return { type, control: new URL(ctl, location).href, name: tag(xml, 'friendlyName') || tag(xml, 'modelName') || 'Роутер', location };
  }
  return null;
}

async function soap(gw, action, args = {}) {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${gw.type}">${Object.entries(args).map(([k, v]) => `<${k}>${String(v).replace(/[<&>]/g, '')}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const r = await fetch(gw.control, { method: 'POST', headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${gw.type}#${action}"` }, body, signal: AbortSignal.timeout(5000) });
  const text = await r.text();
  if (!r.ok) {
    const code = tag(text, 'errorCode');
    const err = new Error(`роутер отклонил запрос ${action}${code ? ` (код ${code}: ${tag(text, 'errorDescription') || 'ошибка UPnP'})` : ` (HTTP ${r.status})`}`);
    err.code = +code || 0;
    throw err;
  }
  return text;
}

/** Находит роутер с UPnP. null, если не найден или UPnP выключен. */
async function find() {
  const loc = process.env.HEARTH_UPNP_LOCATION ? [process.env.HEARTH_UPNP_LOCATION] : await ssdp();
  for (const l of loc) {
    try {
      const gw = await describe(l);
      if (gw) return gw;
    } catch {}
  }
  return null;
}

async function externalIp(gw) {
  return tag(await soap(gw, 'GetExternalIPAddress'), 'NewExternalIPAddress');
}

/** Открывает порт. Сначала с арендой на час (чистится сама), если роутер требует бессрочную, то бессрочно. */
async function addMapping(gw, { port, proto, internalIp, desc }) {
  const args = (lease) => ({ NewRemoteHost: '', NewExternalPort: port, NewProtocol: proto.toUpperCase(), NewInternalPort: port, NewInternalClient: internalIp, NewEnabled: 1, NewPortMappingDescription: desc, NewLeaseDuration: lease });
  try {
    await soap(gw, 'AddPortMapping', args(3600));
    return { lease: 3600 };
  } catch (e) {
    if (e.code !== 725 && e.code !== 402) throw e;
    await soap(gw, 'AddPortMapping', args(0));
    return { lease: 0 };
  }
}

async function removeMapping(gw, { port, proto }) {
  await soap(gw, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: proto.toUpperCase() });
}

/** Внешний IP без UPnP: через сайт-определитель. */
async function publicIpViaWeb() {
  const url = process.env.HEARTH_IPCHECK_URL || 'https://api.ipify.org';
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const ip = (await r.text()).trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : '';
  } catch {
    return '';
  }
}

/**
 * Итог проверки: что можно сделать для доступа из интернета.
 * upnp: роутер найден, адрес белый, порты открываются кнопкой. manual: белый адрес, но роутера с UPnP нет (проброс портов вручную).
 * cgnat: адрес серый (провайдер), из интернета не достучаться, нужен туннель. unknown: нет связи с интернетом.
 */
async function check() {
  const gw = await find();
  let routerIp = '';
  let routerError = '';
  if (gw) {
    try {
      routerIp = await externalIp(gw);
    } catch (e) {
      routerError = e.message;
    }
  }
  const webIp = await publicIpViaWeb();
  const ip = webIp || routerIp;
  const wanKind = routerIp ? kindOf(routerIp) : '';
  let verdict = 'unknown';
  if (gw && routerIp && wanKind !== 'public') verdict = 'cgnat'; // у роутера самого «серый» адрес
  else if (ip && kindOf(ip) !== 'public') verdict = 'cgnat';
  else if (webIp && routerIp && webIp !== routerIp) verdict = 'cgnat'; // за роутером ещё один NAT провайдера
  else if (gw && routerIp) verdict = 'upnp';
  else if (ip) verdict = 'manual';
  return { gateway: gw ? { name: gw.name, externalIp: routerIp, error: routerError } : null, ip, verdict };
}

module.exports = { find, externalIp, addMapping, removeMapping, check, ssdp, describe };
