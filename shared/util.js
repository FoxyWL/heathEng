'use strict';

function readFirstLine(sock, cb) {
  let buf = Buffer.alloc(0);
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    const i = buf.indexOf(10);
    if (i < 0) {
      if (buf.length > 8192) sock.destroy();
      return;
    }
    sock.removeListener('data', onData);
    sock.pause();
    let obj;
    try {
      obj = JSON.parse(buf.slice(0, i).toString('utf8'));
    } catch {
      sock.destroy();
      return;
    }
    cb(obj, buf.slice(i + 1));
  };
  sock.on('data', onData);
}

function lineParser(onMsg) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(10)) >= 0) {
      const line = buf.slice(0, i).toString('utf8').trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        onMsg(JSON.parse(line));
      } catch {}
    }
  };
}

function send(sock, obj) {
  if (sock && !sock.destroyed && sock.writable) sock.write(JSON.stringify(obj) + '\n');
}

function bridge(a, b) {
  a.setNoDelay && a.setNoDelay(true);
  b.setNoDelay && b.setNoDelay(true);
  a.pipe(b);
  b.pipe(a);
  const end = () => {
    a.destroy();
    b.destroy();
  };
  a.on('error', end);
  b.on('error', end);
  a.on('close', end);
  b.on('close', end);
}

function frameParser(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 6) {
      const sid = buf.readUInt32BE(0);
      const len = buf.readUInt16BE(4);
      if (buf.length < 6 + len) break;
      onFrame(sid, buf.slice(6, 6 + len));
      buf = buf.slice(6 + len);
    }
  };
}

function makeFrame(sid, payload) {
  const h = Buffer.alloc(6);
  h.writeUInt32BE(sid, 0);
  h.writeUInt16BE(payload.length, 4);
  return Buffer.concat([h, payload]);
}

module.exports = { readFirstLine, lineParser, send, bridge, frameParser, makeFrame };
