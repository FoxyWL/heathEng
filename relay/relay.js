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
  discoveryPort: process.env.DISCOVERY_PORT === undefined ? 7001 : +process.env.DISCOVERY_PORT, // 0 — не отвечать на поиск
  open: process.env.RELAY_OPEN === '1', // без токена: только для домашней или закрытой сети
};

if (!cfg.token && !cfg.open) {
  cfg.token = crypto.randomBytes(12).toString('hex');
  console.log('[relay] RELAY_TOKEN не задан, сгенерирован: ' + cfg.token);
}
const tokenOk = (t) => cfg.open || t === cfg.token;

/** Что релей сообщает о себе тем, кто его ищет (клиентам Hearth). Токен не раскрывается. */
const about = () => ({ hearthRelay: 1, name: cfg.domain, host: cfg.publicHost, port: cfg.controlPort, tokenRequired: !cfg.open });

const clients = new Set();
const httpTunnels = new Map();
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
  send(sock, { t: 'ok', domain: cfg.domain });
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
