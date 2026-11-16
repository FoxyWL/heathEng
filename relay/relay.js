'use strict';
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const fs = require('fs');
const crypto = require('crypto');
const { readFirstLine, lineParser, send, bridge, frameParser, makeFrame } = require('../shared/util');

const cfg = {
  controlPort: +(process.env.CONTROL_PORT || 7000),
  httpPort: +(process.env.HTTP_PORT || 8080),
  httpsPort: +(process.env.HTTPS_PORT || 0),
  cert: process.env.TLS_CERT || '',
  key: process.env.TLS_KEY || '',
  token: process.env.RELAY_TOKEN || '',
  domain: (process.env.RELAY_DOMAIN || 'localhost').toLowerCase(),
  publicHost: process.env.PUBLIC_HOST || process.env.RELAY_DOMAIN || 'localhost',
  portMin: +(process.env.PORT_MIN || 20000),
  portMax: +(process.env.PORT_MAX || 29999),
  maxTunnels: +(process.env.MAX_TUNNELS || 16),
  bind: process.env.BIND || '0.0.0.0',
  vhostPort: +(process.env.VHOST_PORT || 0), // общий порт, где имя берётся из первых байт (Minecraft Java, TLS, HTTP); 0 — выключен
  discoveryPort: process.env.DISCOVERY_PORT === undefined ? 7001 : +process.env.DISCOVERY_PORT, // 0 — не отвечать на поиск
  open: process.env.RELAY_OPEN === '1', // без токена: только для домашней или закрытой сети
};

if (!cfg.token && !cfg.open) {
  cfg.token = crypto.randomBytes(12).toString('hex');
  console.log('[relay] RELAY_TOKEN не задан, сгенерирован: ' + cfg.token);
}
const tokenOk = (t) => cfg.open || t === cfg.token;

/** Что релей сообщает о себе тем, кто его ищет (клиентам Hearth). Токен не раскрывается. */
const about = () => ({ hearthRelay: 1, name: cfg.domain, host: cfg.publicHost, port: cfg.controlPort, tokenRequired: !cfg.open, vhostPort: cfg.vhostPort || 0, domain: cfg.domain });

const clients = new Set();
const httpTunnels = new Map();
const vhostTunnels = new Map();
const vhostHosts = new Map(); // полные имена, которые хозяин привёл на релей сам (play.example.com)
const pending = new Map();
let tidSeq = 1;

function listen(server, port, kind) {
  return new Promise((res, rej) => {
    server.once('error', rej);
    if (kind === 'udp') server.bind(port, cfg.bind, () => res());
    else server.listen(port, cfg.bind, () => res());
  });
}

async function allocPort(kind, wanted) {
  const make = () => (kind === 'udp' ? dgram.createSocket('udp4') : net.createServer());
  const tryPort = async (p) => {
    const s = make();
    try {
      await listen(s, p, kind);
      return s;
    } catch {
      try {
        kind === 'udp' ? s.close() : s.close();
      } catch {}
      return null;
    }
  };
  if (wanted && wanted >= cfg.portMin && wanted <= cfg.portMax) {
    const s = await tryPort(wanted);
    if (s) return { server: s, port: wanted };
  }
  for (let i = 0; i < 80; i++) {
    const p = cfg.portMin + Math.floor(Math.random() * (cfg.portMax - cfg.portMin + 1));
    const s = await tryPort(p);
    if (s) return { server: s, port: p };
  }
  throw new Error('нет свободных портов');
}

function takePending(tid) {
  const p = pending.get(tid);
  if (!p) return null;
  pending.delete(tid);
  clearTimeout(p.timer);
  return p;
}

function routeToClient(client, tunnel, pub, head) {
  const tid = tidSeq++;
  const timer = setTimeout(() => {
    pending.delete(tid);
    pub.destroy();
  }, 10000);
  pending.set(tid, { pub, head, timer });
  pub.on('close', () => {
    const p = pending.get(tid);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(tid);
    }
  });
  send(client.sock, { t: 'conn', tid, id: tunnel.id, from: pub.remoteAddress || '' });
}

function httpPage(status, text) {
  const body = `<!doctype html><meta charset=utf-8><title>${status}</title><body style="font:16px system-ui;padding:3rem;color:#223">${text}`;
  return `HTTP/1.1 ${status}\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function handleHttpSocket(sock) {
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => sock.destroy(), 10000);
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) {
      if (buf.length > 16384) sock.destroy();
      return;
    }
    sock.removeListener('data', onData);
    clearTimeout(timer);
    sock.pause();
    const head = buf.toString('latin1', 0, end);
    if (/^GET \/\.well-known\/hearth-relay[ ?]/.test(head)) {
      const body = JSON.stringify(about());
      sock.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\naccess-control-allow-origin: *\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
      return;
    }
    const m = /\r\nhost:\s*([^\r\n:]+)/i.exec(head);
    const host = m ? m[1].trim().toLowerCase() : '';
    let sub = '';
    if (host.endsWith('.' + cfg.domain)) sub = host.slice(0, -cfg.domain.length - 1);
    const t = httpTunnels.get(sub);
    if (!t) {
      sock.end(httpPage('404 Not Found', 'Туннель не найден или клиент отключён.'));
      return;
    }
    routeToClient(t.client, t, sock, buf);
  };
  sock.on('data', onData);
  sock.on('error', () => {});
  sock.on('close', () => clearTimeout(timer));
}


// ---- Общий порт с маршрутизацией по имени -------------------------------------------------------
// Имя, по которому человек подключился, видно в первых байтах только у некоторых протоколов:
// рукопожатие Minecraft Java, TLS (SNI) и HTTP (Host). У UDP-игр (Bedrock и др.) и большинства
// остальных TCP-игр имени в пакете нет, поэтому им нужен отдельный порт.
function readVarInt(b, o) {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    if (o + i >= b.length) return null;
    const c = b[o + i];
    v |= (c & 0x7f) << (7 * i);
    if (!(c & 0x80)) return { v, len: i + 1 };
  }
  return { v: -1, len: 5 };
}

function sniffMinecraft(b) {
  const len = readVarInt(b, 0);
  if (!len) return { need: true };
  if (len.v < 3 || len.v > 300) return null;
  if (b.length < len.len + len.v) return { need: true };
  let o = len.len;
  if (b[o] !== 0x00) return null;
  o++;
  const proto = readVarInt(b, o);
  if (!proto) return null;
  o += proto.len;
  const sl = readVarInt(b, o);
  if (!sl || sl.v < 1 || sl.v > 255) return null;
  o += sl.len;
  if (o + sl.v + 3 > len.len + len.v + 1) return null;
  const host = b.toString('utf8', o, o + sl.v).split('\0')[0]; // Forge дописывает после \0 свою метку
  o += sl.v + 2;
  const next = readVarInt(b, o);
  return { kind: 'minecraft', host, next: next ? next.v : 0, proto: proto.v, used: len.len + len.v };
}

function sniffTls(b) {
  if (b.length < 5) return { need: true };
  const recLen = b.readUInt16BE(3);
  if (b.length < 5 + Math.min(recLen, 16384)) return { need: true };
  try {
    let o = 5;
    if (b[o] !== 0x01) return null;
    o += 4 + 2 + 32; // тип и длина рукопожатия, версия, random
    o += 1 + b[o]; // session id
    o += 2 + b.readUInt16BE(o); // шифры
    o += 1 + b[o]; // сжатие
    const end = o + 2 + b.readUInt16BE(o);
    o += 2;
    while (o + 4 <= end) {
      const type = b.readUInt16BE(o);
      const l = b.readUInt16BE(o + 2);
      if (type === 0) {
        // server_name_list: длина списка, тип (0), длина имени, имя
        const nl = b.readUInt16BE(o + 7);
        return { kind: 'tls', host: b.toString('latin1', o + 9, o + 9 + nl) };
      }
      o += 4 + l;
    }
  } catch {}
  return { kind: 'tls', host: '' };
}

function sniffHttp(b) {
  const end = b.indexOf('\r\n\r\n');
  if (end < 0) return b.length > 16384 ? null : { need: true };
  const m = /\r\nhost:\s*([^\r\n:]+)/i.exec(b.toString('latin1', 0, end));
  return { kind: 'http', host: m ? m[1].trim() : '' };
}

/** null — не наш протокол; {need:true} — ждём ещё байты; иначе {kind, host, ...} */
function sniffHost(b) {
  if (!b.length) return { need: true };
  if (b[0] === 0x16) return sniffTls(b);
  if (b[0] >= 0x41 && b[0] <= 0x5a) return sniffHttp(b); // GET, POST, HEAD…
  return sniffMinecraft(b);
}

const normHost = (h) => String(h || '').toLowerCase().replace(/\.$/, '');
const validHost = (h) => /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(h);

function subOf(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  return host.endsWith('.' + cfg.domain) ? host.slice(0, -cfg.domain.length - 1) : '';
}

const mcStr = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([varInt(b.length), b]);
};
function varInt(n) {
  const out = [];
  do {
    let c = n & 0x7f;
    n >>>= 7;
    if (n) c |= 0x80;
    out.push(c);
  } while (n);
  return Buffer.from(out);
}
const mcPacket = (id, body) => {
  const inner = Buffer.concat([varInt(id), body]);
  return Buffer.concat([varInt(inner.length), inner]);
};

/** Ответ тому, кто пришёл по имени без туннеля, на его языке: Minecraft получит понятное сообщение в списке серверов и при входе */
function replyUnknown(sock, info, host, buf) {
  const text = `Сервер «${host || '?'}» не найден или выключен. Проверьте адрес у хозяина сервера.`;
  if (info.kind === 'minecraft') {
    if (info.next === 1) {
      const status = { version: { name: 'Hearth', protocol: info.proto }, players: { max: 0, online: 0 }, description: { text } };
      sock.write(mcPacket(0, mcStr(JSON.stringify(status))));
      const echo = (d) => {
        const i = d.indexOf(Buffer.from([0x09, 0x01])); // ping: длина 9, id 1, 8 байт
        if (i < 0 || d.length < i + 10) return false;
        sock.end(d.subarray(i, i + 10));
        return true;
      };
      if (!echo(buf.subarray(info.used))) sock.on('data', echo);
      setTimeout(() => sock.destroy(), 5000).unref();
      sock.resume();
      return;
    }
    sock.end(mcPacket(0, mcStr(JSON.stringify({ text }))));
    return;
  }
  if (info.kind === 'http') return sock.end(httpPage('404 Not Found', text));
  sock.destroy(); // TLS без сервера: честный разрыв, подменять сертификат нельзя
}

function handleVhostSocket(sock) {
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => sock.destroy(), 10000);
  sock.on('error', () => {});
  sock.on('close', () => clearTimeout(timer));
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    const info = sniffHost(buf);
    if (info && info.need) {
      if (buf.length > 16384) sock.destroy();
      return;
    }
    sock.removeListener('data', onData);
    clearTimeout(timer);
    sock.pause();
    if (!info) return sock.destroy();
    if (info.kind === 'http' && /^GET \/\.well-known\/hearth-relay[ ?]/.test(buf.toString('latin1', 0, 64))) {
      const body = JSON.stringify(about());
      return sock.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\naccess-control-allow-origin: *\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
    }
    const t = vhostHosts.get(normHost(info.host)) || vhostTunnels.get(subOf(info.host));
    if (!t) return replyUnknown(sock, info, info.host, buf);
    routeToClient(t.client, t, sock, buf);
  };
  sock.on('data', onData);
}

async function openTunnel(client, msg) {
  if (client.tunnels.size >= cfg.maxTunnels) throw new Error('лимит туннелей');
  if (client.tunnels.has(msg.id)) closeTunnel(client, msg.id);
  const proto = msg.proto;
  const tunnel = { id: msg.id, proto, client };
  if (proto === 'http' || proto === 'https') {
    let sub = String(msg.subdomain || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    if (!sub) sub = crypto.randomBytes(4).toString('hex');
    const ex = httpTunnels.get(sub);
    if (ex && ex.client !== client) {
      if (msg.subdomain) throw new Error('поддомен занят');
      sub = crypto.randomBytes(4).toString('hex');
    }
    tunnel.sub = sub;
    httpTunnels.set(sub, tunnel);
    const host = `${sub}.${cfg.domain}`;
    const secure = !!(cfg.httpsPort && cfg.cert);
    const port = secure ? cfg.httpsPort : cfg.httpPort;
    tunnel.info = {
      host,
      port,
      url: `${secure ? 'https' : 'http'}://${host}${(secure && port === 443) || (!secure && port === 80) ? '' : ':' + port}`,
    };
  } else if (proto === 'vhost') {
    if (!cfg.vhostPort) throw new Error('на этом релее нет общего порта с именами');
    let sub = String(msg.subdomain || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    if (!sub) sub = crypto.randomBytes(4).toString('hex');
    const ex = vhostTunnels.get(sub);
    if (ex && ex.client !== client) {
      if (msg.subdomain && !msg.hint) throw new Error('имя занято');
      sub = crypto.randomBytes(4).toString('hex');
    }
    const hosts = [];
    for (const raw of Array.isArray(msg.hosts) ? msg.hosts.slice(0, 4) : []) {
      const h = normHost(raw);
      if (!validHost(h)) throw new Error('неверное имя: ' + String(raw).slice(0, 80));
      const other = vhostHosts.get(h);
      if (other && other.client !== client) throw new Error('имя занято: ' + h);
      hosts.push(h);
    }
    tunnel.sub = sub;
    tunnel.vhost = true;
    vhostTunnels.set(sub, tunnel);
    tunnel.hosts = hosts;
    for (const h of hosts) vhostHosts.set(h, tunnel);
    const host = `${sub}.${cfg.domain}`;
    tunnel.info = { host, port: cfg.vhostPort, url: `${host}:${cfg.vhostPort}` };
  } else if (proto === 'tcp') {
    const { server, port } = await allocPort('tcp', msg.remotePort);
    tunnel.server = server;
    server.on('connection', (pub) => {
      pub.on('error', () => {});
      pub.pause();
      routeToClient(client, tunnel, pub, Buffer.alloc(0));
    });
    tunnel.info = { host: cfg.publicHost, port, url: `${cfg.publicHost}:${port}` };
  } else if (proto === 'udp') {
    const { server, port } = await allocPort('udp', msg.remotePort);
    tunnel.server = server;
    tunnel.sessions = new Map();
    tunnel.bySid = new Map();
    tunnel.seq = 1;
    server.on('message', (data, rinfo) => {
      if (!tunnel.dataSock || tunnel.dataSock.destroyed) return;
      const key = rinfo.address + ':' + rinfo.port;
      let s = tunnel.sessions.get(key);
      if (!s) {
        s = { sid: tunnel.seq++, rinfo, last: Date.now() };
        tunnel.sessions.set(key, s);
        tunnel.bySid.set(s.sid, s);
      }
      s.last = Date.now();
      tunnel.dataSock.write(makeFrame(s.sid, data));
    });
    tunnel.gc = setInterval(() => {
      const now = Date.now();
      for (const [k, s] of tunnel.sessions) {
        if (now - s.last > 60000) {
          tunnel.sessions.delete(k);
          tunnel.bySid.delete(s.sid);
        }
      }
    }, 15000);
    tunnel.info = { host: cfg.publicHost, port, url: `${cfg.publicHost}:${port}` };
    send(client.sock, { t: 'udp-ready', id: tunnel.id });
  } else {
    throw new Error('неизвестный протокол');
  }
  client.tunnels.set(tunnel.id, tunnel);
  return tunnel;
}

function closeTunnel(client, id) {
  const t = client.tunnels.get(id);
  if (!t) return;
  client.tunnels.delete(id);
  if (t.sub && httpTunnels.get(t.sub) === t) httpTunnels.delete(t.sub);
  if (t.sub && vhostTunnels.get(t.sub) === t) vhostTunnels.delete(t.sub);
  for (const h of t.hosts || []) if (vhostHosts.get(h) === t) vhostHosts.delete(h);
  if (t.gc) clearInterval(t.gc);
  if (t.dataSock) t.dataSock.destroy();
  if (t.server) {
    try {
      t.server.close();
    } catch {}
  }
}

function handleControl(sock, hello, rest) {
  if (!tokenOk(hello.token)) {
    send(sock, { t: 'err', error: 'неверный токен' });
    sock.end();
    return;
  }
  const client = { sock, tunnels: new Map(), name: String(hello.name || 'client').slice(0, 40) };
  clients.add(client);
  send(sock, { t: 'ok', domain: cfg.domain, vhostPort: cfg.vhostPort || 0 });
  console.log(`[relay] клиент подключён: ${client.name}`);
  const feed = lineParser(async (msg) => {
    if (msg.t === 'ping') return send(sock, { t: 'pong' });
    if (msg.t === 'open') {
      try {
        const t = await openTunnel(client, msg);
        send(sock, { t: 'opened', id: t.id, proto: t.proto, ...t.info });
        console.log(`[relay] ${client.name}: ${t.proto} ${t.info.url}`);
      } catch (e) {
        send(sock, { t: 'open-err', id: msg.id, error: e.message });
      }
    } else if (msg.t === 'close') {
      closeTunnel(client, msg.id);
      send(sock, { t: 'closed', id: msg.id });
    }
  });
  sock.on('data', feed);
  const cleanup = () => {
    if (!clients.has(client)) return;
    clients.delete(client);
    for (const id of [...client.tunnels.keys()]) closeTunnel(client, id);
    console.log(`[relay] клиент отключён: ${client.name}`);
  };
  sock.on('close', cleanup);
  sock.on('error', () => {});
  sock.setKeepAlive(true, 15000);
  if (rest.length) feed(rest);
  sock.resume();
}

function handleData(sock, msg, rest) {
  if (!tokenOk(msg.token)) return sock.destroy();
  if (msg.t === 'data') {
    const p = takePending(msg.tid);
    if (!p) return sock.destroy();
    if (p.head.length) sock.write(p.head);
    if (rest.length) p.pub.write(rest);
    bridge(sock, p.pub);
    sock.resume();
    p.pub.resume();
  } else if (msg.t === 'udp') {
    let tunnel = null;
    for (const c of clients) {
      const t = c.tunnels.get(msg.id);
      if (t && t.proto === 'udp') tunnel = t;
    }
    if (!tunnel) return sock.destroy();
    if (tunnel.dataSock) tunnel.dataSock.destroy();
    tunnel.dataSock = sock;
    const parse = frameParser((sid, payload) => {
      const s = tunnel.bySid.get(sid);
      if (s) {
        s.last = Date.now();
        tunnel.server.send(payload, s.rinfo.port, s.rinfo.address);
      }
    });
    sock.on('data', parse);
    sock.on('error', () => {});
    if (rest.length) parse(rest);
    sock.resume();
  } else {
    sock.destroy();
  }
}

const control = net.createServer((sock) => {
  sock.on('error', () => {});
  readFirstLine(sock, (msg, rest) => {
    if (msg.t === 'hello') handleControl(sock, msg, rest);
    else handleData(sock, msg, rest);
  });
});

async function main() {
  await listen(control, cfg.controlPort);
  console.log(`[relay] control :${cfg.controlPort}`);
  if (cfg.discoveryPort) {
    const disc = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    disc.on('error', (e) => console.log('[relay] поиск клиентами выключен: ' + e.message));
    disc.on('message', (m, r) => {
      if (m.toString().trim() === 'HEARTH-RELAY?') disc.send(JSON.stringify(about()), r.port, r.address);
    });
    disc.bind(cfg.discoveryPort, cfg.bind, () => console.log(`[relay] отвечает на поиск :${cfg.discoveryPort} (UDP)`));
  }
  const q = new URLSearchParams(cfg.open ? {} : { token: cfg.token });
  console.log(`[relay] ссылка для клиентов: hearth-relay://${cfg.publicHost}:${cfg.controlPort}${q.toString() ? '?' + q : ''}`);
  if (cfg.open) console.log('[relay] РЕЖИМ БЕЗ ТОКЕНА: подключиться может любой, кто достанет до этого порта. Используйте только в закрытой сети.');
  const httpSrv = net.createServer(handleHttpSocket);
  await listen(httpSrv, cfg.httpPort);
  console.log(`[relay] http :${cfg.httpPort}  домен *.${cfg.domain}`);
  if (cfg.vhostPort) {
    const vh = net.createServer(handleVhostSocket);
    await listen(vh, cfg.vhostPort);
    console.log(`[relay] имена на общем порту :${cfg.vhostPort}  *.${cfg.domain} (Minecraft Java, TLS, HTTP)`);
  }
  if (cfg.httpsPort && cfg.cert && cfg.key) {
    const httpsSrv = tls.createServer(
      { cert: fs.readFileSync(cfg.cert), key: fs.readFileSync(cfg.key) },
      handleHttpSocket,
    );
    httpsSrv.on('tlsClientError', () => {});
    await listen(httpsSrv, cfg.httpsPort);
    console.log(`[relay] https :${cfg.httpsPort} (TLS на стороне релея)`);
  }
}

// Запущен из Hearth («Стать релеем»): если Hearth закрыт или упал, релей уходит вместе с ним и не занимает порты
if (process.send) process.on('disconnect', () => process.exit(0));

main().catch((e) => {
  console.error('[relay] ошибка запуска:', e.message);
  process.exit(1);
});
