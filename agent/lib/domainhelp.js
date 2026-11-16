'use strict';
// Свой домен для сервера: какие записи DNS создать у регистратора и проверка, что они уже работают.
const dns = require('dns');
const net = require('net');

const HOST_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const clean = (h) => String(h || '').trim().toLowerCase().replace(/\.$/, '');
const validHost = (h) => HOST_RE.test(clean(h));

function resolver() {
  const r = new dns.promises.Resolver({ timeout: 4000, tries: 1 });
  if (process.env.HEARTH_DNS_SERVER) r.setServers([process.env.HEARTH_DNS_SERVER]);
  return r;
}

async function relayIp(host) {
  if (net.isIPv4(host)) return host;
  const a = await dns.promises.lookup(host, { family: 4 });
  return a.address;
}

/** Записи, которые нужно создать. ctx: { ip, vhostPort, domain, label } */
function records(host, ctx) {
  const out = [{ type: 'A', name: host, value: ctx.ip, note: 'имя ведёт на релей' }];
  if (+ctx.vhostPort && +ctx.vhostPort !== 25565) {
    // Minecraft Java сам идёт на порт 25565; для другого порта нужна SRV-запись. Цель — имя, которое релей точно знает.
    out.push({ type: 'SRV', name: `_minecraft._tcp.${host}`, value: `0 5 ${ctx.vhostPort} ${ctx.label}.${ctx.domain}`, note: 'Minecraft Java найдёт порт сам, друзья его не вводят' });
  }
  const parent = host.split('.').slice(1).join('.');
  if (parent.includes('.')) out.push({ type: 'A', name: `*.${parent}`, value: ctx.ip, optional: true, note: 'необязательно: сразу все имена на этом домене (play.…, survival.… и т. д.)' });
  return out;
}

async function check(hostRaw, ctx) {
  const host = clean(hostRaw);
  if (!validHost(host)) throw Object.assign(new Error('имя вида play.example.com'), { status: 400 });
  const r = resolver();
  const found = { a: [], srv: [] };
  const problems = [];
  const ip = ctx.ip;
  try {
    found.a = await r.resolve4(host);
  } catch {}
  try {
    found.srv = (await r.resolveSrv(`_minecraft._tcp.${host}`)).map((x) => ({ name: x.name.toLowerCase(), port: x.port }));
  } catch {}
  let viaA = found.a.includes(ip) && (!+ctx.vhostPort || +ctx.vhostPort === 25565);
  let viaSrv = false;
  for (const s of found.srv) {
    if (+s.port !== +ctx.vhostPort) continue;
    try {
      if ((await r.resolve4(s.name)).includes(ip)) viaSrv = true;
    } catch {}
  }
  if (!found.a.length && !found.srv.length) problems.push('Записей для этого имени пока нет: создайте их у регистратора и подождите (обычно до часа).');
  else if (found.a.length && !found.a.includes(ip)) problems.push(`Имя указывает на ${found.a.join(', ')}, а релей на ${ip}. Исправьте A-запись.`);
  else if (found.a.includes(ip) && +ctx.vhostPort && +ctx.vhostPort !== 25565 && !viaSrv) problems.push(`Общий порт релея ${ctx.vhostPort}, а не 25565: для Minecraft нужна SRV-запись (ниже). Другим играм и сайтам порт указывается в адресе.`);
  if (found.srv.length && !viaSrv && +ctx.vhostPort) problems.push(`SRV-запись есть, но не ведёт на релей (нужен порт ${ctx.vhostPort} и имя, которое указывает на ${ip}).`);
  return { ok: viaA || viaSrv, host, ip, via: viaA ? 'a' : viaSrv ? 'srv' : '', found, problems, records: records(host, ctx) };
}

module.exports = { check, records, validHost, clean, relayIp };
